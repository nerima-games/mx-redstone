import { describe, expect, it } from '@effect/vitest'
import { Effect, Ref, Result, Schema } from 'effect'
import {
  BlockPositionSchema,
  DeltaTimeSecs,
  DimensionIdSchema,
  NonNegativeTickCount,
  type BlockPosition,
  type FrameServices,
  type StageRegistration,
} from '@nerima-games/mc-kernel'
import {
  RedstoneWorldRuntime,
  RedstoneWorldRuntimeLayer,
  redstoneNodeId,
  redstoneWorldStateFor,
  type RedstoneComponentSnapshot,
  type RedstoneEventBatch,
  type RedstoneWorldRuntimeService,
  type RedstoneWorldSnapshotDuplicatePositionError,
  type RedstoneWorldRuntimeStateError,
  type RedstoneWorldSnapshot,
} from '../src/application/world-runtime'
import {
  planPistonTransition,
  type BlockCapabilityLookup,
  type PistonMovementOutcome,
  type PistonState,
  type PistonWorldView,
} from '../src/domain/piston'
import { type PowerLevel, type PowerMap } from '../src/domain/power-graph'
import { makeRuntimeRedstoneStages } from '../src/stages/registration'
import { REDSTONE_STAGE_IDS } from '../src/stages/stage-ids'
// eslint-disable-next-line sort-imports
import { FrameServicesLayer } from './frame-services'

type DimensionId = Schema.Schema.Type<typeof DimensionIdSchema>
type RuntimeError =
  | RedstoneWorldRuntimeStateError
  | RedstoneWorldSnapshotDuplicatePositionError
  | Schema.SchemaError
type TickObservation = {
  readonly power: ReadonlyArray<readonly [string, PowerLevel]>
  readonly events: RedstoneEventBatch
  readonly pistonPlans: ReadonlyArray<PistonMovementOutcome>
}

const dimensionId = (value: string): DimensionId =>
  Schema.decodeUnknownSync(DimensionIdSchema)(value)

const blockPosition = (x: number, y = 0, z = 0): BlockPosition =>
  Schema.decodeUnknownSync(BlockPositionSchema)({ x, y, z })

const DIMENSION = dimensionId('overworld')
const BUTTON_POSITION = blockPosition(2, 0, 0)
const LEVER_POSITION = blockPosition(0, 0, 0)
const PISTON_POSITION = blockPosition(1, 0, -1)
const LAMP_POSITION = blockPosition(1, 0, 1)
const PISTON_WORLD: PistonWorldView = {
  read: (position) => position.z === -3
    ? { kind: 'block', block: 'STONE' }
    : { kind: 'empty' },
}
const MOVABLE_BLOCKS: BlockCapabilityLookup = {
  pistonImmovable: () => Result.succeed(false),
}

const componentsFor = (
  leverActive: boolean,
  pistonState: PistonState,
): ReadonlyArray<RedstoneComponentSnapshot> => [
  { position: LEVER_POSITION, kind: 'lever', active: leverActive },
  { position: blockPosition(1), kind: 'wire' },
  { position: BUTTON_POSITION, kind: 'button', pulseTicks: NonNegativeTickCount(1) },
  { position: LAMP_POSITION, kind: 'lamp' },
  {
    position: PISTON_POSITION,
    kind: 'piston',
    pistonFacing: 'north',
    pistonKind: 'sticky',
    pistonState,
  },
]

const makeSnapshot = (
  components: ReadonlyArray<RedstoneComponentSnapshot>,
  reverse: boolean,
): RedstoneWorldSnapshot => ({
  dimension: DIMENSION,
  components: reverse ? [...components].reverse() : [...components],
})

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

const canonicalPower = (
  power: PowerMap,
): ReadonlyArray<readonly [string, PowerLevel]> =>
  [...power].sort(([left], [right]) => left.localeCompare(right))

const observeTick = (
  runtime: RedstoneWorldRuntimeService,
): Effect.Effect<TickObservation, RuntimeError> =>
  Effect.gen(function* () {
    const state = yield* redstoneWorldStateFor(runtime)
    const power = yield* Ref.get(state.power)
    const events: RedstoneEventBatch = {
      hopper: yield* runtime.drainHopperTransferEvents,
      lamp: yield* runtime.drainLampTransitions,
      piston: yield* runtime.drainPistonTransitions,
      powered: yield* runtime.drainPoweredComponentTransitions,
      trigger: yield* runtime.drainTriggerEvents,
    }
    return {
      events,
      pistonPlans: events.piston.map((request) =>
        planPistonTransition(request, PISTON_WORLD, MOVABLE_BLOCKS),
      ),
      power: canonicalPower(power),
    }
  })

