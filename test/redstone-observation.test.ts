import { describe, expect, it } from '@effect/vitest'
import {
  BlockPositionSchema,
  DimensionIdSchema,
  NonNegativeTickCount,
  type BlockPosition,
  type FrameServices,
  type StageRegistration,
} from '@nerima-games/mc-kernel'
import { runStagesForTicks, type RunStagesForTicksFailure } from '@nerima-games/mc-sim'
import { Effect, Ref, Schema } from 'effect'
import {
  RedstoneWorldRuntime,
  RedstoneWorldRuntimeLayer,
  redstoneNodeId,
  redstoneWorldStateFor,
  type RedstoneComponentSnapshot,
  type RedstoneWorldRuntimeService,
  type RedstoneWorldSnapshotDuplicatePositionError,
  type RedstoneWorldRuntimeStateError,
  type RedstoneWorldSnapshot,
  type RedstoneWorldState,
} from '../src/application/world-runtime'
import {
  checkRedstoneInvariants,
  observeRedstoneFrame,
} from '../src/application/redstone-observation'
import { makeRuntimeRedstoneStages } from '../src/stages/registration'
import { REDSTONE_STAGE_IDS } from '../src/stages/stage-ids'
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

const ZERO_TICK = 0
const ONE_TICK = 1

const component = (
  x: number,
  kind: RedstoneComponentSnapshot['kind'],
  state: Partial<Omit<RedstoneComponentSnapshot, 'kind' | 'position'>> = {},
): RedstoneComponentSnapshot => componentAt(blockPosition(x), kind, state)

