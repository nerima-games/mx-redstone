import { Context, Effect, Layer, Ref } from 'effect'
import type { ComparatorMode } from '../domain/comparator'
import type { PositionKey } from '../domain/position-key'
import type {
  CircuitBoard,
  Component,
  ComponentKind,
  PowerLevel,
  PowerMap,
} from '../domain/power-graph'
import { emptyPowerMap, isLit } from '../domain/power-graph'

export type RedstonePosition = {
  readonly x: number
  readonly y: number
  readonly z: number
}

export type RedstoneComponentSnapshot = {
  readonly position: RedstonePosition
  readonly kind: ComponentKind
  readonly active?: boolean
  readonly emits?: PowerLevel
  readonly invertedBy?: RedstonePosition
  readonly inputFrom?: RedstonePosition
  readonly sideInputs?: ReadonlyArray<RedstonePosition>
  readonly mode?: ComparatorMode
  readonly containerSignal?: PowerLevel
  readonly outputTo?: RedstonePosition
}

/** A complete replacement snapshot for one dimension. */
export type RedstoneWorldSnapshot = {
  readonly dimension: string
  readonly components: ReadonlyArray<RedstoneComponentSnapshot>
}

export type LampTransition = {
  readonly dimension: string
  readonly position: RedstonePosition
  readonly lit: boolean
}

type DimensionSnapshot = ReadonlyMap<PositionKey, RedstoneComponentSnapshot>

type ObservedLamp = LampTransition

export type RedstoneWorldState = {
  readonly dimensions: Ref.Ref<ReadonlyMap<string, DimensionSnapshot>>
  readonly board: Ref.Ref<CircuitBoard>
  readonly power: Ref.Ref<PowerMap>
  readonly observedLamps: Ref.Ref<ReadonlyMap<PositionKey, ObservedLamp>>
  readonly pendingLampTransitions: Ref.Ref<ReadonlyArray<LampTransition>>
  readonly tickAccumulatorSecs: Ref.Ref<number>
  readonly tickCount: Ref.Ref<number>
}

export type RedstoneWorldRuntimeService = {
  /** Replaces only the named dimension; snapshots of other dimensions remain installed. */
  readonly syncSnapshot: (snapshot: RedstoneWorldSnapshot) => Effect.Effect<void>
  /** Atomically returns and clears transitions produced by `redstone:effects`. */
  readonly drainLampTransitions: Effect.Effect<ReadonlyArray<LampTransition>>
}

export class RedstoneWorldRuntime extends Context.Tag(
  '@nerima-games/mx-redstone/RedstoneWorldRuntime',
)<RedstoneWorldRuntime, RedstoneWorldRuntimeService>() {}

const copyPosition = ({ x, y, z }: RedstonePosition): RedstonePosition => ({ x, y, z })

/** Stable and collision-safe across dimensions. */
export const redstoneNodeId = (dimension: string, position: RedstonePosition): PositionKey =>
  JSON.stringify([dimension, position.x, position.y, position.z])

const componentAt = (
  dimension: string,
  component: RedstoneComponentSnapshot,
): Component => ({
  kind: component.kind,
  ...(component.active === undefined ? {} : { active: component.active }),
  ...(component.emits === undefined ? {} : { emits: component.emits }),
  ...(component.invertedBy === undefined
    ? {}
    : { invertedBy: redstoneNodeId(dimension, component.invertedBy) }),
  ...(component.inputFrom === undefined
    ? {}
    : { inputFrom: redstoneNodeId(dimension, component.inputFrom) }),
  ...(component.sideInputs === undefined
    ? {}
    : { sideInputs: component.sideInputs.map((position) => redstoneNodeId(dimension, position)) }),
  ...(component.mode === undefined ? {} : { mode: component.mode }),
  ...(component.containerSignal === undefined
    ? {}
    : { containerSignal: component.containerSignal }),
  ...(component.outputTo === undefined
    ? {}
    : { outputTo: redstoneNodeId(dimension, component.outputTo) }),
})

const FACE_OFFSETS: ReadonlyArray<RedstonePosition> = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
]

export const circuitBoardFromSnapshots = (
  dimensions: ReadonlyMap<string, DimensionSnapshot>,
): CircuitBoard => {
  const components = new Map<PositionKey, Component>()
  const adjacency = new Map<PositionKey, ReadonlyArray<PositionKey>>()

  for (const [dimension, snapshot] of dimensions) {
    for (const [nodeId, component] of snapshot) {
      components.set(nodeId, componentAt(dimension, component))
      const neighbours: Array<PositionKey> = []
      for (const offset of FACE_OFFSETS) {
        const neighbour = redstoneNodeId(dimension, {
          x: component.position.x + offset.x,
          y: component.position.y + offset.y,
          z: component.position.z + offset.z,
        })
        if (snapshot.has(neighbour)) {
          neighbours.push(neighbour)
        }
      }
      adjacency.set(nodeId, neighbours)
    }
  }

  return { components, adjacency }
}

