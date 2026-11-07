import { afterEach, vi } from 'vitest'
import { describe, expect, it } from '@effect/vitest'
import {
  BlockPositionSchema,
  DeltaTimeSecs,
  DimensionIdSchema,
  NonNegativeTickCount,
  type BlockPosition,
  type FrameServices,
  type StageRegistration,
} from '@nerima-games/mc-kernel'
import { Effect, Exit, Ref, Schema } from 'effect'
import * as powerGraph from '../src/domain/power-graph.js'
import { ContainerSlotSchema } from '../src/domain/comparator.js'
import {
  REDSTONE_OBSERVATION_HISTORY_LIMIT,
  RedstoneWorldRuntime,
  RedstoneWorldRuntimeLayer,
  captureObservedTick,
  redstoneNodeId,
  redstonePowerTickContextFactoryFor,
  redstonePowerTickContextFor,
  redstoneTickObservationsFor,
  redstoneWorldStateFor,
  setRedstoneObservationEnabled,
  type RedstoneComponentSnapshot,
  type RedstoneWorldRuntimeStateError,
  type RedstoneWorldRuntimeService,
  type RedstoneWorldSnapshotDuplicatePositionError,
  type RedstoneWorldSnapshot,
  type RedstoneWorldState,
} from '../src/application/world-runtime.js'
import { observeRedstoneFrame } from '../src/application/redstone-observation.js'
import { makeRuntimeRedstoneStages } from '../src/stages/registration.js'
import { advanceTimedCircuitWithProvenanceContext } from '../src/domain/power-timing.js'
import { REDSTONE_STAGE_IDS } from '../src/stages/stage-ids.js'
import { FrameServicesLayer } from './frame-services.js'

type RuntimeError =
  | RedstoneWorldRuntimeStateError
  | RedstoneWorldSnapshotDuplicatePositionError
  | Schema.SchemaError

const dimensionId = (value: string): Schema.Schema.Type<typeof DimensionIdSchema> =>
  Schema.decodeUnknownSync(DimensionIdSchema)(value)

const blockPosition = (x: number, y = 0, z = 0): BlockPosition =>
  Schema.decodeUnknownSync(BlockPositionSchema)({ x, y, z })

const component = (
  x: number,
  kind: RedstoneComponentSnapshot['kind'],
  state: Partial<Omit<RedstoneComponentSnapshot, 'kind' | 'position'>> = {},
): RedstoneComponentSnapshot => ({
  kind,
  position: blockPosition(x),
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
  stageById(stages, REDSTONE_STAGE_IDS.power).run(DeltaTimeSecs(0.1))

const runEffectsStage = (
  stages: ReadonlyArray<StageRegistration>,
): Effect.Effect<void, RuntimeError, FrameServices> =>
  stageById(stages, REDSTONE_STAGE_IDS.effects).run(DeltaTimeSecs(0.1))

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
    tickAccumulatorSecs: Ref.get(state.tickAccumulatorSecs),
    tickCount: Ref.get(state.tickCount),
    timedCircuit: Ref.get(state.timedCircuit),
  }, { concurrency: 1 })

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

afterEach(() => vi.restoreAllMocks())