const componentAt = (
  position: BlockPosition,
  kind: RedstoneComponentSnapshot['kind'],
  state: Partial<Omit<RedstoneComponentSnapshot, 'kind' | 'position'>> = {},
): RedstoneComponentSnapshot => ({
  kind,
  position,
  ...state,
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

const runPowerTick = (
  stages: ReadonlyArray<StageRegistration>,
): Effect.Effect<void, RuntimeError, FrameServices> =>
  runStagesForTicks([stageById(stages, REDSTONE_STAGE_IDS.power)], NonNegativeTickCount(2))

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

const runtimeStateValues = (state: RedstoneWorldState) =>
  Effect.all({
    board: Ref.get(state.board),
    blockPower: Ref.get(state.blockPower),
    dimensions: Ref.get(state.dimensions),
    observedLamps: Ref.get(state.observedLamps),
    observedPistonStates: Ref.get(state.observedPistonStates),
    observedPoweredComponents: Ref.get(state.observedPoweredComponents),
    observedTriggerPower: Ref.get(state.observedTriggerPower),
    pendingButtonPresses: Ref.get(state.pendingButtonPresses),
    pendingHopperTransferEvents: Ref.get(state.pendingHopperTransferEvents),
    pendingLampTransitions: Ref.get(state.pendingLampTransitions),
    pendingPistonTransitions: Ref.get(state.pendingPistonTransitions),
    pendingPoweredComponentTransitions: Ref.get(state.pendingPoweredComponentTransitions),
    pendingTriggerEvents: Ref.get(state.pendingTriggerEvents),
    power: Ref.get(state.power),
    tickCount: Ref.get(state.tickCount),
    timedCircuit: Ref.get(state.timedCircuit),
  }, { concurrency: 1 })

const invariantFixture = (
  runtime: RedstoneWorldRuntimeService,
  stages: ReadonlyArray<StageRegistration>,
): Effect.Effect<RedstoneWorldState, RuntimeError, FrameServices> =>
  Effect.gen(function* () {
    const dimension = dimensionId('overworld')
    const support = blockPosition(4, 0, 1)
    const torchAbove = blockPosition(4, 1, 0)
    yield* runtime.syncSnapshot({
      dimension,
      components: [
        componentAt(blockPosition(0), 'lever', { active: true }),
        componentAt(blockPosition(1), 'wire'),
        componentAt(blockPosition(2), 'wire'),
        componentAt(blockPosition(4), 'torch', { invertedBy: support }),
      ],
    }, {
      isRedstoneConductiveAt: (position) =>
        (position.x === support.x && position.y === support.y && position.z === support.z) ||
        (position.x === torchAbove.x && position.y === torchAbove.y && position.z === torchAbove.z),
    })
    yield* runPowerTick(stages)
    return yield* redstoneWorldStateFor(runtime)
  })

const setPowerLevels = (
  state: RedstoneWorldState,
  dimension: DimensionId,
  values: ReadonlyArray<Readonly<{ position: BlockPosition; level: number }>>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const power = new Map(yield* Ref.get(state.power))
    for (const { level, position } of values) {
      power.set(redstoneNodeId(dimension, position), level)
    }
    yield* Ref.set(state.power, power)
  })

const containsReference = (
  value: unknown,
  references: ReadonlySet<object>,
  seen = new Set<object>(),
): boolean => {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false
  if (references.has(value)) return true
  if (seen.has(value)) return false
  seen.add(value)
  if (value instanceof Map) {
    return [...value].some(([key, nested]) =>
      containsReference(key, references, seen) || containsReference(nested, references, seen),
    )
  }
  if (value instanceof Set) {
    return [...value].some((nested) => containsReference(nested, references, seen))
  }
  return Object.values(value).some((nested) => containsReference(nested, references, seen))
}

describe('observeRedstoneFrame', () => {
  it.effect('returns dimensioned cells with dynamic timers and current wire power', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        // BUG: Observation leaks a consumed press or reports stale component, power, or timer values.
        yield* runtime.syncSnapshot(snapshot('overworld', [
          component(0, 'button', { pulseTicks: NonNegativeTickCount(4) }),
          component(1, 'wire'),
          component(2, 'wire'),
        ]))
        yield* runtime.pressButton(dimensionId('overworld'), blockPosition(0))
        yield* runPowerTick(stages)

        const observation = yield* observeRedstoneFrame(runtime)

        expect(observation).toStrictEqual({
          dimensions: [{
            cells: [
              {
                dynamicState: {
                  pulseTicks: 4,
                  timers: { button: { inputActive: false, remainingTicks: 3 } },
                },
                kind: 'button',
                position: blockPosition(0),
                power: 15,
              },
              {
                dynamicState: { timers: {} },
                kind: 'wire',
                position: blockPosition(1),
                power: 15,
              },
              {
                dynamicState: { timers: {} },
                kind: 'wire',
                position: blockPosition(2),
                power: 14,
              },
            ],
            dimension: dimensionId('overworld'),
          }],
          pendingButtonPresses: new Set(),
          tick: 1,
        })
      }),
    ),
  )

  it.effect('projects observer output and one-tick pulse from each stage tick', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        // BUG: An observer snapshot's stale active flag hides a pulse produced by the tick stage.
        yield* runtime.syncSnapshot(snapshot('overworld', [
          component(0, 'observer', {
            active: false,
            observedBlock: 'stone',
            pulseTicks: NonNegativeTickCount(ZERO_TICK),
          }),
        ]))
        const runtimeState = yield* redstoneWorldStateFor(runtime)
        const observerNode = redstoneNodeId(dimensionId('overworld'), blockPosition(0))
        yield* runPowerTick(stages)

        const armed = yield* observeRedstoneFrame(runtime)
        expect(armed.dimensions[0]?.cells[0]?.dynamicState).toStrictEqual({
          active: false,
          pulseTicks: ZERO_TICK,
          timers: {},
        })
        expect((yield* Ref.get(runtimeState.timedCircuit)).observers?.get(observerNode)).toStrictEqual({
          output: false,
          remainingTicks: ZERO_TICK,
        })

        yield* runtime.syncSnapshot(snapshot('overworld', [
          component(0, 'observer', {
            active: false,
            observedBlock: 'dirt',
            pulseTicks: NonNegativeTickCount(ZERO_TICK),
          }),
        ]))
        yield* runPowerTick(stages)

        const pulsing = yield* observeRedstoneFrame(runtime)
        expect(pulsing.dimensions[0]?.cells[0]?.dynamicState).toStrictEqual({
          active: true,
          pulseTicks: ONE_TICK,
          timers: {},
        })
        expect((yield* Ref.get(runtimeState.timedCircuit)).observers?.get(observerNode)).toStrictEqual({
          output: true,
          remainingTicks: ONE_TICK,
        })

        yield* runPowerTick(stages)

        const cleared = yield* observeRedstoneFrame(runtime)
        expect(cleared.dimensions[0]?.cells[0]?.dynamicState).toStrictEqual({
          active: false,
          pulseTicks: ZERO_TICK,
          timers: {},
        })
        expect((yield* Ref.get(runtimeState.timedCircuit)).observers?.get(observerNode)).toStrictEqual({
          output: false,
          remainingTicks: ZERO_TICK,
        })
      }),
    ),
  )

  it.effect('leaves every runtime Ref value unchanged', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        // BUG: An observation read or invariant check drains, advances, or rewrites runtime state.
        yield* runtime.syncSnapshot(snapshot('overworld', [component(0, 'lever', { active: true })]))
        yield* runPowerTick(stages)
        const state = yield* redstoneWorldStateFor(runtime)
        const before = structuredClone(yield* runtimeStateValues(state))

        yield* observeRedstoneFrame(runtime)
        yield* checkRedstoneInvariants(runtime)

        expect(structuredClone(yield* runtimeStateValues(state))).toStrictEqual(before)
      }),
    ),
  )

  it.effect('returns a detached set of pending button positions', () =>
    runtimeProgram((runtime) =>
      Effect.gen(function* () {
        // BUG: A returned live set changes after a later button press.
        const dimension = dimensionId('overworld')
        const first = blockPosition(0)
        const second = blockPosition(1)
        yield* runtime.pressButton(dimension, first)
        const observation = yield* observeRedstoneFrame(runtime)
        const state = yield* redstoneWorldStateFor(runtime)
        const livePending = yield* Ref.get(state.pendingButtonPresses)

        yield* runtime.pressButton(dimension, second)

        expect(observation.pendingButtonPresses).not.toBe(livePending)
        expect(observation.pendingButtonPresses).toStrictEqual(new Set([redstoneNodeId(dimension, first)]))
        expect(yield* Ref.get(state.pendingButtonPresses)).toStrictEqual(new Set([
          redstoneNodeId(dimension, first),
          redstoneNodeId(dimension, second),
        ]))
      }),
    ),
  )

  it.effect('copies strongPowerTo from the synced snapshot into the observation DTO', () =>
    runtimeProgram((runtime) =>
      Effect.gen(function* () {
        // BUG: mutating host placement metadata after sync changes the observed snapshot.
        const strongPowerTo = { ...blockPosition(1, 2, 3) }
        yield* runtime.syncSnapshot(snapshot('overworld', [
          component(0, 'lever', { strongPowerTo }),
        ]))
        strongPowerTo.x = blockPosition(99, 2, 3).x

        const observation = yield* observeRedstoneFrame(runtime)
        const lever = observation.dimensions[0]?.cells.find((cell) => cell.kind === 'lever')
        expect(lever?.dynamicState.strongPowerTo).toStrictEqual(blockPosition(1, 2, 3))
      }),
    ),
  )

  it.effect('fails with the registered-runtime error for a copied service', () =>
    runtimeProgram((runtime) =>
      Effect.gen(function* () {
        // This fails if a service copy is mistaken for a runtime created by the factory.
        const result = yield* Effect.match(observeRedstoneFrame({ ...runtime }), {
          onFailure: (error) => ({ error, result: 'failure' as const }),
          onSuccess: (observation) => ({ observation, result: 'success' as const }),
        })

        expect(result).toStrictEqual({
          error: {
            _tag: 'UnregisteredRedstoneWorldRuntime',
            message: 'RedstoneWorldRuntime was not created by makeRedstoneWorldRuntime',
          },
          result: 'failure',
        })
      }),
    ),
  )

  it.effect('returns no runtime Ref or node ID in the DTO', () =>
    runtimeProgram((runtime) =>
      Effect.gen(function* () {
        // This fails if internal Ref objects or node keys escape through the DTO.
        yield* runtime.syncSnapshot(snapshot('overworld', [
          component(0, 'lever', { active: true }),
          component(1, 'repeater', {
            delayTicks: NonNegativeTickCount(2),
            inputFrom: blockPosition(0),
            outputTo: blockPosition(2),
            sideInputs: [blockPosition(1, 0, 1)],
          }),
        ]))
        const state = yield* redstoneWorldStateFor(runtime)
        const refs = new Set<object>([
          state.board,
          state.blockPower,
          state.conductivityLookups,
          state.dimensions,
          state.observedLamps,
          state.observedPistonStates,
          state.observedPoweredComponents,
          state.observedTriggerPower,
          state.pendingButtonPresses,
          state.pendingHopperTransferEvents,
          state.pendingLampTransitions,
          state.pendingPistonTransitions,
          state.pendingPoweredComponentTransitions,
          state.pendingTriggerEvents,
          state.power,
          state.tickCount,
          state.timedCircuit,
        ])
        const observation = yield* observeRedstoneFrame(runtime)
        const serialized = JSON.stringify(observation)

        expect(containsReference(observation, refs)).toBe(false)
        for (const position of [
          blockPosition(0),
          blockPosition(1),
          blockPosition(2),
          blockPosition(1, 0, 1),
        ]) {
          expect(serialized).not.toContain(redstoneNodeId(dimensionId('overworld'), position))
        }
      }),
    ),
  )
})