export const makeRedstoneWorldState: Effect.Effect<RedstoneWorldState> = Effect.gen(function* () {
  const dimensions = yield* Ref.make<ReadonlyMap<string, DimensionSnapshot>>(new Map())
  const board = yield* Ref.make<CircuitBoard>({ components: new Map(), adjacency: new Map() })
  const power = yield* Ref.make<PowerMap>(emptyPowerMap)
  const observedLamps = yield* Ref.make<ReadonlyMap<PositionKey, ObservedLamp>>(new Map())
  const pendingLampTransitions = yield* Ref.make<ReadonlyArray<LampTransition>>([])
  const tickAccumulatorSecs = yield* Ref.make(0)
  const tickCount = yield* Ref.make(0)
  return {
    dimensions,
    board,
    power,
    observedLamps,
    pendingLampTransitions,
    tickAccumulatorSecs,
    tickCount,
  }
})

const snapshotMap = (snapshot: RedstoneWorldSnapshot): DimensionSnapshot => {
  const components = new Map<PositionKey, RedstoneComponentSnapshot>()
  for (const component of snapshot.components) {
    const position = copyPosition(component.position)
    components.set(redstoneNodeId(snapshot.dimension, position), { ...component, position })
  }
  return components
}

export const syncRedstoneSnapshot = (
  state: RedstoneWorldState,
  snapshot: RedstoneWorldSnapshot,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const current = yield* Ref.get(state.dimensions)
    const next = new Map(current)
    next.set(snapshot.dimension, snapshotMap(snapshot))
    yield* Ref.set(state.dimensions, next)
    yield* Ref.set(state.board, circuitBoardFromSnapshots(next))
  })

/** Computes changed lamps and records them for the host-facing drain. */
export const collectLampTransitions = (state: RedstoneWorldState): Effect.Effect<void> =>
  Effect.gen(function* () {
    const board = yield* Ref.get(state.board)
    const power = yield* Ref.get(state.power)
    const dimensions = yield* Ref.get(state.dimensions)
    const previous = yield* Ref.get(state.observedLamps)
    const current = new Map<PositionKey, ObservedLamp>()
    const changed: Array<LampTransition> = []

    for (const [dimension, snapshot] of dimensions) {
      for (const [nodeId, component] of snapshot) {
        if (component.kind !== 'lamp') continue
        const lamp: LampTransition = {
          dimension,
          position: copyPosition(component.position),
          lit: isLit(board, power, nodeId),
        }
        current.set(nodeId, lamp)
        if ((previous.get(nodeId)?.lit ?? false) !== lamp.lit) changed.push(lamp)
      }
    }

    for (const [nodeId, lamp] of previous) {
      if (!current.has(nodeId) && lamp.lit) changed.push({ ...lamp, lit: false })
    }

    yield* Ref.set(state.observedLamps, current)
    if (changed.length > 0) {
      yield* Ref.update(state.pendingLampTransitions, (pending) => [...pending, ...changed])
    }
  })

const runtimeStates = new WeakMap<RedstoneWorldRuntimeService, RedstoneWorldState>()

export const redstoneWorldStateFor = (runtime: RedstoneWorldRuntimeService): RedstoneWorldState => {
  const state = runtimeStates.get(runtime)
  if (state === undefined) {
    throw new Error('RedstoneWorldRuntime was not created by makeRedstoneWorldRuntime')
  }
  return state
}

export const makeRedstoneWorldRuntime: Effect.Effect<RedstoneWorldRuntimeService> = Effect.gen(function* () {
  const state = yield* makeRedstoneWorldState
  const runtime: RedstoneWorldRuntimeService = {
    syncSnapshot: (snapshot) => syncRedstoneSnapshot(state, snapshot),
    drainLampTransitions: Ref.getAndSet(state.pendingLampTransitions, []),
  }
  runtimeStates.set(runtime, state)
  return runtime
})

export const RedstoneWorldRuntimeLayer: Layer.Layer<RedstoneWorldRuntime> = Layer.effect(
  RedstoneWorldRuntime,
  makeRedstoneWorldRuntime,
)