describe('runtime tick observation', () => {
  it.effect('drops transient channels when no runtime reader needs prior block power', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        // BUG: persisting block channels without a timed input or power reader allocates every tick.
        yield* runtime.syncSnapshot(snapshot('overworld', [
          component(0, 'lever', { active: true, strongPowerTo: blockPosition(1) }),
          component(2, 'wire'),
        ]), {
          isRedstoneConductiveAt: ({ x }) => x === 1,
        })
        yield* runPowerTick(stages)
        const state = yield* redstoneWorldStateFor(runtime)
        const [power, blockPower] = yield* Effect.all([
          Ref.get(state.power),
          Ref.get(state.blockPower),
        ], { concurrency: 1 })

        expect(power.get(redstoneNodeId(dimensionId('overworld'), blockPosition(2)))).toBe(15)
        expect(blockPower.size).toBe(0)
      }),
    ),
  )

  it.effect('checks a wire support even when no lamp reads block power', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        // BUG: skipping wire output without a lamp loses the required support-conductivity query.
        const support = blockPosition(1, -1, 0)
        const conductivity = vi.fn(({ x, y, z }: BlockPosition) => x === 1 && y === -1 && z === 0)
        yield* runtime.syncSnapshot(snapshot('overworld', [
          component(0, 'lever', { active: true }),
          component(1, 'wire'),
        ]), { isRedstoneConductiveAt: conductivity })
        yield* runPowerTick(stages)
        const state = yield* redstoneWorldStateFor(runtime)
        const power = yield* Ref.get(state.power)

        expect(power.get(redstoneNodeId(dimensionId('overworld'), blockPosition(1)))).toBe(15)
        expect(conductivity.mock.calls.filter(([position]) =>
          position.x === support.x && position.y === support.y && position.z === support.z,
        )).toHaveLength(1)
      }),
    ),
  )

  it.effect('weakly powers a support beside the lamp on the benchmark wire layout and refreshes each tick', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        // BUG: omitting a powered wire's conductive support leaves the adjacent lamp dark or stale.
        const supports = new Set<string>()
        const wires = []
        for (let z = 0; z < 20; z += 1) {
          for (let x = 1; x <= 20; x += 1) {
            wires.push({ kind: 'wire' as const, position: blockPosition(x, 0, z) })
            supports.add(`${x},-1,${z}`)
          }
        }
        const sourceSupport = blockPosition(1, -1, 0)
        const lampSupport = blockPosition(1, -1, 1)
        const lamp = blockPosition(0, -1, 1)
        let lampSupportConductive = true
        const conductivity = vi.fn(({ x, y, z }: BlockPosition) =>
          x === lampSupport.x && y === lampSupport.y && z === lampSupport.z
            ? lampSupportConductive
            : supports.has(`${x},${y},${z}`),
        )
        yield* runtime.syncSnapshot(snapshot('overworld', [
          ...wires,
          {
            kind: 'lever',
            active: true,
            position: blockPosition(1, -2, 0),
            strongPowerTo: sourceSupport,
          },
          { kind: 'lamp', position: lamp },
        ]), { isRedstoneConductiveAt: conductivity })

        yield* runPowerTick(stages)
        yield* runEffectsStage(stages)
        const state = yield* redstoneWorldStateFor(runtime)
        const firstPower = yield* Ref.get(state.power)
        const lampKey = redstoneNodeId(dimensionId('overworld'), lamp)
        expect(firstPower.get(lampKey)).toBe(14)
        expect(yield* runtime.drainLampTransitions).toStrictEqual([
          { dimension: 'overworld', position: lamp, lit: true },
        ])
        expect(conductivity.mock.calls.filter(([position]) =>
          position.x === lampSupport.x && position.y === lampSupport.y && position.z === lampSupport.z,
        )).toHaveLength(1)

        lampSupportConductive = false
        yield* runPowerTick(stages)
        yield* runEffectsStage(stages)
        const secondPower = yield* Ref.get(state.power)
        expect(secondPower.has(lampKey)).toBe(false)
        expect(yield* runtime.drainLampTransitions).toStrictEqual([
          { dimension: 'overworld', position: lamp, lit: false },
        ])
        expect(conductivity.mock.calls.filter(([position]) =>
          position.x === lampSupport.x && position.y === lampSupport.y && position.z === lampSupport.z,
        )).toHaveLength(2)
      }),
    ),
  )

  it.effect('bridges a strong conductive block to adjacent wire and lamp receivers once', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        // BUG: a strong conductive block must power adjacent dust and lamps while memoizing its host lookup.
        const conductiveBlock = blockPosition(1)
        const conductivity = vi.fn(({ x, y, z }: BlockPosition) => x === 1 && y === 0 && z === 0)
        yield* runtime.syncSnapshot(snapshot('overworld', [
          component(0, 'lever', { active: true, strongPowerTo: conductiveBlock }),
          component(2, 'wire'),
          { kind: 'lamp', position: blockPosition(1, 0, 1) },
        ]), { isRedstoneConductiveAt: conductivity })
        yield* runPowerTick(stages)
        const state = yield* redstoneWorldStateFor(runtime)
        const [power, blockPower] = yield* Effect.all([
          Ref.get(state.power),
          Ref.get(state.blockPower),
        ], { concurrency: 1 })
        const blockKey = redstoneNodeId(dimensionId('overworld'), conductiveBlock)
        const queriedPositions = conductivity.mock.calls
          .map(([position]) => `${position.x},${position.y},${position.z}`)

        expect(power.get(redstoneNodeId(dimensionId('overworld'), blockPosition(2)))).toBe(15)
        expect(power.get(redstoneNodeId(dimensionId('overworld'), blockPosition(1, 0, 1)))).toBe(15)
        expect(blockPower.get(blockKey)).toStrictEqual({ strongLevel: 15, weakLevel: 15 })
        expect(queriedPositions.filter((key) => key === '1,0,0')).toHaveLength(1)
        expect(new Set(queriedPositions).size).toBe(queriedPositions.length)
        expect(queriedPositions.length).toBeLessThanOrEqual(6 * power.size)
      }),
    ),
  )

  it.effect('refreshes conductivity answers for each tick in a multi-tick frame', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        // BUG: reusing the first-tick lookup cache would freeze host conductivity across a two-tick frame.
        const conductivity = vi.fn(({ x, y, z }: BlockPosition) => x === 1 && y === 0 && z === 0)
        yield* runtime.syncSnapshot(snapshot('overworld', [
          component(0, 'lever', { active: true, strongPowerTo: blockPosition(1) }),
          component(2, 'wire'),
        ]), { isRedstoneConductiveAt: conductivity })

        yield* stageById(stages, REDSTONE_STAGE_IDS.power).run(DeltaTimeSecs(0.2))
        const state = yield* redstoneWorldStateFor(runtime)
        const [power, tickCount] = yield* Effect.all([
          Ref.get(state.power),
          Ref.get(state.tickCount),
        ], { concurrency: 1 })

        expect(tickCount).toBe(2)
        expect(power.get(redstoneNodeId(dimensionId('overworld'), blockPosition(2)))).toBe(15)
        expect(conductivity.mock.calls.filter(([position]) =>
          position.x === 1 && position.y === 0 && position.z === 0,
        )).toHaveLength(2)
      }),
    ),
  )

  it.effect('lets weak block power reach a lamp without energizing wire', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        // BUG: weak redstone power reaches lamps but is never a wire input.
        const conductiveBlock = blockPosition(2)
        const conductivity = vi.fn(({ x, y, z }: BlockPosition) => x === 2 && y === 0 && z === 0)
        yield* runtime.syncSnapshot(snapshot('overworld', [
          component(0, 'lever', { active: true }),
          component(1, 'wire'),
          component(3, 'lamp'),
          component(4, 'wire'),
        ]), { isRedstoneConductiveAt: conductivity })
        yield* runPowerTick(stages)
        const state = yield* redstoneWorldStateFor(runtime)
        const [power, blockPower] = yield* Effect.all([
          Ref.get(state.power),
          Ref.get(state.blockPower),
        ], { concurrency: 1 })
        const queriedPositions = conductivity.mock.calls
          .map(([position]) => `${position.x},${position.y},${position.z}`)

        expect(power.get(redstoneNodeId(dimensionId('overworld'), blockPosition(3)))).toBe(15)
        expect(power.has(redstoneNodeId(dimensionId('overworld'), blockPosition(4)))).toBe(false)
        expect(blockPower.get(redstoneNodeId(dimensionId('overworld'), conductiveBlock)))
          .toStrictEqual({ strongLevel: 0, weakLevel: 15 })
        expect(queriedPositions.filter((key) => key === '2,0,0')).toHaveLength(1)
        expect(new Set(queriedPositions).size).toBe(queriedPositions.length)
        expect(queriedPositions.length).toBeLessThanOrEqual(6 * power.size)
      }),
    ),
  )

  it.effect('checks source targets without eligible face receivers', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        // BUG: source output must still inspect its target even when no current component receives the block power.
        const target = blockPosition(1)
        const conductivity = vi.fn(({ x, y, z }: BlockPosition) =>
          x === target.x && y === target.y && z === target.z,
        )
        yield* runtime.syncSnapshot(snapshot('overworld', [
          component(0, 'lever', { active: true, strongPowerTo: target }),
        ]), { isRedstoneConductiveAt: conductivity })
        yield* runPowerTick(stages)
        const state = yield* redstoneWorldStateFor(runtime)

        expect((yield* Ref.get(state.blockPower)).size).toBe(0)
        expect(conductivity.mock.calls.filter(([position]) =>
          position.x === target.x && position.y === target.y && position.z === target.z,
        )).toHaveLength(1)
      }),
    ),
  )

  it.effect('reuses six-face partitions across ticks for one snapshot', () =>
    runtimeProgram((runtime) =>
      Effect.gen(function* () {
        // BUG: rebuilding redstone face partitions each tick repeats position lookup and adjacency allocation.
        yield* runtime.syncSnapshot(snapshot('overworld', [
          component(0, 'lever'),
          component(1, 'wire'),
        ]), {
          isRedstoneConductiveAt: () => false,
        })
        const state = yield* redstoneWorldStateFor(runtime)
        const first = yield* redstonePowerTickContextFor(state, new Map())
        const second = yield* redstonePowerTickContextFor(state, new Map())
        const firstNeighbours = first.context.faceNeighboursOf
        const secondNeighbours = second.context.faceNeighboursOf
        const firstBlockNeighbours = first.context.faceBlockNeighboursOf
        const secondBlockNeighbours = second.context.faceBlockNeighboursOf
        const firstComponentNeighbours = first.context.faceComponentNeighboursOf
        const secondComponentNeighbours = second.context.faceComponentNeighboursOf
        const firstWireNeighbours = first.context.faceWireNeighboursOf
        const secondWireNeighbours = second.context.faceWireNeighboursOf
        const firstLampNeighbours = first.context.faceLampNeighboursOf
        const secondLampNeighbours = second.context.faceLampNeighboursOf
        if (!firstNeighbours || !secondNeighbours ||
          !firstBlockNeighbours || !secondBlockNeighbours ||
          !firstComponentNeighbours || !secondComponentNeighbours ||
          !firstWireNeighbours || !secondWireNeighbours ||
          !firstLampNeighbours || !secondLampNeighbours) {
          throw new Error('expected snapshot face partitions')
        }
        const key = redstoneNodeId(dimensionId('overworld'), blockPosition(0))
        const east = redstoneNodeId(dimensionId('overworld'), blockPosition(1))

        expect(firstNeighbours(key)).toStrictEqual([
          east,
          redstoneNodeId(dimensionId('overworld'), blockPosition(-1)),
          redstoneNodeId(dimensionId('overworld'), blockPosition(0, 1)),
          redstoneNodeId(dimensionId('overworld'), blockPosition(0, -1)),
          redstoneNodeId(dimensionId('overworld'), blockPosition(0, 0, 1)),
          redstoneNodeId(dimensionId('overworld'), blockPosition(0, 0, -1)),
        ])
        expect(secondNeighbours(key)).toBe(firstNeighbours(key))
        expect(firstComponentNeighbours(key)).toStrictEqual([east])
        expect(firstBlockNeighbours(key)).toStrictEqual(firstNeighbours(key).filter((neighbour) => neighbour !== east))
        expect(firstWireNeighbours(key)).toStrictEqual([east])
        expect(firstLampNeighbours(key)).toStrictEqual([])
        expect(secondComponentNeighbours(key)).toBe(firstComponentNeighbours(key))
        expect(secondBlockNeighbours(key)).toBe(firstBlockNeighbours(key))
        expect(secondWireNeighbours(key)).toBe(firstWireNeighbours(key))
        expect(secondLampNeighbours(key)).toBe(firstLampNeighbours(key))
      }),
    ),
  )

  it.effect('rejects context factories requested for a copied world state', () =>
    runtimeProgram((runtime) =>
      Effect.gen(function* () {
        // BUG: a detached state object bypasses the runtime-owned geometry factory registry.
        const state = yield* redstoneWorldStateFor(runtime)
        const detachedState = { ...state }
        const factoryResult = yield* Effect.exit(redstonePowerTickContextFactoryFor(detachedState))
        expect(Exit.isFailure(factoryResult)).toBe(true)
        const result = yield* Effect.exit(redstonePowerTickContextFor(detachedState, new Map()))
        expect(Exit.isFailure(result)).toBe(true)
      }),
    ),
  )

  it.effect('fails closed for unknown positions and skips overflowing face offsets', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        // BUG: missing positions have no conductive support, and unsafe offsets cannot create support blocks.
        const dimension = dimensionId('overworld')
        const maximumX = Number.MAX_SAFE_INTEGER
        const maximumPosition = blockPosition(maximumX)
        const minimumY = Number.MIN_SAFE_INTEGER
        const unrepresentableWirePosition = blockPosition(0, minimumY)
        const unrepresentableWireKey = redstoneNodeId(dimension, unrepresentableWirePosition)
        const lookup = vi.fn((position: BlockPosition) => position.y >= minimumY)
        yield* runtime.syncSnapshot(snapshot('overworld', [
          { ...component(maximumX, 'lever'), position: maximumPosition },
          { kind: 'lever', active: true, position: blockPosition(-1, minimumY) },
          { kind: 'wire', position: unrepresentableWirePosition },
        ]), { isRedstoneConductiveAt: lookup })
        const state = yield* redstoneWorldStateFor(runtime)
        const { context } = yield* redstonePowerTickContextFor(state, new Map())
        const faceNeighboursOf = context.faceNeighboursOf
        const faceBlockNeighboursOf = context.faceBlockNeighboursOf
        const faceComponentNeighboursOf = context.faceComponentNeighboursOf
        const faceSupportBlockNeighbourOf = context.faceSupportBlockNeighbourOf
        const faceWireNeighboursOf = context.faceWireNeighboursOf
        const faceLampNeighboursOf = context.faceLampNeighboursOf
        const isRedstoneConductiveAt = context.isRedstoneConductiveAt
        if (!faceNeighboursOf || !faceBlockNeighboursOf || !faceComponentNeighboursOf ||
          !faceSupportBlockNeighbourOf ||
          !faceWireNeighboursOf || !faceLampNeighboursOf) {
          throw new Error('expected snapshot face partitions')
        }
        if (!isRedstoneConductiveAt) throw new Error('expected a conductivity lookup')
        const unknownKey = 'missing-position'
        const maximumKey = redstoneNodeId(dimension, maximumPosition)

        expect(faceNeighboursOf(unknownKey)).toStrictEqual([])
        expect(faceBlockNeighboursOf(unknownKey)).toStrictEqual([])
        expect(faceComponentNeighboursOf(unknownKey)).toStrictEqual([])
        expect(faceSupportBlockNeighbourOf(unknownKey)).toBeNull()
        expect(faceWireNeighboursOf(unknownKey)).toStrictEqual([])
        expect(faceLampNeighboursOf(unknownKey)).toStrictEqual([])
        expect(faceSupportBlockNeighbourOf(unrepresentableWireKey)).toBeNull()
        expect(isRedstoneConductiveAt(unknownKey)).toBe(false)
        expect(faceNeighboursOf(maximumKey)).toStrictEqual([
          redstoneNodeId(dimension, blockPosition(maximumX - 1)),
          redstoneNodeId(dimension, blockPosition(maximumX, 1)),
          redstoneNodeId(dimension, blockPosition(maximumX, -1)),
          redstoneNodeId(dimension, blockPosition(maximumX, 0, 1)),
          redstoneNodeId(dimension, blockPosition(maximumX, 0, -1)),
        ])
        expect(lookup).not.toHaveBeenCalled()
        yield* runPowerTick(stages)
        expect(lookup.mock.calls.some(([position]) => position.y === minimumY - 1)).toBe(false)
      }),
    ),
  )

  it.effect('does not treat a component under a powered wire as its solid support', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        // BUG: a component below dust is not a conductive block that can relay weak power.
        const supportPosition = blockPosition(0, -1, 0)
        const wirePosition = blockPosition(0, 0, 0)
        const dimension = dimensionId('overworld')
        const lookup = vi.fn((_position: BlockPosition) => true)
        yield* runtime.syncSnapshot(snapshot('overworld', [
          { kind: 'lever', active: true, position: supportPosition },
          { kind: 'wire', position: wirePosition },
        ]), { isRedstoneConductiveAt: lookup })
        const state = yield* redstoneWorldStateFor(runtime)
        const { context } = yield* redstonePowerTickContextFor(state, new Map())
        const wireKey = redstoneNodeId(dimension, wirePosition)

        expect(context.faceSupportBlockNeighbourOf?.(wireKey)).toBeNull()
        yield* runPowerTick(stages)

        expect((yield* Ref.get(state.power)).get(wireKey)).toBe(15)
        expect(lookup.mock.calls.some(([position]) =>
          position.x === supportPosition.x && position.y === supportPosition.y && position.z === supportPosition.z,
        )).toBe(false)
      }),
    ),
  )

  it.effect('does not append a prepared observation after recording is disabled', () =>
    runtimeProgram((runtime) =>
      Effect.gen(function* () {
        // BUG: an in-flight recorder context appends a tick after the user disables T03.
        yield* runtime.syncSnapshot(snapshot('overworld', [component(0, 'lever', { active: true })]))
        yield* setRedstoneObservationEnabled(runtime, true)
        const state = yield* redstoneWorldStateFor(runtime)
        const context = yield* redstonePowerTickContextFor(state, yield* Ref.get(state.blockPower))
        if (!context.captureProvenance) throw new Error('expected provenance context')
        const completed = advanceTimedCircuitWithProvenanceContext({
          board: yield* Ref.get(state.board),
          context: context.context,
          previous: yield* Ref.get(state.timedCircuit),
        })

        yield* setRedstoneObservationEnabled(runtime, false)
        yield* captureObservedTick(state, context, completed)

        expect(yield* redstoneTickObservationsFor(runtime)).toStrictEqual([])
      }),
    ),
  )

  it.effect('keeps provenance capture off until the internal switch is enabled', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        // This fails if an ordinary production tick builds provenance or stores an observation.
        const normalPropagation = vi.spyOn(powerGraph, 'propagateTick')
        const capturedPropagation = vi.spyOn(powerGraph, 'propagateTickWithProvenance')
        yield* runtime.syncSnapshot(snapshot('overworld', [component(0, 'lever', { active: true })]))
        yield* setRedstoneObservationEnabled(runtime, false)

        yield* runPowerTick(stages)
        expect(normalPropagation).toHaveBeenCalledTimes(1)
        expect(capturedPropagation).not.toHaveBeenCalled()
        expect(yield* redstoneTickObservationsFor(runtime)).toStrictEqual([])

        yield* setRedstoneObservationEnabled(runtime, true)
        yield* runPowerTick(stages)
        expect(normalPropagation).toHaveBeenCalledTimes(1)
        expect(capturedPropagation).toHaveBeenCalledTimes(1)
        expect(yield* redstoneTickObservationsFor(runtime)).toHaveLength(1)

        yield* setRedstoneObservationEnabled(runtime, false)
        yield* runPowerTick(stages)
        expect(normalPropagation).toHaveBeenCalledTimes(2)
        expect(capturedPropagation).toHaveBeenCalledTimes(1)
        expect(yield* redstoneTickObservationsFor(runtime)).toHaveLength(1)

        yield* setRedstoneObservationEnabled(runtime, true)
        yield* setRedstoneObservationEnabled(runtime, true)
        yield* runPowerTick(stages)
        expect(normalPropagation).toHaveBeenCalledTimes(2)
        expect(capturedPropagation).toHaveBeenCalledTimes(2)
        expect((yield* redstoneTickObservationsFor(runtime)).map(({ tick }) => tick)).toStrictEqual([2, 4])
      }),
    ),
  )

  it.effect('uses per-dimension conductivity and preserves omitted host metadata behavior', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        // BUG: solid conduction leaks across dimensions or becomes enabled without both optional host fields.
        const conductiveDimension = dimensionId('overworld')
        const nonConductiveDimension = dimensionId('nether')
        const withoutLookupDimension = dimensionId('end')
        const lookupConductive = vi.fn((position: BlockPosition) => position.x === 1 || position.x === 11)
        const lookupNonConductive = vi.fn(() => false)

        yield* runtime.syncSnapshot(snapshot('overworld', [
          component(0, 'lever', { active: true, strongPowerTo: blockPosition(1) }),
          component(2, 'wire'),
          component(10, 'lever', { active: true }),
          component(12, 'wire'),
          { ...component(5, 'torch'), position: blockPosition(5, 4) },
        ]), { isRedstoneConductiveAt: lookupConductive })
        yield* runtime.syncSnapshot(snapshot('nether', [
          component(0, 'lever', { active: true, strongPowerTo: blockPosition(1) }),
          component(2, 'wire'),
        ]), { isRedstoneConductiveAt: lookupNonConductive })
        yield* runtime.syncSnapshot(snapshot('end', [
          component(0, 'lever', { active: true, strongPowerTo: blockPosition(1) }),
          component(2, 'wire'),
        ]))
        yield* runPowerTick(stages)

        const state = yield* redstoneWorldStateFor(runtime)
        const power = yield* Ref.get(state.power)
        const board = yield* Ref.get(state.board)
        const conductiveWire = redstoneNodeId(conductiveDimension, blockPosition(2))
        const nonConductiveWire = redstoneNodeId(nonConductiveDimension, blockPosition(2))
        const withoutLookupWire = redstoneNodeId(withoutLookupDimension, blockPosition(2))
        const withoutTargetWire = redstoneNodeId(conductiveDimension, blockPosition(12))
        const torchKey = redstoneNodeId(conductiveDimension, blockPosition(5, 4))
        const torchStrongTarget = redstoneNodeId(conductiveDimension, blockPosition(5, 5))

        expect(power.get(conductiveWire)).toBe(15)
        expect(power.get(nonConductiveWire) ?? 0).toBe(0)
        expect(power.get(withoutLookupWire) ?? 0).toBe(0)
        expect(power.get(withoutTargetWire) ?? 0).toBe(0)
        expect(board.components.get(torchKey)?.strongPowerTo).toBe(torchStrongTarget)
        expect(lookupConductive).toHaveBeenCalled()
        expect(lookupNonConductive).toHaveBeenCalled()
      }),
    ),
  )

  it.effect('records provenance and runtime state for each enabled tick with power parity', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        // This fails if capture uses the wrong prior power or loses timed source outputs.
        const dimension = dimensionId('overworld')
        yield* runtime.syncSnapshot(snapshot('overworld', [
          component(0, 'lever', { active: true }),
          component(1, 'wire'),
          component(2, 'repeater', {
            delayTicks: NonNegativeTickCount(1),
            inputFrom: blockPosition(1),
            outputTo: blockPosition(3),
          }),
          component(3, 'wire'),
          component(10, 'button', { pulseTicks: NonNegativeTickCount(3) }),
          component(11, 'wire'),
          component(20, 'torch'),
          component(21, 'wire'),
          component(29, 'lever', { active: true }),
          component(30, 'comparator', { inputFrom: blockPosition(29), outputTo: blockPosition(31) }),
          component(31, 'wire'),
        ]))
        yield* runtime.pressButton(dimension, blockPosition(10))
        yield* setRedstoneObservationEnabled(runtime, true)
        const state = yield* redstoneWorldStateFor(runtime)

        for (let index = 0; index < 3; index += 1) {
          yield* runPowerTick(stages)
          const actualPower = yield* Ref.get(state.power)
          const history = yield* redstoneTickObservationsFor(runtime)
          const recorded = history.at(-1)
          expect(recorded).toBeDefined()
          expect(recorded?.tick).toBe(index + 1)
          expect(recorded?.power).toStrictEqual(actualPower)
          expect(recorded?.blockPower).toStrictEqual(yield* Ref.get(state.blockPower))
          expect(recorded?.timedCircuit).toStrictEqual(yield* Ref.get(state.timedCircuit))
          expect(recorded?.dimensions).toStrictEqual(yield* Ref.get(state.dimensions))
        }

        const history = yield* redstoneTickObservationsFor(runtime)
        const repeaterKey = redstoneNodeId(dimension, blockPosition(2))
        const buttonKey = redstoneNodeId(dimension, blockPosition(10))
        const torchKey = redstoneNodeId(dimension, blockPosition(20))
        const comparatorWireKey = redstoneNodeId(dimension, blockPosition(31))
        expect(history).toHaveLength(3)
        expect(history[0]?.provenance.get(redstoneNodeId(dimension, blockPosition(1)))?.[0]?.source)
          .toBe(redstoneNodeId(dimension, blockPosition(0)))
        expect(history[1]?.provenance.get(repeaterKey)?.[0]?.source).toBe(repeaterKey)
        expect(history[0]?.provenance.get(buttonKey)?.[0]?.source).toBe(buttonKey)
        expect(history[0]?.provenance.get(torchKey)?.[0]?.source).toBe(torchKey)
        expect(history[1]?.provenance.get(comparatorWireKey)?.[0]?.source)
          .toBe(redstoneNodeId(dimension, blockPosition(30)))
        expect(history[1]?.timedCircuit.repeaters.get(repeaterKey)?.output).toBe(true)
        expect(history[0]?.timedCircuit.buttons.get(buttonKey)?.remainingTicks).toBe(2)
      }),
    ),
  )

  it.effect('records detached block channels and only queried conductivity answers', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        // BUG: T03 retains host callback data, records unqueried cells, or aliases mutable block-channel maps.
        const dimension = dimensionId('overworld')
        const queriedPositions: Array<BlockPosition> = []
        const lookup = vi.fn((position: BlockPosition) => {
          queriedPositions.push(position)
          return position.x === 1
        })
        yield* runtime.syncSnapshot(snapshot('overworld', [
          component(0, 'lever', { active: true, strongPowerTo: blockPosition(1) }),
          component(2, 'wire'),
        ]), { isRedstoneConductiveAt: lookup })
        yield* setRedstoneObservationEnabled(runtime, true)
        yield* runPowerTick(stages)

        const state = yield* redstoneWorldStateFor(runtime)
        const recorded = (yield* redstoneTickObservationsFor(runtime))[0]
        if (!recorded) throw new Error('expected a recorded tick')
        const solidKey = redstoneNodeId(dimension, blockPosition(1))
        const expectedQueryKeys = new Set(queriedPositions.map((position) => redstoneNodeId(dimension, position)))
        const lookupReferences = new Set<object>([lookup, ...queriedPositions])
        const blockPower = recorded.blockPower
        const conductivityAnswers = recorded.conductivityAnswers
        if (!(blockPower instanceof Map)) throw new Error('expected an isolated block-power map')
        if (!(conductivityAnswers instanceof Map)) throw new Error('expected an isolated conductivity-answer map')
        const blockLevels = blockPower.get(solidKey)
        if (!blockLevels) throw new Error('expected strong block power at the lever target')

        expect(blockPower).toStrictEqual(yield* Ref.get(state.blockPower))
        expect(blockLevels).toStrictEqual({ strongLevel: 15, weakLevel: 15 })
        expect(conductivityAnswers.get(solidKey)).toBe(true)
        expect(new Set(conductivityAnswers.keys())).toStrictEqual(expectedQueryKeys)
        expect(containsReference(recorded, lookupReferences)).toBe(false)

        Object.assign(blockLevels, { strongLevel: 0, weakLevel: 0 })
        blockPower.clear()
        conductivityAnswers.clear()
        const copiedAgain = (yield* redstoneTickObservationsFor(runtime))[0]
        expect(copiedAgain?.blockPower.get(solidKey)).toStrictEqual({ strongLevel: 15, weakLevel: 15 })
        expect(copiedAgain?.conductivityAnswers.get(solidKey)).toBe(true)
      }),
    ),
  )

  it.effect('retains only the newest fixed-capacity tick history', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        // This fails if a long observation session retains every tick indefinitely or evicts the newest.
        yield* runtime.syncSnapshot(snapshot('overworld', [component(0, 'lever', { active: true })]))
        yield* setRedstoneObservationEnabled(runtime, true)
        const submittedTicks = REDSTONE_OBSERVATION_HISTORY_LIMIT + 5
        for (let index = 0; index < submittedTicks; index += 1) {
          yield* runPowerTick(stages)
        }

        const history = yield* redstoneTickObservationsFor(runtime)
        expect(history).toHaveLength(REDSTONE_OBSERVATION_HISTORY_LIMIT)
        expect(history.map(({ tick }) => tick)).toStrictEqual(
          Array.from({ length: REDSTONE_OBSERVATION_HISTORY_LIMIT }, (_, index) => index + 6),
        )
      }),
    ),
  )

  it.effect('keeps observation reads isolated after input, tick and event restore', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        // This fails if reading a frame or its history consumes an input, timer, event, or captured record.
        const slot = Schema.decodeUnknownSync(ContainerSlotSchema)({ count: 32, maxStack: 64 })
        yield* runtime.syncSnapshot(snapshot('overworld', [
          component(0, 'hopper', { containerSlots: [slot] }),
          component(2, 'button', { pulseTicks: NonNegativeTickCount(4) }),
          component(4, 'torch'),
          component(6, 'repeater', {
            delayTicks: NonNegativeTickCount(2),
            inputFrom: blockPosition(5),
            outputTo: blockPosition(7),
            sideInputs: [blockPosition(6, 0, 1)],
          }),
        ]))
        yield* setRedstoneObservationEnabled(runtime, true)
        const state = yield* redstoneWorldStateFor(runtime)

        const assertReadsDoNotWrite = Effect.gen(function* () {
          const beforeState = structuredClone(yield* runtimeStateValues(state))
          const beforeHistory = structuredClone(yield* redstoneTickObservationsFor(runtime))
          yield* observeRedstoneFrame(runtime)
          yield* redstoneTickObservationsFor(runtime)
          expect(structuredClone(yield* runtimeStateValues(state))).toStrictEqual(beforeState)
          expect(structuredClone(yield* redstoneTickObservationsFor(runtime))).toStrictEqual(beforeHistory)
        })

        yield* assertReadsDoNotWrite
        yield* runtime.pressButton(dimensionId('overworld'), blockPosition(2))
        yield* assertReadsDoNotWrite
        yield* runPowerTick(stages)
        yield* runEffectsStage(stages)
        yield* assertReadsDoNotWrite
        yield* runtime.restoreEvents({
          hopper: [],
          lamp: [{ dimension: dimensionId('overworld'), lit: true, position: blockPosition(5) }],
          piston: [],
          powered: [],
          trigger: [],
        })
        yield* assertReadsDoNotWrite

        const first = yield* observeRedstoneFrame(runtime)
        const firstHopper = first.dimensions[0]?.cells.find((cell) => cell.kind === 'hopper')
        const firstTorch = first.dimensions[0]?.cells.find((cell) => cell.kind === 'torch')
        const firstRepeater = first.dimensions[0]?.cells.find((cell) => cell.kind === 'repeater')
        expect(firstHopper?.dynamicState.containerSlots).toStrictEqual([slot])
        expect(firstTorch?.dynamicState.timers.torch).toStrictEqual({
          burnoutRemainingTicks: 0,
          output: true,
          recentOffTicks: [],
        })
        expect(firstRepeater?.dynamicState.timers.repeater).toStrictEqual({ output: false, remainingTicks: 0 })
        const second = yield* observeRedstoneFrame(runtime)
        const secondHopper = second.dimensions[0]?.cells.find((cell) => cell.kind === 'hopper')
        const secondTorch = second.dimensions[0]?.cells.find((cell) => cell.kind === 'torch')
        expect(secondHopper?.dynamicState.containerSlots?.[0]).not.toBe(firstHopper?.dynamicState.containerSlots?.[0])
        expect(secondTorch?.dynamicState.timers.torch?.recentOffTicks)
          .not.toBe(firstTorch?.dynamicState.timers.torch?.recentOffTicks)

        const firstHistory = yield* redstoneTickObservationsFor(runtime)
        const historyBeforeMutation = structuredClone(firstHistory)
        const firstPower = firstHistory[0]?.power
        if (!(firstPower instanceof Map)) {
          throw new Error('expected an isolated mutable power map')
        }
        firstPower.clear()
        const secondHistory = yield* redstoneTickObservationsFor(runtime)
        expect(secondHistory).toStrictEqual(historyBeforeMutation)
      }),
    ),
  )
})
