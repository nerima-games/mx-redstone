import fc from 'fast-check'
import { describe, expect, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import {
  BlockPositionSchema,
  DeltaTimeSecs,
  DimensionIdSchema,
  type BlockPosition,
  type FrameServices,
  type StageRegistration,
} from '@nerima-games/mc-kernel'
import {
  RedstoneWorldRuntime,
  RedstoneWorldRuntimeLayer,
  type RedstoneComponentSnapshot,
  type RedstoneEventBatch,
  type RedstoneWorldRuntimeService,
  type RedstoneWorldSnapshotDuplicatePositionError,
  type RedstoneWorldRuntimeStateError,
  type RedstoneWorldSnapshot,
} from '../src/application/world-runtime'
import { makeRuntimeRedstoneStages } from '../src/stages/registration'
import { REDSTONE_STAGE_IDS } from '../src/stages/stage-ids'
// eslint-disable-next-line sort-imports
import { FrameServicesLayer } from './frame-services'

type DimensionId = Schema.Schema.Type<typeof DimensionIdSchema>
type RuntimeError =
  | RedstoneWorldRuntimeStateError
  | RedstoneWorldSnapshotDuplicatePositionError
  | Schema.SchemaError

const dimensionId = (value: string): DimensionId =>
  Schema.decodeUnknownSync(DimensionIdSchema)(value)

const position = (x: number, y = 0, z = 0): BlockPosition =>
  Schema.decodeUnknownSync(BlockPositionSchema)({ x, y, z })

const component = (
  kind: RedstoneComponentSnapshot['kind'],
  x: number,
  y = 0,
  z = 0,
  fields: Omit<RedstoneComponentSnapshot, 'kind' | 'position'> = {},
): RedstoneComponentSnapshot => ({
  ...fields,
  kind,
  position: position(x, y, z),
})

const snapshot = (
  dimension: string,
  components: ReadonlyArray<RedstoneComponentSnapshot>,
): RedstoneWorldSnapshot => ({ dimension: dimensionId(dimension), components })

const stageById = (
  stages: ReadonlyArray<StageRegistration>,
  id: string,
): StageRegistration => {
  const stage = stages.find((candidate) => candidate.id === id)
  if (stage === undefined) throw new Error(`missing stage ${id}`)
  return stage
}

const runFrame = (
  stages: ReadonlyArray<StageRegistration>,
): Effect.Effect<void, RuntimeError, FrameServices> =>
  Effect.gen(function* () {
    yield* stageById(stages, REDSTONE_STAGE_IDS.power).run(DeltaTimeSecs(0.1))
    yield* stageById(stages, REDSTONE_STAGE_IDS.effects).run(DeltaTimeSecs(0.1))
  })

const runtimeProgram = <A>(
  use: (
    runtime: RedstoneWorldRuntimeService,
    stages: ReadonlyArray<StageRegistration>,
  ) => Effect.Effect<A, RuntimeError, FrameServices>,
): Effect.Effect<A, RuntimeError> =>
  Effect.gen(function* () {
    const runtime = yield* RedstoneWorldRuntime
    const stages = yield* makeRuntimeRedstoneStages
    return yield* use(runtime, stages)
  }).pipe(
    Effect.provide(RedstoneWorldRuntimeLayer),
    Effect.provide(FrameServicesLayer),
  )

const drainEvents = (
  runtime: RedstoneWorldRuntimeService,
): Effect.Effect<RedstoneEventBatch, RuntimeError> =>
  Effect.gen(function* () {
    return {
      hopper: yield* runtime.drainHopperTransferEvents,
      lamp: yield* runtime.drainLampTransitions,
      piston: yield* runtime.drainPistonTransitions,
      powered: yield* runtime.drainPoweredComponentTransitions,
      trigger: yield* runtime.drainTriggerEvents,
    }
  })

const runSnapshotBatch = (
  snapshots: ReadonlyArray<RedstoneWorldSnapshot>,
): Effect.Effect<RedstoneEventBatch, RuntimeError> =>
  runtimeProgram((runtime, stages) => Effect.gen(function* () {
    for (const world of snapshots) yield* runtime.syncSnapshot(world)
    yield* runFrame(stages)
    return yield* drainEvents(runtime)
  }))

const EVENT_COMPONENTS: ReadonlyArray<RedstoneComponentSnapshot> = [
  component('piston', 2, 0, 0, { pistonFacing: 'north', pistonKind: 'normal', pistonState: 'retracted' }),
  component('dispenser', 3, 0, -1),
  component('lever', 3, 0, 0, { active: true }),
  component('hopper', 3, 0, 1),
  component('powered-rail', 3, 1, 0),
  component('lamp', 4, 0, 0),
  component('lamp', 10, 0, 0),
  component('dropper', 11, 0, -1),
  component('lever', 11, 0, 0, { active: true }),
  component('hopper', 11, 0, 1),
  component('door', 11, 1, 0),
  component('piston', 12, 0, 0, { pistonFacing: 'north', pistonKind: 'normal', pistonState: 'retracted' }),
]

const EXPECTED_EVENTS = {
  hopper: [
    { dimension: 'overworld', position: { x: 3, y: 0, z: 1 }, elapsedRedstoneTicks: 1, powered: true },
    { dimension: 'overworld', position: { x: 11, y: 0, z: 1 }, elapsedRedstoneTicks: 1, powered: true },
  ],
  lamp: [
    { dimension: 'overworld', position: { x: 4, y: 0, z: 0 }, lit: true },
    { dimension: 'overworld', position: { x: 10, y: 0, z: 0 }, lit: true },
  ],
  piston: [
    { dimension: 'overworld', piston: { x: 2, y: 0, z: 0 }, facing: 'north', kind: 'normal', state: 'retracted', powered: true },
    { dimension: 'overworld', piston: { x: 12, y: 0, z: 0 }, facing: 'north', kind: 'normal', state: 'retracted', powered: true },
  ],
  powered: [
    { dimension: 'overworld', position: { x: 3, y: 1, z: 0 }, kind: 'powered-rail', powered: true },
    { dimension: 'overworld', position: { x: 11, y: 1, z: 0 }, kind: 'door', powered: true },
  ],
  trigger: [
    { dimension: 'overworld', position: { x: 3, y: 0, z: -1 }, kind: 'dispenser' },
    { dimension: 'overworld', position: { x: 11, y: 0, z: -1 }, kind: 'dropper' },
  ],
}

describe('redstone event ordering', () => {
  it.effect('drains every event type in numeric position order for component permutations', () =>
    Effect.gen(function* () {
      // This catches component insertion order changing lamp, piston, trigger, hopper, or powered events.
      const shuffled = fc.sample(
        fc.shuffledSubarray([...EVENT_COMPONENTS], {
          minLength: EVENT_COMPONENTS.length,
          maxLength: EVENT_COMPONENTS.length,
        }),
        { numRuns: 6, seed: 0x4f524445 },
      )
      const permutations = [EVENT_COMPONENTS, [...EVENT_COMPONENTS].reverse(), ...shuffled]
      const observations: Array<RedstoneEventBatch> = []

      for (const components of permutations) {
        observations.push(yield* runSnapshotBatch([snapshot('overworld', components)]))
      }

      expect(observations).toHaveLength(permutations.length)
      for (const events of observations.slice(1)) expect(events).toStrictEqual(observations[0])
      expect(observations[0]).toStrictEqual(EXPECTED_EVENTS)
    }),
  )

  it.effect('orders same-tick events by dimension ID regardless of sync order', () =>
    Effect.gen(function* () {
      // This catches the dimension Map insertion order leaking into same-tick event arrays.
      const overworld = snapshot('overworld', [
        component('lever', 0, 0, 0, { active: true }),
        component('lamp', 1, 0, 0),
      ])
      const nether = snapshot('nether', [
        component('lever', 0, 0, 0, { active: true }),
        component('lamp', 1, 0, 0),
      ])
      const expected = {
        hopper: [],
        lamp: [
          { dimension: 'nether', position: { x: 1, y: 0, z: 0 }, lit: true },
          { dimension: 'overworld', position: { x: 1, y: 0, z: 0 }, lit: true },
        ],
        piston: [],
        powered: [],
        trigger: [],
      }

      const forward = yield* runSnapshotBatch([overworld, nether])
      const reversed = yield* runSnapshotBatch([nether, overworld])

      expect(forward).toStrictEqual(expected)
      expect(reversed).toStrictEqual(expected)
    }),
  )
})
