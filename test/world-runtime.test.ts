import { describe, expect, it } from '@effect/vitest'
import { Effect, Ref, Schema } from 'effect'
import {
  RedstoneWorldRuntime,
  RedstoneWorldRuntimeLayer,
  redstoneNodeId as toRedstoneNodeId,
  redstoneWorldStateFor,
  type HopperTransferEvent,
  type RedstoneComponentSnapshot,
  type RedstoneEventBatch,
  type RedstoneWorldRuntimeService,
  type RedstoneWorldRuntimeStateError,
  type RedstoneWorldSnapshot,
} from '../src/application/world-runtime'
import {
  BlockPositionSchema,
  DeltaTimeSecs,
  DimensionIdSchema,
  NonNegativeTickCount,
  type BlockPosition,
  type FrameServices,
  type StageRegistration,
} from '@nerima-games/mc-kernel'
import { makeRuntimeRedstoneStages } from '../src/stages/registration'
import { REDSTONE_STAGE_IDS } from '../src/stages/stage-ids'
import { ContainerSlotSchema } from '../src/domain/comparator'
import { HOPPER_TRANSFER_PERIOD_TICKS, HopperTransferDueRequestSchema } from '../src/domain/hopper'
// eslint-disable-next-line sort-imports
import { FrameServicesLayer } from './frame-services'

type DimensionId = Schema.Schema.Type<typeof DimensionIdSchema>
type RuntimeError = RedstoneWorldRuntimeStateError | Schema.SchemaError

const dimensionId = (value: string): DimensionId =>
  Schema.decodeUnknownSync(DimensionIdSchema)(value)

const blockPosition = (x: number, y = 0, z = 0): BlockPosition =>
  Schema.decodeUnknownSync(BlockPositionSchema)({ x, y, z })

const HOPPER_TRANSFER_DUE_REQUEST = Schema.decodeUnknownSync(HopperTransferDueRequestSchema, {
  onExcessProperty: 'error',
})({
  powered: false,
  ticksSinceTransfer: HOPPER_TRANSFER_PERIOD_TICKS,
})

const hopperTransferEvent = (dimension: string, position: BlockPosition): HopperTransferEvent => ({
  dimension: dimensionId(dimension),
  position,
  transferDueRequest: HOPPER_TRANSFER_DUE_REQUEST,
})

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
          { dimension: 'overworld', position: { x: 0, y: 1, z: 0 }, kind: 'dropper' },
          { dimension: 'overworld', position: { x: 1, y: 0, z: 0 }, kind: 'dispenser' },
        ])
        expect(yield* runtime.drainPoweredComponentTransitions).toStrictEqual([
          { dimension: 'overworld', position: { x: -1, y: 0, z: 0 }, kind: 'powered-rail', powered: true },
          { dimension: 'overworld', position: { x: 0, y: -1, z: 0 }, kind: 'door', powered: true },
          { dimension: 'overworld', position: { x: 0, y: 0, z: -1 }, kind: 'trapdoor', powered: true },
        ])

        yield* runFrame(stages)
        expect(yield* runtime.drainTriggerEvents).toStrictEqual([])
        expect(yield* runtime.drainPoweredComponentTransitions).toStrictEqual([])

        yield* runtime.syncSnapshot(circuit(false))
        yield* runFrame(stages)
        expect(yield* runtime.drainTriggerEvents).toStrictEqual([])
        expect(yield* runtime.drainPoweredComponentTransitions).toHaveLength(3)

        yield* runtime.syncSnapshot(circuit(true))
        yield* runFrame(stages)
        expect(yield* runtime.drainTriggerEvents).toHaveLength(3)
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
        expect(yield* runtime.drainTriggerEvents).toHaveLength(1)
        expect(yield* runtime.drainLampTransitions).toStrictEqual([])
      }),
    ),
  )

  it.effect('emits an unlocked hopper request once per four redstone ticks', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        yield* runtime.syncSnapshot(snapshot('overworld', [component(0, 'hopper')]))

        for (let tick = 0; tick < 3; tick += 1) {
          yield* runFrame(stages)
          expect(yield* runtime.drainHopperTransferEvents).toStrictEqual([])
        }

        yield* runFrame(stages)
        expect(yield* runtime.drainHopperTransferEvents).toStrictEqual([
          hopperTransferEvent('overworld', blockPosition(0, 0, 0)),
        ])
        expect(yield* runtime.drainHopperTransferEvents).toStrictEqual([])
      }),
    ),
  )

  it.effect('keeps powered hoppers locked after their transfer period', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        yield* runtime.syncSnapshot(snapshot('overworld', [
          component(0, 'lever', true),
          component(1, 'hopper'),
        ]))

        for (let tick = 0; tick < 4; tick += 1) {
          yield* runFrame(stages)
          expect(yield* runtime.drainHopperTransferEvents).toStrictEqual([])
        }
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

  it.effect('orders simultaneous hopper transfer requests by node id', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        yield* runtime.syncSnapshot(snapshot('overworld', [
          component(1, 'hopper', undefined, 0, 0),
          component(0, 'hopper', undefined, 0, 0),
        ]))

        for (let tick = 0; tick < 3; tick += 1) {
          yield* runFrame(stages)
          expect(yield* runtime.drainHopperTransferEvents).toStrictEqual([])
        }

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
