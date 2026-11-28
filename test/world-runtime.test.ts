import { describe, expect, it } from '@effect/vitest'
import { Effect, Ref, Result, Schema } from 'effect'
import {
  RedstoneEventBatchSchema,
  RedstoneWorldRuntime,
  RedstoneWorldRuntimeLayer,
  redstoneNodeId as toRedstoneNodeId,
  redstoneWorldStateFor,
  type HopperTransferEvent,
  type RedstoneComponentSnapshot,
  type RedstoneEventBatch,
  type RedstoneTriggerEvent,
  type RedstoneWorldRuntimeService,
  type RedstoneWorldSnapshotDuplicatePositionError,
  type RedstoneWorldRuntimeStateError,
  type RedstoneWorldSnapshot,
} from '../src/application/world-runtime'
import {
  BlockPositionSchema,
  DimensionIdSchema,
  NonNegativeTickCount,
  type BlockPosition,
  type FrameServices,
  type StageRegistration,
} from '@nerima-games/mc-kernel'
import { runStagesForTicks, type RunStagesForTicksFailure } from '@nerima-games/mc-sim'
import { makeRuntimeRedstoneStages } from '../src/stages/registration'
import { REDSTONE_STAGE_IDS } from '../src/stages/stage-ids'
import { ContainerSlotSchema } from '../src/domain/comparator'
// eslint-disable-next-line sort-imports
import { FrameServicesLayer } from './frame-services'

type DimensionId = Schema.Schema.Type<typeof DimensionIdSchema>
type RuntimeError =
  | RedstoneWorldRuntimeStateError
  | RedstoneWorldSnapshotDuplicatePositionError
  | Schema.SchemaError
  | RunStagesForTicksFailure

const dimensionId = (value: string): DimensionId =>
  Schema.decodeUnknownSync(DimensionIdSchema)(value)

const blockPosition = (x: number, y = 0, z = 0): BlockPosition =>
  Schema.decodeUnknownSync(BlockPositionSchema)({ x, y, z })

const hopperTransferEvent = (
  dimension: string,
  position: BlockPosition,
  elapsedRedstoneTicks = 1,
  powered = false,
): HopperTransferEvent => {
  const [event] = Schema.decodeUnknownSync(RedstoneEventBatchSchema)({
    hopper: [{
      dimension: dimensionId(dimension),
      position,
      elapsedRedstoneTicks,
      powered,
    }],
    lamp: [],
    piston: [],
    powered: [],
    trigger: [],
  }).hopper
  if (event === undefined) {
    throw new Error('Expected a decoded hopper transfer event')
  }
  return event
}

const redstoneNodeId = (
  dimension: string,
  position: { readonly x: number; readonly y: number; readonly z: number },
) => toRedstoneNodeId(dimensionId(dimension), blockPosition(position.x, position.y, position.z))