describe('checkRedstoneInvariants', () => {
  it.effect('accepts domain-valid wire decay and block-channel values', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        // BUG: Valid direct sources, wire decay, and torch channels are reported as violations.
        yield* invariantFixture(runtime, stages)

        const results = yield* checkRedstoneInvariants(runtime)

        expect(results).toStrictEqual([
          { id: 'power-level-range', passed: true, violations: [] },
          { id: 'wire-neighbor-decay', passed: true, violations: [] },
          { id: 'torch-support-exclusion', passed: true, violations: [] },
          { id: 'block-power-channel-consistency', passed: true, violations: [] },
        ])
      }),
    ),
  )

  it.effect('reports out-of-range power and incorrect wire attenuation', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        // BUG: Power outside 0..15 or a wire level inconsistent with its driven neighbours passes.
        const state = yield* invariantFixture(runtime, stages)
        const dimension = dimensionId('overworld')
        const wirePosition = blockPosition(2)
        const wireKey = redstoneNodeId(dimension, wirePosition)
        const initialPower = yield* Ref.get(state.power)

        const outOfRange = new Map(initialPower)
        outOfRange.set(wireKey, 16)
        yield* Ref.set(state.power, outOfRange)
        const rangeResults = yield* checkRedstoneInvariants(runtime)

        expect(rangeResults.find(({ id }) => id === 'power-level-range')).toStrictEqual({
          id: 'power-level-range',
          passed: false,
          violations: [{ dimension, position: wirePosition }],
        })

        const incorrectWireLevel = new Map(initialPower)
        incorrectWireLevel.set(wireKey, 12)
        yield* Ref.set(state.power, incorrectWireLevel)
        const wireResults = yield* checkRedstoneInvariants(runtime)

        expect(wireResults.find(({ id }) => id === 'wire-neighbor-decay')).toStrictEqual({
          id: 'wire-neighbor-decay',
          passed: false,
          violations: [{ dimension, position: wirePosition }],
        })
      }),
    ),
  )

  it.effect('reports a wrong strong/weak channel and power at a torch support', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        // BUG: Weak power is accepted where the source rule requires strong power or no torch support power.
        const state = yield* invariantFixture(runtime, stages)
        const dimension = dimensionId('overworld')
        const torchAbove = blockPosition(4, 1, 0)
        const support = blockPosition(4, 0, 1)
        const initialBlockPower = yield* Ref.get(state.blockPower)

        const wrongChannel = new Map(initialBlockPower)
        wrongChannel.set(redstoneNodeId(dimension, torchAbove), { strongLevel: 0, weakLevel: 15 })
        yield* Ref.set(state.blockPower, wrongChannel)
        const channelResults = yield* checkRedstoneInvariants(runtime)

        expect(channelResults.find(({ id }) => id === 'block-power-channel-consistency')).toStrictEqual({
          id: 'block-power-channel-consistency',
          passed: false,
          violations: [{ dimension, position: torchAbove }],
        })

        const poweredSupport = new Map(initialBlockPower)
        poweredSupport.set(redstoneNodeId(dimension, support), { strongLevel: 0, weakLevel: 15 })
        yield* Ref.set(state.blockPower, poweredSupport)
        const supportResults = yield* checkRedstoneInvariants(runtime)

        expect(supportResults.find(({ id }) => id === 'torch-support-exclusion')).toStrictEqual({
          id: 'torch-support-exclusion',
          passed: false,
          violations: [{ dimension, position: support }],
        })
      }),
    ),
  )

  it.effect('checks directional drivers, torch channels, and safe coordinate edges', () =>
    runtimeProgram((runtime) =>
      Effect.gen(function* () {
        // BUG: A directed source powers a side wire, a torch powers its support, or weak block power is lost.
        const dimension = dimensionId('overworld')
        const wireAt = (x: number, y = 0, z = 0) => blockPosition(x, y, z)
        const torchSupport = wireAt(60, 0, 101)
        const secondTorchSupport = wireAt(60, 0, 97)
        const weakTarget = wireAt(60, 0, 99)
        const maxPosition = wireAt(Number.MAX_SAFE_INTEGER)
        yield* runtime.syncSnapshot(snapshot('overworld', [
          componentAt(wireAt(10), 'repeater', {
            delayTicks: NonNegativeTickCount(1),
            outputTo: wireAt(11),
          }),
          componentAt(wireAt(11), 'wire'),
          componentAt(wireAt(9), 'wire'),
          componentAt(wireAt(20), 'comparator', {
            inputFrom: wireAt(19),
            outputTo: wireAt(21),
          }),
          componentAt(wireAt(21), 'wire'),
          componentAt(wireAt(19), 'wire'),
          componentAt(wireAt(30), 'observer', { active: true, outputTo: wireAt(31) }),
          componentAt(wireAt(31), 'wire'),
          componentAt(wireAt(29), 'wire'),
          componentAt(wireAt(40), 'button', { active: true, strongPowerTo: wireAt(41) }),
          componentAt(wireAt(50), 'pressure-plate', { active: true, strongPowerTo: wireAt(51) }),
          componentAt(wireAt(60, 0, 100), 'torch', { invertedBy: torchSupport }),
          componentAt(wireAt(59, 0, 100), 'wire'),
          componentAt(torchSupport, 'wire'),
          componentAt(wireAt(60, 0, 98), 'torch', { invertedBy: secondTorchSupport }),
          componentAt(secondTorchSupport, 'wire'),
          componentAt(wireAt(70), 'piston'),
          componentAt(wireAt(71), 'wire'),
          componentAt(maxPosition, 'lever', { active: true }),
        ]), {
          isRedstoneConductiveAt: (position) =>
            position.x === weakTarget.x && position.y === weakTarget.y && position.z === weakTarget.z,
        })
        const state = yield* redstoneWorldStateFor(runtime)
        yield* setPowerLevels(state, dimension, [
          { position: wireAt(10), level: 15 },
          { position: wireAt(11), level: 15 },
          { position: wireAt(9), level: 0 },
          { position: wireAt(20), level: 15 },
          { position: wireAt(21), level: 15 },
          { position: wireAt(19), level: 0 },
          { position: wireAt(30), level: 15 },
          { position: wireAt(31), level: 15 },
          { position: wireAt(29), level: 0 },
          { position: wireAt(40), level: 15 },
          { position: wireAt(50), level: 15 },
          { position: wireAt(60, 0, 100), level: 15 },
          { position: wireAt(59, 0, 100), level: 15 },
          { position: torchSupport, level: 0 },
          { position: wireAt(60, 0, 98), level: 15 },
          { position: secondTorchSupport, level: 0 },
          { position: wireAt(70), level: 15 },
          { position: wireAt(71), level: 0 },
          { position: maxPosition, level: 15 },
        ])
        yield* Ref.set(state.blockPower, new Map([
          [redstoneNodeId(dimension, weakTarget), { strongLevel: 0, weakLevel: 15 }],
        ]))

        expect(yield* checkRedstoneInvariants(runtime)).toStrictEqual([
          { id: 'power-level-range', passed: true, violations: [] },
          { id: 'wire-neighbor-decay', passed: true, violations: [] },
          { id: 'torch-support-exclusion', passed: true, violations: [] },
          { id: 'block-power-channel-consistency', passed: true, violations: [] },
        ])
      }),
    ),
  )

  it.effect('reports duplicate out-of-range channels and a missing actual block channel', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        // BUG: Out-of-range channel values evade the range rule or a missing expected channel is accepted.
        const state = yield* invariantFixture(runtime, stages)
        const dimension = dimensionId('overworld')
        const torchAbove = blockPosition(4, 1, 0)
        const torchAboveKey = redstoneNodeId(dimension, torchAbove)
        const initialBlockPower = yield* Ref.get(state.blockPower)

        const invalidChannels = new Map(initialBlockPower)
        invalidChannels.set(torchAboveKey, { strongLevel: 16, weakLevel: 17 })
        yield* Ref.set(state.blockPower, invalidChannels)
        const rangeResults = yield* checkRedstoneInvariants(runtime)

        expect(rangeResults.find(({ id }) => id === 'power-level-range')).toStrictEqual({
          id: 'power-level-range',
          passed: false,
          violations: [{ dimension, position: torchAbove }],
        })

        const missingChannel = new Map(initialBlockPower)
        missingChannel.delete(torchAboveKey)
        yield* Ref.set(state.blockPower, missingChannel)
        const channelResults = yield* checkRedstoneInvariants(runtime)

        expect(channelResults.find(({ id }) => id === 'block-power-channel-consistency')).toStrictEqual({
          id: 'block-power-channel-consistency',
          passed: false,
          violations: [{ dimension, position: torchAbove }],
        })
      }),
    ),
  )

  it.effect('handles missing adjacency and stale graph entries without inventing wire power', () =>
    runtimeProgram((runtime) =>
      Effect.gen(function* () {
        // BUG: A stale neighbour or missing adjacency creates power in a wire with no driven component.
        const dimension = dimensionId('overworld')
        const wireWithoutAdjacency = blockPosition(1)
        const wireWithStaleNeighbour = blockPosition(3)
        const lampPosition = blockPosition(2)
        const pistonPosition = blockPosition(10)
        const torchPosition = blockPosition(20)
        const missingPosition = blockPosition(90)
        yield* runtime.syncSnapshot(snapshot('overworld', [
          component(0, 'lever', { active: true }),
          componentAt(wireWithoutAdjacency, 'wire'),
          componentAt(lampPosition, 'lamp'),
          componentAt(wireWithStaleNeighbour, 'wire'),
          componentAt(pistonPosition, 'piston'),
          componentAt(torchPosition, 'torch'),
        ]))
        const state = yield* redstoneWorldStateFor(runtime)
        const board = yield* Ref.get(state.board)
        const adjacency = new Map(board.adjacency)
        adjacency.delete(redstoneNodeId(dimension, wireWithoutAdjacency))
        adjacency.set(redstoneNodeId(dimension, wireWithStaleNeighbour), [
          redstoneNodeId(dimension, lampPosition),
          redstoneNodeId(dimension, missingPosition),
        ])
        const components = new Map(board.components)
        components.delete(redstoneNodeId(dimension, pistonPosition))
        yield* Ref.set(state.board, { adjacency, components })
        yield* setPowerLevels(state, dimension, [
          { position: blockPosition(0), level: 15 },
          { position: wireWithoutAdjacency, level: 0 },
          { position: lampPosition, level: 15 },
          { position: wireWithStaleNeighbour, level: 0 },
          { position: pistonPosition, level: 15 },
          { position: torchPosition, level: 15 },
        ])
        const power = new Map(yield* Ref.get(state.power))
        power.delete(redstoneNodeId(dimension, blockPosition(0)))
        yield* Ref.set(state.power, power)

        expect(yield* checkRedstoneInvariants(runtime)).toStrictEqual([
          { id: 'power-level-range', passed: true, violations: [] },
          { id: 'wire-neighbor-decay', passed: true, violations: [] },
          { id: 'torch-support-exclusion', passed: true, violations: [] },
          { id: 'block-power-channel-consistency', passed: true, violations: [] },
        ])
      }),
    ),
  )
})