const runFirstTick = (
  reverse = false,
  pressButton = true,
): Effect.Effect<TickObservation, RuntimeError> =>
  runtimeProgram((runtime, stages) =>
    Effect.gen(function* () {
      yield* runtime.syncSnapshot(makeSnapshot(componentsFor(true, 'retracted'), reverse))
      if (pressButton) yield* runtime.pressButton(DIMENSION, BUTTON_POSITION)
      yield* runFrame(stages)
      return yield* observeTick(runtime)
    }),
  )

const runTwoTickScenario = (
  reverse = false,
): Effect.Effect<ReadonlyArray<TickObservation>, RuntimeError> =>
  runtimeProgram((runtime, stages) =>
    Effect.gen(function* () {
      yield* runtime.syncSnapshot(makeSnapshot(componentsFor(true, 'retracted'), reverse))
      yield* runtime.pressButton(DIMENSION, BUTTON_POSITION)
      yield* runFrame(stages)
      const powered = yield* observeTick(runtime)

      yield* runtime.syncSnapshot(makeSnapshot(componentsFor(false, 'extended'), reverse))
      yield* runFrame(stages)
      const retracted = yield* observeTick(runtime)

      return [powered, retracted]
    }),
  )

const runTwoLampScenario = (
  reverse = false,
): Effect.Effect<ReadonlyArray<TickObservation['events']['lamp'][number]>, RuntimeError> =>
  runtimeProgram((runtime, stages) =>
    Effect.gen(function* () {
      const components: ReadonlyArray<RedstoneComponentSnapshot> = [
        { position: blockPosition(0, 0, 0), kind: 'lever', active: true },
        { position: blockPosition(1, 0, 0), kind: 'wire' },
        { position: blockPosition(1, 0, 1), kind: 'lamp' },
        { position: blockPosition(0, 0, 1), kind: 'lamp' },
      ]
      yield* runtime.syncSnapshot({
        dimension: DIMENSION,
        components: reverse ? [...components].reverse() : components,
      })
      yield* runFrame(stages)
      return yield* runtime.drainLampTransitions
    }),
  )

describe('redstone component determinism', () => {
  it.effect('replays a snapshot and detects a changed input', () =>
    Effect.gen(function* () {
      // Fails if the same snapshot and button input produce different power or plans on replay.
      const first = yield* runFirstTick()
      const replay = yield* runFirstTick()
      const withoutButtonPress = yield* runFirstTick(false, false)
      const buttonNode = redstoneNodeId(DIMENSION, BUTTON_POSITION)

      expect(replay).toStrictEqual(first)
      expect(first.power).toContainEqual([buttonNode, 15])
      expect(withoutButtonPress.power).not.toContainEqual([buttonNode, 15])
      expect(withoutButtonPress).not.toStrictEqual(first)
    }),
  )

  it.effect('keeps power, events, and plans when board insertion order is reversed', () =>
    Effect.gen(function* () {
      // Fails if component Map order changes a power value, event, or piston plan.
      const forward = yield* runFirstTick()
      const reversed = yield* runFirstTick(true)

      expect(reversed).toStrictEqual(forward)
    }),
  )

  it.effect('orders two lamp transitions by numeric position when component order is reversed', () =>
    Effect.gen(function* () {
      // Fails if multiple same-tick lamp transitions inherit the snapshot component order.
      const forward = yield* runTwoLampScenario()
      const reversed = yield* runTwoLampScenario(true)
      const expected = [
        { dimension: 'overworld', position: { x: 0, y: 0, z: 1 }, lit: true },
        { dimension: 'overworld', position: { x: 1, y: 0, z: 1 }, lit: true },
      ]

      expect(forward).toStrictEqual(expected)
      expect(reversed).toStrictEqual(expected)
      expect(reversed).toStrictEqual(forward)
    }),
  )

  it.effect('replays each tick of a lever and button scenario deterministically', () =>
    Effect.gen(function* () {
      // Fails if a tick replay changes the lamp event or sticky piston pull plan.
      const first = yield* runTwoTickScenario()
      const replay = yield* runTwoTickScenario()

      expect(replay).toStrictEqual(first)
      expect(first).toHaveLength(2)
      expect(first[0]?.events.lamp).toStrictEqual([{ dimension: 'overworld', position: { x: 1, y: 0, z: 1 }, lit: true }])
      expect(first[1]?.events.lamp).toStrictEqual([{ dimension: 'overworld', position: { x: 1, y: 0, z: 1 }, lit: false }])
      expect(first[0]?.events.piston).toHaveLength(1)
      expect(first[1]?.pistonPlans[0]).toMatchObject({
        kind: 'move',
        plan: {
          kind: 'sticky',
          fromState: 'extended',
          toState: 'retracted',
          moves: [{
            block: 'STONE',
            from: { x: 1, y: 0, z: -3 },
            to: { x: 1, y: 0, z: -2 },
          }],
        },
      })
    }),
  )
})