const component = (
  x: number,
  kind: RedstoneComponentSnapshot['kind'],
  active?: boolean,
  y = 0,
  z = 0,
  timing: Pick<RedstoneComponentSnapshot, 'delayTicks' | 'pulseTicks'> = {},
): RedstoneComponentSnapshot => ({
  position: blockPosition(x, y, z),
  kind,
  ...(active === undefined ? {} : { active }),
  ...timing,
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
  runStagesForTicks(stages, NonNegativeTickCount(2))

const lampEvent = (x: number, lit: boolean, dimension = 'overworld') => ({
  dimension,
  position: { x, y: 0, z: 0 },
  lit,
})

/** Runs `count` redstone ticks and returns what the host would drain after each one. */
const drainLampsPerFrame = (
  runtime: RedstoneWorldRuntimeService,
  stages: ReadonlyArray<StageRegistration>,
  count: number,
) =>
  Effect.gen(function* () {
    const drained: Array<ReturnType<typeof lampEvent>[]> = []
    for (let frame = 0; frame < count; frame += 1) {
      yield* runFrame(stages)
      drained.push([...(yield* runtime.drainLampTransitions)])
    }
    return drained
  })

const triggerEvent = (
  x: number,
  kind: 'dispenser' | 'dropper' | 'note-block',
  options: { readonly dimension?: string; readonly facing?: 'east' | 'up'; readonly y?: number } = {},
) => ({
  dimension: options.dimension ?? 'overworld',
  ...(options.facing === undefined ? {} : { facing: options.facing }),
  kind,
  position: { x, y: options.y ?? 0, z: 0 },
})

/** Runs `count` redstone ticks and returns what the host would drain after each one. */
const drainTriggersPerFrame = (
  runtime: RedstoneWorldRuntimeService,
  stages: ReadonlyArray<StageRegistration>,
  count: number,
) =>
  Effect.gen(function* () {
    const drained: Array<Array<RedstoneTriggerEvent>> = []
    for (let frame = 0; frame < count; frame += 1) {
      yield* runFrame(stages)
      drained.push([...(yield* runtime.drainTriggerEvents)])
    }
    return drained
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

describe('RedstoneWorldRuntime', () => {
  it.effect('derives comparator container signal from typed slot readings', () =>
    runtimeProgram((runtime) =>
      Effect.gen(function* () {
        yield* runtime.syncSnapshot(snapshot('overworld', [{
          ...component(0, 'comparator'),
          containerSlots: [Schema.decodeUnknownSync(ContainerSlotSchema)({ count: 32, maxStack: 64 })],
        }]))

        const board = yield* Ref.get((yield* redstoneWorldStateFor(runtime)).board)
        const comparator = board.components.get(redstoneNodeId('overworld', { x: 0, y: 0, z: 0 }))
        expect(comparator).toMatchObject({ containerSignal: 8 })
      }),
    ),
  )

  it.effect('takes an explicit comparator container signal over deriving one from slots', () =>
    runtimeProgram((runtime) =>
      Effect.gen(function* () {
        yield* runtime.syncSnapshot(snapshot('overworld', [{
          ...component(0, 'comparator'),
          containerSignal: 11,
          containerSlots: [Schema.decodeUnknownSync(ContainerSlotSchema)({ count: 64, maxStack: 64 })],
        }]))

        const board = yield* Ref.get((yield* redstoneWorldStateFor(runtime)).board)
        const comparator = board.components.get(redstoneNodeId('overworld', { x: 0, y: 0, z: 0 }))
        expect(comparator).toMatchObject({ containerSignal: 11 })
      }),
    ),
  )

  it.effect('translates repeater sideInputs positions into node ids', () =>
    runtimeProgram((runtime) =>
      Effect.gen(function* () {
        yield* runtime.syncSnapshot(snapshot('overworld', [{
          ...component(2, 'repeater', undefined, 0, 0, { delayTicks: NonNegativeTickCount(1) }),
          inputFrom: blockPosition(1, 0, 0),
          sideInputs: [blockPosition(2, 0, 1)],
        }]))

        const board = yield* Ref.get((yield* redstoneWorldStateFor(runtime)).board)
        const repeater = board.components.get(redstoneNodeId('overworld', { x: 2, y: 0, z: 0 }))
        expect(repeater).toMatchObject({
          sideInputs: [redstoneNodeId('overworld', { x: 2, y: 0, z: 1 })],
        })
      }),
    ),
  )

  it.effect('skips unrepresentable neighbour coordinates at safe integer limits', () =>
    runtimeProgram((runtime) =>
      Effect.gen(function* () {
        yield* runtime.syncSnapshot(snapshot('overworld', [
          component(Number.MAX_SAFE_INTEGER - 1, 'wire'),
          component(Number.MAX_SAFE_INTEGER, 'wire'),
        ]))

        const board = yield* Ref.get((yield* redstoneWorldStateFor(runtime)).board)
        expect(board.components.has(redstoneNodeId('overworld', { x: Number.MAX_SAFE_INTEGER - 1, y: 0, z: 0 }))).toBe(true)
        expect(board.components.has(redstoneNodeId('overworld', { x: Number.MAX_SAFE_INTEGER, y: 0, z: 0 }))).toBe(true)
      }),
    ),
  )

  it.effect('builds stable six-face topology without connecting dimensions or diagonals', () =>
    runtimeProgram((runtime) =>
      Effect.gen(function* () {
        yield* runtime.syncSnapshot(
          snapshot('overworld', [
            component(0, 'lever', true),
            component(1, 'wire'),
            component(1, 'lamp', undefined, 1),
          ]),
        )
        yield* runtime.syncSnapshot(snapshot('nether', [component(1, 'comparator')]))

        const board = yield* Ref.get((yield* redstoneWorldStateFor(runtime)).board)
        const lever = redstoneNodeId('overworld', { x: 0, y: 0, z: 0 })
        const wire = redstoneNodeId('overworld', { x: 1, y: 0, z: 0 })
        const diagonal = redstoneNodeId('overworld', { x: 1, y: 1, z: 0 })
        const nether = redstoneNodeId('nether', { x: 1, y: 0, z: 0 })

        expect(redstoneNodeId('overworld', { x: 0, y: 0, z: 0 })).toBe(lever)
        expect(board.adjacency.get(lever)).toStrictEqual([wire])
        expect(board.adjacency.get(lever)).not.toContain(diagonal)
        expect(board.adjacency.get(lever)).not.toContain(nether)
        expect(board.components.get(nether)?.kind).toBe('comparator')
      }),
    ),
  )

  it.effect('rejects duplicate snapshot positions without changing runtime state', () =>
    runtimeProgram((runtime) =>
      Effect.gen(function* () {
        const state = yield* redstoneWorldStateFor(runtime)
        yield* runtime.syncSnapshot(snapshot('overworld', [
          component(0, 'lever', true),
          component(1, 'lamp'),
        ]))
        const dimensionsBefore = yield* Ref.get(state.dimensions)
        const boardBefore = yield* Ref.get(state.board)

        const result = yield* Effect.result(runtime.syncSnapshot(snapshot('overworld', [
          component(2, 'lever', true),
          component(2, 'lamp'),
        ])))

        expect(result).toStrictEqual(
          Result.fail({
            _tag: 'DuplicateRedstoneWorldSnapshotPosition',
            dimension: dimensionId('overworld'),
            position: blockPosition(2, 0, 0),
          }),
        )
        expect(yield* Ref.get(state.dimensions)).toBe(dimensionsBefore)
        expect(yield* Ref.get(state.board)).toBe(boardBefore)
      }),
    ),
  )

  it.effect('preserves the graph signal-distance boundary', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        const wires = Array.from({ length: 14 }, (_, index) => component(index + 1, 'wire'))
        yield* runtime.syncSnapshot(
          snapshot('overworld', [
            component(0, 'lever', true),
            ...wires,
            component(15, 'lamp'),
            component(16, 'lamp'),
          ]),
        )

        yield* runFrame(stages)
        expect(yield* runtime.drainLampTransitions).toStrictEqual([
          { dimension: 'overworld', position: { x: 15, y: 0, z: 0 }, lit: true },
        ])
      }),
    ),
  )

  it.effect('reports lever toggles once and drains transitions atomically', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        const circuit = (active: boolean) =>
          snapshot('overworld', [
            component(0, 'lever', active),
            component(1, 'wire'),
            component(2, 'lamp'),
          ])

        yield* runtime.syncSnapshot(circuit(true))
        yield* runFrame(stages)
        expect(yield* runtime.drainLampTransitions).toStrictEqual([
          { dimension: 'overworld', position: { x: 2, y: 0, z: 0 }, lit: true },
        ])
        expect(yield* runtime.drainLampTransitions).toStrictEqual([])

        yield* runFrame(stages)
        expect(yield* runtime.drainLampTransitions).toStrictEqual([])

        yield* runtime.syncSnapshot(circuit(false))
        yield* runFrame(stages)
        expect(yield* runtime.drainLampTransitions).toStrictEqual([])
        yield* runFrame(stages)
        expect(yield* runtime.drainLampTransitions).toStrictEqual([])
        yield* runFrame(stages)
        expect(yield* runtime.drainLampTransitions).toStrictEqual([
          { dimension: 'overworld', position: { x: 2, y: 0, z: 0 }, lit: false },
        ])
      }),
    ),
  )

  it.effect('turns lamps off after disconnection and after lamp removal', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        const connected = snapshot('overworld', [
          component(0, 'lever', true),
          component(1, 'wire'),
          component(2, 'lamp'),
        ])

        yield* runtime.syncSnapshot(connected)
        yield* runFrame(stages)
        yield* runtime.drainLampTransitions

        yield* runtime.syncSnapshot(
          snapshot('overworld', [component(0, 'lever', true), component(2, 'lamp')]),
        )
        yield* runFrame(stages)
        yield* runFrame(stages)
        expect(yield* runtime.drainLampTransitions).toStrictEqual([])
        yield* runFrame(stages)
        expect(yield* runtime.drainLampTransitions).toStrictEqual([
          { dimension: 'overworld', position: { x: 2, y: 0, z: 0 }, lit: false },
        ])

        yield* runtime.syncSnapshot(connected)
        yield* runFrame(stages)
        yield* runtime.drainLampTransitions
        yield* runtime.syncSnapshot(
          snapshot('overworld', [component(0, 'lever', true), component(1, 'wire')]),
        )
        yield* runFrame(stages)
        expect(yield* runtime.drainLampTransitions).toStrictEqual([
          { dimension: 'overworld', position: { x: 2, y: 0, z: 0 }, lit: false },
        ])
      }),
    ),
  )

  describe('lamp switch-off delay', () => {
    const lampCircuit = (leverActive: boolean) =>
      snapshot('overworld', [
        component(0, 'lever', leverActive),
        component(1, 'wire'),
        component(2, 'lamp'),
      ])

    it.effect('lights in the redstone tick power arrives and goes dark exactly two ticks after it is lost', () =>
      runtimeProgram((runtime, stages) =>
        Effect.gen(function* () {
          yield* runtime.syncSnapshot(lampCircuit(true))
          expect(yield* drainLampsPerFrame(runtime, stages, 1)).toStrictEqual([[lampEvent(2, true)]])

          yield* runtime.syncSnapshot(lampCircuit(false))
          expect(yield* drainLampsPerFrame(runtime, stages, 4)).toStrictEqual([
            [],
            [],
            [lampEvent(2, false)],
            [],
          ])
        }),
      ),
    )

    it.effect('stays lit and reports nothing when power returns inside the window', () =>
      runtimeProgram((runtime, stages) =>
        Effect.gen(function* () {
          yield* runtime.syncSnapshot(lampCircuit(true))
          yield* drainLampsPerFrame(runtime, stages, 1)

          yield* runtime.syncSnapshot(lampCircuit(false))
          expect(yield* drainLampsPerFrame(runtime, stages, 1)).toStrictEqual([[]])
          yield* runtime.syncSnapshot(lampCircuit(true))
          expect(yield* drainLampsPerFrame(runtime, stages, 5)).toStrictEqual([[], [], [], [], []])
        }),
      ),
    )

    it.effect('keeps the schedule when power returns and is lost again, as vanilla does not cancel a scheduled tick', () =>
      runtimeProgram((runtime, stages) =>
        Effect.gen(function* () {
          yield* runtime.syncSnapshot(lampCircuit(true))
          yield* drainLampsPerFrame(runtime, stages, 1)

          yield* runtime.syncSnapshot(lampCircuit(false))
          expect(yield* drainLampsPerFrame(runtime, stages, 1)).toStrictEqual([[]])
          yield* runtime.syncSnapshot(lampCircuit(true))
          expect(yield* drainLampsPerFrame(runtime, stages, 1)).toStrictEqual([[]])
          yield* runtime.syncSnapshot(lampCircuit(false))
          expect(yield* drainLampsPerFrame(runtime, stages, 2)).toStrictEqual([[lampEvent(2, false)], []])
        }),
      ),
    )

    it.effect('starts a fresh two-tick delay after a due tick found the lamp powered', () =>
      runtimeProgram((runtime, stages) =>
        Effect.gen(function* () {
          yield* runtime.syncSnapshot(lampCircuit(true))
          yield* drainLampsPerFrame(runtime, stages, 1)

          yield* runtime.syncSnapshot(lampCircuit(false))
          expect(yield* drainLampsPerFrame(runtime, stages, 2)).toStrictEqual([[], []])
          yield* runtime.syncSnapshot(lampCircuit(true))
          expect(yield* drainLampsPerFrame(runtime, stages, 2)).toStrictEqual([[], []])

          yield* runtime.syncSnapshot(lampCircuit(false))
          expect(yield* drainLampsPerFrame(runtime, stages, 4)).toStrictEqual([
            [],
            [],
            [lampEvent(2, false)],
            [],
          ])
        }),
      ),
    )

    it.effect('turns a removed lamp off at once and does not report it again when the delay would have expired', () =>
      runtimeProgram((runtime, stages) =>
        Effect.gen(function* () {
          yield* runtime.syncSnapshot(lampCircuit(true))
          yield* drainLampsPerFrame(runtime, stages, 1)

          yield* runtime.syncSnapshot(lampCircuit(false))
          expect(yield* drainLampsPerFrame(runtime, stages, 1)).toStrictEqual([[]])
          yield* runtime.syncSnapshot(snapshot('overworld', [component(0, 'lever', false), component(1, 'wire')]))
          expect(yield* drainLampsPerFrame(runtime, stages, 4)).toStrictEqual([
            [lampEvent(2, false)],
            [],
            [],
            [],
          ])
        }),
      ),
    )

    it.effect('times each dimension independently for lamps at identical coordinates', () =>
      runtimeProgram((runtime, stages) =>
        Effect.gen(function* () {
          const circuit = (dimension: string, active: boolean) =>
            snapshot(dimension, [
              component(0, 'lever', active),
              component(1, 'wire'),
              component(2, 'lamp'),
            ])

          yield* runtime.syncSnapshot(circuit('overworld', true))
          yield* runtime.syncSnapshot(circuit('nether', true))
          yield* drainLampsPerFrame(runtime, stages, 1)

          yield* runtime.syncSnapshot(circuit('overworld', false))
          expect(yield* drainLampsPerFrame(runtime, stages, 1)).toStrictEqual([[]])
          yield* runtime.syncSnapshot(circuit('nether', false))
          expect(yield* drainLampsPerFrame(runtime, stages, 3)).toStrictEqual([
            [],
            [lampEvent(2, false, 'overworld')],
            [lampEvent(2, false, 'nether')],
          ])
        }),
      ),
    )
  })

  describe('dispenser and dropper action delay', () => {
    const actuatorCircuit = (leverActive: boolean) =>
      snapshot('overworld', [
        component(0, 'lever', leverActive),
        component(1, 'dispenser'),
        component(0, 'dropper', undefined, 1, 0),
      ])

    it.effect('fires a dispenser and a dropper two redstone ticks after the rising edge', () =>
      runtimeProgram((runtime, stages) =>
        Effect.gen(function* () {
          yield* runtime.syncSnapshot(actuatorCircuit(true))
          expect(yield* drainTriggersPerFrame(runtime, stages, 6)).toStrictEqual([
            [],
            [],
            [triggerEvent(0, 'dropper', { y: 1 }), triggerEvent(1, 'dispenser')],
            [],
            [],
            [],
          ])
        }),
      ),
    )

    it.effect('plays a note block in the tick power arrives', () =>
      runtimeProgram((runtime, stages) =>
        Effect.gen(function* () {
          yield* runtime.syncSnapshot(snapshot('overworld', [
            component(0, 'lever', true),
            component(1, 'note-block'),
          ]))
          expect(yield* drainTriggersPerFrame(runtime, stages, 3)).toStrictEqual([
            [triggerEvent(1, 'note-block')],
            [],
            [],
          ])
        }),
      ),
    )

    it.effect('still fires when power is lost before the action is due', () =>
      runtimeProgram((runtime, stages) =>
        Effect.gen(function* () {
          yield* runtime.syncSnapshot(actuatorCircuit(true))
          expect(yield* drainTriggersPerFrame(runtime, stages, 1)).toStrictEqual([[]])
          yield* runtime.syncSnapshot(actuatorCircuit(false))
          expect(yield* drainTriggersPerFrame(runtime, stages, 3)).toStrictEqual([
            [],
            [triggerEvent(0, 'dropper', { y: 1 }), triggerEvent(1, 'dispenser')],
            [],
          ])
        }),
      ),
    )

    it.effect('schedules a fresh action for an edge that arrives on the due tick', () =>
      runtimeProgram((runtime, stages) =>
        Effect.gen(function* () {
          yield* runtime.syncSnapshot(actuatorCircuit(true))
          expect(yield* drainTriggersPerFrame(runtime, stages, 1)).toStrictEqual([[]])
          yield* runtime.syncSnapshot(actuatorCircuit(false))
          expect(yield* drainTriggersPerFrame(runtime, stages, 1)).toStrictEqual([[]])
          yield* runtime.syncSnapshot(actuatorCircuit(true))
          expect(yield* drainTriggersPerFrame(runtime, stages, 3)).toStrictEqual([
            [triggerEvent(0, 'dropper', { y: 1 }), triggerEvent(1, 'dispenser')],
            [],
            [triggerEvent(0, 'dropper', { y: 1 }), triggerEvent(1, 'dispenser')],
          ])
        }),
      ),
    )

    it.effect('acts along the facing the block has when the action comes due', () =>
      runtimeProgram((runtime, stages) =>
        Effect.gen(function* () {
          const facing = (value: 'east' | 'up') => snapshot('overworld', [
            component(0, 'lever', true),
            { ...component(1, 'dispenser'), facing: value },
          ])

          yield* runtime.syncSnapshot(facing('east'))
          expect(yield* drainTriggersPerFrame(runtime, stages, 1)).toStrictEqual([[]])
          yield* runtime.syncSnapshot(facing('up'))
          expect(yield* drainTriggersPerFrame(runtime, stages, 2)).toStrictEqual([
            [],
            [triggerEvent(1, 'dispenser', { facing: 'up' })],
          ])
        }),
      ),
    )

    it.effect('drops the action of a block removed before it is due and starts over when it returns', () =>
      runtimeProgram((runtime, stages) =>
        Effect.gen(function* () {
          yield* runtime.syncSnapshot(actuatorCircuit(true))
          expect(yield* drainTriggersPerFrame(runtime, stages, 1)).toStrictEqual([[]])
          yield* runtime.syncSnapshot(snapshot('overworld', [component(0, 'lever', true)]))
          expect(yield* drainTriggersPerFrame(runtime, stages, 3)).toStrictEqual([[], [], []])

          yield* runtime.syncSnapshot(actuatorCircuit(true))
          expect(yield* drainTriggersPerFrame(runtime, stages, 3)).toStrictEqual([
            [],
            [],
            [triggerEvent(0, 'dropper', { y: 1 }), triggerEvent(1, 'dispenser')],
          ])
        }),
      ),
    )

    it.effect('times each dimension independently for actuators at identical coordinates', () =>
      runtimeProgram((runtime, stages) =>
        Effect.gen(function* () {
          const circuit = (dimension: string) => snapshot(dimension, [
            component(0, 'lever', true),
            component(1, 'dispenser'),
          ])

          yield* runtime.syncSnapshot(circuit('overworld'))
          expect(yield* drainTriggersPerFrame(runtime, stages, 1)).toStrictEqual([[]])
          yield* runtime.syncSnapshot(circuit('nether'))
          expect(yield* drainTriggersPerFrame(runtime, stages, 3)).toStrictEqual([
            [],
            [triggerEvent(1, 'dispenser', { dimension: 'overworld' })],
            [triggerEvent(1, 'dispenser', { dimension: 'nether' })],
          ])
        }),
      ),
    )
  })

  it.effect('keeps identical coordinates isolated between dimensions', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        const circuit = (dimension: string, active: boolean) =>
          snapshot(dimension, [
            component(0, 'lever', active),
            component(1, 'wire'),
            component(2, 'lamp'),
          ])

        yield* runtime.syncSnapshot(circuit('overworld', true))
        yield* runtime.syncSnapshot(circuit('nether', false))
        yield* runFrame(stages)
        expect(yield* runtime.drainLampTransitions).toStrictEqual([
          { dimension: 'overworld', position: { x: 2, y: 0, z: 0 }, lit: true },
        ])

        yield* runtime.syncSnapshot(circuit('nether', true))
        yield* runFrame(stages)
        expect(yield* runtime.drainLampTransitions).toStrictEqual([
          { dimension: 'nether', position: { x: 2, y: 0, z: 0 }, lit: true },
        ])
      }),
    ),
  )

  it.effect('runs button pulses and configured repeater delays through the runtime stage', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        yield* runtime.syncSnapshot(
          snapshot('overworld', [
            component(0, 'button', undefined, 0, 0, { pulseTicks: NonNegativeTickCount(4) }),
            component(1, 'wire'),
            {
              ...component(2, 'repeater', undefined, 0, 0, { delayTicks: NonNegativeTickCount(2) }),
              inputFrom: blockPosition(1, 0, 0),
              outputTo: blockPosition(3, 0, 0),
            },
            component(3, 'lamp'),
          ]),
        )

        yield* runtime.pressButton(dimensionId('overworld'), blockPosition(0, 0, 0))
        yield* runFrame(stages)
        expect(yield* runtime.drainLampTransitions).toStrictEqual([])

        yield* runFrame(stages)
        expect(yield* runtime.drainLampTransitions).toStrictEqual([])

        yield* runFrame(stages)
        expect(yield* runtime.drainLampTransitions).toStrictEqual([
          { dimension: 'overworld', position: { x: 3, y: 0, z: 0 }, lit: true },
        ])

        yield* runFrame(stages)
        expect(yield* runtime.drainLampTransitions).toStrictEqual([])

        yield* runFrame(stages)
        expect(yield* runtime.drainLampTransitions).toStrictEqual([])

        yield* runFrame(stages)
        expect(yield* runtime.drainLampTransitions).toStrictEqual([])

        yield* runFrame(stages)
        expect(yield* runtime.drainLampTransitions).toStrictEqual([])

        yield* runFrame(stages)
        expect(yield* runtime.drainLampTransitions).toStrictEqual([])

        yield* runFrame(stages)
        expect(yield* runtime.drainLampTransitions).toStrictEqual([
          { dimension: 'overworld', position: { x: 3, y: 0, z: 0 }, lit: false },
        ])
      }),
    ),
  )

  it.effect('emits one powered piston transition per power edge', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        yield* runtime.syncSnapshot(snapshot('overworld', [
          component(0, 'lever', true),
          {
            ...component(1, 'piston'),
            pistonFacing: 'east',
            pistonKind: 'sticky',
            pistonState: 'retracted',
          },
        ]))

        yield* runFrame(stages)
        expect(yield* runtime.drainPistonTransitions).toStrictEqual([{
          dimension: 'overworld',
          piston: { x: 1, y: 0, z: 0 },
          facing: 'east',
          kind: 'sticky',
          state: 'retracted',
          powered: true,
        }])
        yield* runFrame(stages)
        expect(yield* runtime.drainPistonTransitions).toStrictEqual([])

        yield* runtime.syncSnapshot(snapshot('overworld', [
          component(0, 'lever', false),
          {
            ...component(1, 'piston'),
            pistonFacing: 'east',
            pistonKind: 'sticky',
            pistonState: 'extended',
          },
        ]))
        yield* runFrame(stages)
        expect(yield* runtime.drainPistonTransitions).toStrictEqual([{
          dimension: 'overworld',
          piston: { x: 1, y: 0, z: 0 },
          facing: 'east',
          kind: 'sticky',
          state: 'extended',
          powered: false,
        }])
      }),
    ),
  )

  it.effect('orders piston transitions by node id regardless of snapshot insertion order', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        yield* runtime.syncSnapshot(snapshot('overworld', [
          component(0, 'piston', undefined, 0, 1),
          component(0, 'piston', undefined, 0, -1),
          component(0, 'lever', true),
        ]))

        yield* runFrame(stages)
        expect(yield* runtime.drainPistonTransitions).toStrictEqual([
          {
            dimension: 'overworld', piston: { x: 0, y: 0, z: -1 },
            facing: 'north', kind: 'normal', state: 'retracted', powered: true,
          },
          {
            dimension: 'overworld', piston: { x: 0, y: 0, z: 1 },
            facing: 'north', kind: 'normal', state: 'retracted', powered: true,
          },
        ])
      }),
    ),
  )

  it.effect('does not emit a false retraction after a failed extension leaves a stale snapshot', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        const circuit = (active: boolean) => snapshot('overworld', [
          component(0, 'lever', active),
          { ...component(1, 'piston'), pistonState: 'retracted' },
        ])

        yield* runtime.syncSnapshot(circuit(true))
        yield* runFrame(stages)
        expect(yield* runtime.drainPistonTransitions).toHaveLength(1)

        yield* runtime.syncSnapshot(circuit(false))
        yield* runFrame(stages)
        expect(yield* runtime.drainPistonTransitions).toStrictEqual([])

        yield* runtime.syncSnapshot(circuit(true))
        yield* runFrame(stages)
        expect(yield* runtime.drainPistonTransitions).toMatchObject([{
          state: 'retracted', powered: true,
        }])
      }),
    ),
  )

  it.effect('emits deterministic trigger and powered-component transitions', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        const circuit = (active: boolean) => snapshot('overworld', [
          component(0, 'lever', active),
          component(1, 'dispenser', undefined, 0, 0),
          component(0, 'dropper', undefined, 1, 0),
          component(0, 'note-block', undefined, 0, 1),
          component(-1, 'powered-rail', undefined, 0, 0),
          component(0, 'door', undefined, -1, 0),
          component(0, 'trapdoor', undefined, 0, -1),
        ])

        yield* runtime.syncSnapshot(circuit(true))
        yield* runFrame(stages)
        expect(yield* runtime.drainTriggerEvents).toStrictEqual([
          { dimension: 'overworld', position: { x: 0, y: 0, z: 1 }, kind: 'note-block' },
        ])
        expect(yield* runtime.drainPoweredComponentTransitions).toStrictEqual([
          { dimension: 'overworld', position: { x: -1, y: 0, z: 0 }, kind: 'powered-rail', powered: true },
          { dimension: 'overworld', position: { x: 0, y: -1, z: 0 }, kind: 'door', powered: true },
          { dimension: 'overworld', position: { x: 0, y: 0, z: -1 }, kind: 'trapdoor', powered: true },
        ])

        yield* runFrame(stages)
        expect(yield* runtime.drainTriggerEvents).toStrictEqual([])
        expect(yield* runtime.drainPoweredComponentTransitions).toStrictEqual([])

        yield* runFrame(stages)
        expect(yield* runtime.drainTriggerEvents).toStrictEqual([
          { dimension: 'overworld', position: { x: 0, y: 1, z: 0 }, kind: 'dropper' },
          { dimension: 'overworld', position: { x: 1, y: 0, z: 0 }, kind: 'dispenser' },
        ])

        yield* runFrame(stages)
        expect(yield* runtime.drainTriggerEvents).toStrictEqual([])

        yield* runtime.syncSnapshot(circuit(false))
        yield* runFrame(stages)
        expect(yield* runtime.drainTriggerEvents).toStrictEqual([])
        expect(yield* runtime.drainPoweredComponentTransitions).toHaveLength(3)

        yield* runtime.syncSnapshot(circuit(true))
        yield* runFrame(stages)
        expect(yield* runtime.drainTriggerEvents).toHaveLength(1)
        yield* runFrame(stages)
        expect(yield* runtime.drainTriggerEvents).toStrictEqual([])
        yield* runFrame(stages)
        expect(yield* runtime.drainTriggerEvents).toHaveLength(2)
      }),
    ),
  )

  it.effect('does not conduct power through an actuator', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        yield* runtime.syncSnapshot(snapshot('overworld', [
          component(0, 'lever', true),
          component(1, 'dropper'),
          component(2, 'lamp'),
        ]))

        yield* runFrame(stages)
        yield* runFrame(stages)
        yield* runFrame(stages)
        expect(yield* runtime.drainTriggerEvents).toHaveLength(1)
        expect(yield* runtime.drainLampTransitions).toStrictEqual([])
      }),
    ),
  )

  it.effect('emits elapsed redstone ticks and power for HopperService on every tick', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        yield* runtime.syncSnapshot(snapshot('overworld', [component(0, 'hopper')]))

        for (let tick = 0; tick < 3; tick += 1) {
          yield* runFrame(stages)
          expect(yield* runtime.drainHopperTransferEvents).toStrictEqual([
            hopperTransferEvent('overworld', blockPosition(0, 0, 0)),
          ])
        }
      }),
    ),
  )

  it.effect('passes powered hopper state to HopperService every redstone tick', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        yield* runtime.syncSnapshot(snapshot('overworld', [
          component(0, 'lever', true),
          component(1, 'hopper'),
        ]))

        yield* runFrame(stages)
        expect(yield* runtime.drainHopperTransferEvents).toStrictEqual([
          hopperTransferEvent('overworld', blockPosition(1, 0, 0), 1, true),
        ])
      }),
    ),
  )

  it.effect('preserves hopper power changes across two redstone ticks', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        yield* runtime.syncSnapshot(snapshot('overworld', [
          component(0, 'button', undefined, 0, 0, { pulseTicks: NonNegativeTickCount(1) }),
          component(1, 'hopper'),
        ]))
        yield* runtime.pressButton(dimensionId('overworld'), blockPosition(0, 0, 0))

        yield* runStagesForTicks([stageById(stages, REDSTONE_STAGE_IDS.power)], NonNegativeTickCount(4))
        expect(yield* runtime.drainHopperTransferEvents).toStrictEqual([
          hopperTransferEvent('overworld', blockPosition(1, 0, 0), 1, true),
          hopperTransferEvent('overworld', blockPosition(1, 0, 0), 1, false),
        ])
      }),
    ),
  )

  it.effect('records an unpowered hopper tick before a delayed repeater powers it', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        yield* runtime.syncSnapshot(snapshot('overworld', [
          component(0, 'lever', true),
          component(1, 'wire'),
          {
            ...component(2, 'repeater', undefined, 0, 0, { delayTicks: NonNegativeTickCount(1) }),
            inputFrom: blockPosition(1, 0, 0),
            outputTo: blockPosition(3, 0, 0),
          },
          component(3, 'hopper'),
        ]))

        yield* runStagesForTicks([stageById(stages, REDSTONE_STAGE_IDS.power)], NonNegativeTickCount(4))

        expect(yield* runtime.drainHopperTransferEvents).toStrictEqual([
          hopperTransferEvent('overworld', blockPosition(3, 0, 0), 1, false),
          hopperTransferEvent('overworld', blockPosition(3, 0, 0), 1, true),
        ])
      }),
    ),
  )

  it.effect('restores older host events ahead of events collected later', () =>
    runtimeProgram((runtime) =>
      Effect.gen(function* () {
        const older: RedstoneEventBatch = {
          hopper: [hopperTransferEvent('overworld', blockPosition(0, 0, 0))],
          lamp: [{ dimension: dimensionId('overworld'), position: blockPosition(0, 0, 0), lit: false }],
          piston: [{
            dimension: dimensionId('overworld'),
            piston: blockPosition(0, 0, 0),
            facing: 'north',
            kind: 'normal',
            state: 'retracted',
            powered: false,
          }],
          powered: [{
            dimension: dimensionId('overworld'),
            position: blockPosition(0, 0, 0),
            kind: 'door',
            powered: false,
          }],
          trigger: [{
            dimension: dimensionId('overworld'),
            position: blockPosition(0, 0, 0),
            kind: 'note-block',
          }],
        }
        const newer: RedstoneEventBatch = {
          hopper: [hopperTransferEvent('overworld', blockPosition(1, 0, 0))],
          lamp: [{ dimension: dimensionId('overworld'), position: blockPosition(1, 0, 0), lit: true }],
          piston: [{
            dimension: dimensionId('overworld'),
            piston: blockPosition(1, 0, 0),
            facing: 'east',
            kind: 'sticky',
            state: 'extended',
            powered: true,
          }],
          powered: [{
            dimension: dimensionId('overworld'),
            position: blockPosition(1, 0, 0),
            kind: 'powered-rail',
            powered: true,
          }],
          trigger: [{
            dimension: dimensionId('overworld'),
            position: blockPosition(1, 0, 0),
            kind: 'dispenser',
          }],
        }
        yield* runtime.restoreEvents(newer)
        yield* runtime.restoreEvents(older)

        expect(yield* runtime.drainHopperTransferEvents).toStrictEqual([...older.hopper, ...newer.hopper])
        expect(yield* runtime.drainLampTransitions).toStrictEqual([...older.lamp, ...newer.lamp])
        expect(yield* runtime.drainPistonTransitions).toStrictEqual([...older.piston, ...newer.piston])
        expect(yield* runtime.drainPoweredComponentTransitions).toStrictEqual([...older.powered, ...newer.powered])
        expect(yield* runtime.drainTriggerEvents).toStrictEqual([...older.trigger, ...newer.trigger])
      }),
    ),
  )

  it.effect('returns a typed failure for a runtime service not built by makeRedstoneWorldRuntime', () =>
    Effect.gen(function* () {
      const foreignRuntime: RedstoneWorldRuntimeService = {
        drainHopperTransferEvents: Effect.succeed([]),
        drainLampTransitions: Effect.succeed([]),
        drainPistonTransitions: Effect.succeed([]),
        drainPoweredComponentTransitions: Effect.succeed([]),
        drainTriggerEvents: Effect.succeed([]),
        pressButton: () => Effect.void,
        restoreEvents: () => Effect.void,
        syncSnapshot: () => Effect.void,
      }
      const result = yield* Effect.match(redstoneWorldStateFor(foreignRuntime), {
        onFailure: (error) => error,
        onSuccess: () => null,
      })
      expect(result).toStrictEqual({
        _tag: 'UnregisteredRedstoneWorldRuntime',
        message: 'RedstoneWorldRuntime was not created by makeRedstoneWorldRuntime',
      })
    }),
  )

  it.effect('orders simultaneous hopper plan requests by node id', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        yield* runtime.syncSnapshot(snapshot('overworld', [
          component(1, 'hopper', undefined, 0, 0),
          component(0, 'hopper', undefined, 0, 0),
        ]))

        yield* runFrame(stages)
        expect(yield* runtime.drainHopperTransferEvents).toStrictEqual([
          hopperTransferEvent('overworld', blockPosition(0, 0, 0)),
          hopperTransferEvent('overworld', blockPosition(1, 0, 0)),
        ])
      }),
    ),
  )

  it.effect('uses snapshot powered state as the restoration baseline', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        yield* runtime.syncSnapshot(snapshot('overworld', [
          component(0, 'lever', true),
          { ...component(1, 'door'), powered: true },
        ]))
        yield* runFrame(stages)
        expect(yield* runtime.drainPoweredComponentTransitions).toStrictEqual([])

        yield* runtime.syncSnapshot(snapshot('overworld', [
          component(0, 'lever', false),
          { ...component(1, 'door'), powered: true },
        ]))
        yield* runFrame(stages)
        expect(yield* runtime.drainPoweredComponentTransitions).toStrictEqual([
          { dimension: 'overworld', position: { x: 1, y: 0, z: 0 }, kind: 'door', powered: false },
        ])
      }),
    ),
  )
})
