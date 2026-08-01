import { Context, Effect, Layer, Ref } from 'effect'
import type { ComparatorMode } from '../domain/comparator'
import type { PositionKey } from '../domain/position-key'
import type { PistonFacing, PistonKind, PistonState, PistonTransitionRequest } from '../domain/piston'
import type {
  CircuitBoard,
  Component,
  ComponentKind,
  PowerLevel,
  PowerMap,
} from '../domain/power-graph'
import { emptyPowerMap, isLit, isPowered } from '../domain/power-graph'
import {
  emptyTimedCircuitState,
  type TimedCircuitState,
} from '../domain/timed-power-graph'

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
  readonly delayTicks?: number
  readonly pulseTicks?: number
  readonly invertedBy?: RedstonePosition
  readonly inputFrom?: RedstonePosition
  readonly sideInputs?: ReadonlyArray<RedstonePosition>
  readonly mode?: ComparatorMode
  readonly containerSignal?: PowerLevel
  readonly outputTo?: RedstonePosition
  readonly pistonFacing?: PistonFacing
  readonly pistonKind?: PistonKind
  readonly pistonState?: PistonState
  readonly powered?: boolean
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

export type PoweredPistonTransition = PistonTransitionRequest & {
  readonly dimension: string
}

export type TriggeredComponentKind = 'dispenser' | 'dropper' | 'note-block'

export type RedstoneTriggerEvent = {
  readonly dimension: string
  readonly position: RedstonePosition
  readonly kind: TriggeredComponentKind
}

export type PoweredComponentKind = 'powered-rail' | 'door' | 'trapdoor'

export type PoweredComponentTransition = {
  readonly dimension: string
  readonly position: RedstonePosition
  readonly kind: PoweredComponentKind
  readonly powered: boolean
}

type DimensionSnapshot = ReadonlyMap<PositionKey, RedstoneComponentSnapshot>

type ObservedLamp = LampTransition

export type RedstoneWorldState = {
  readonly dimensions: Ref.Ref<ReadonlyMap<string, DimensionSnapshot>>
  readonly board: Ref.Ref<CircuitBoard>
  readonly power: Ref.Ref<PowerMap>
  readonly timedCircuit: Ref.Ref<TimedCircuitState>
  readonly pendingButtonPresses: Ref.Ref<ReadonlySet<PositionKey>>
  readonly observedLamps: Ref.Ref<ReadonlyMap<PositionKey, ObservedLamp>>
  readonly pendingLampTransitions: Ref.Ref<ReadonlyArray<LampTransition>>
  readonly observedPistonStates: Ref.Ref<ReadonlyMap<PositionKey, PistonState>>
  readonly pendingPistonTransitions: Ref.Ref<ReadonlyArray<PoweredPistonTransition>>
  readonly observedTriggerPower: Ref.Ref<ReadonlyMap<PositionKey, boolean>>
  readonly pendingTriggerEvents: Ref.Ref<ReadonlyArray<RedstoneTriggerEvent>>
  readonly observedPoweredComponents: Ref.Ref<ReadonlyMap<PositionKey, boolean>>
  readonly pendingPoweredComponentTransitions: Ref.Ref<ReadonlyArray<PoweredComponentTransition>>
  readonly tickAccumulatorSecs: Ref.Ref<number>
  readonly tickCount: Ref.Ref<number>
}

export type RedstoneWorldRuntimeService = {
  /** Replaces only the named dimension; snapshots of other dimensions remain installed. */
  readonly syncSnapshot: (snapshot: RedstoneWorldSnapshot) => Effect.Effect<void>
  /** Starts or restarts this button's configured pulse on the next redstone tick. */
  readonly pressButton: (dimension: string, position: RedstonePosition) => Effect.Effect<void>
  /** Atomically returns and clears transitions produced by `redstone:effects`. */
  readonly drainLampTransitions: Effect.Effect<ReadonlyArray<LampTransition>>
  /** Atomically returns and clears power-driven requests for host planning/application. */
  readonly drainPistonTransitions: Effect.Effect<ReadonlyArray<PoweredPistonTransition>>
  /** Returns rising-edge actions for dispensers, droppers, and note blocks. */
  readonly drainTriggerEvents: Effect.Effect<ReadonlyArray<RedstoneTriggerEvent>>
  /** Returns power-state changes for rails, doors, and trapdoors. */
  readonly drainPoweredComponentTransitions: Effect.Effect<ReadonlyArray<PoweredComponentTransition>>
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
  ...(component.delayTicks === undefined ? {} : { delayTicks: component.delayTicks }),
  ...(component.pulseTicks === undefined ? {} : { pulseTicks: component.pulseTicks }),
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
  const timedCircuit = yield* Ref.make<TimedCircuitState>(emptyTimedCircuitState)
  const pendingButtonPresses = yield* Ref.make<ReadonlySet<PositionKey>>(new Set())
  const observedLamps = yield* Ref.make<ReadonlyMap<PositionKey, ObservedLamp>>(new Map())
  const pendingLampTransitions = yield* Ref.make<ReadonlyArray<LampTransition>>([])
  const observedPistonStates = yield* Ref.make<ReadonlyMap<PositionKey, PistonState>>(new Map())
  const pendingPistonTransitions = yield* Ref.make<ReadonlyArray<PoweredPistonTransition>>([])
  const observedTriggerPower = yield* Ref.make<ReadonlyMap<PositionKey, boolean>>(new Map())
  const pendingTriggerEvents = yield* Ref.make<ReadonlyArray<RedstoneTriggerEvent>>([])
  const observedPoweredComponents = yield* Ref.make<ReadonlyMap<PositionKey, boolean>>(new Map())
  const pendingPoweredComponentTransitions = yield* Ref.make<ReadonlyArray<PoweredComponentTransition>>([])
  const tickAccumulatorSecs = yield* Ref.make(0)
  const tickCount = yield* Ref.make(0)
  return {
    dimensions,
    board,
    power,
    timedCircuit,
    pendingButtonPresses,
    observedLamps,
    pendingLampTransitions,
    observedPistonStates,
    pendingPistonTransitions,
    observedTriggerPower,
    pendingTriggerEvents,
    observedPoweredComponents,
    pendingPoweredComponentTransitions,
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

/** Emits one request when a piston's desired powered state changes. */
export const collectPistonTransitions = (state: RedstoneWorldState): Effect.Effect<void> =>
  Effect.gen(function* () {
    const board = yield* Ref.get(state.board)
    const power = yield* Ref.get(state.power)
    const dimensions = yield* Ref.get(state.dimensions)
    const previous = yield* Ref.get(state.observedPistonStates)
    const current = new Map<PositionKey, PistonState>()
    const changed: Array<PoweredPistonTransition> = []

    for (const [dimension, snapshot] of dimensions) {
      for (const [nodeId, component] of snapshot) {
        if (component.kind !== 'piston') continue
        const powered = isPowered(board, power, nodeId)
        const desired: PistonState = powered ? 'extended' : 'retracted'
        const observed = previous.get(nodeId) ?? component.pistonState ?? 'retracted'
        current.set(nodeId, desired)
        if (observed !== desired) {
          changed.push({
            dimension,
            piston: copyPosition(component.position),
            facing: component.pistonFacing ?? 'north',
            kind: component.pistonKind ?? 'normal',
            state: observed,
            powered,
          })
        }
      }
    }

    yield* Ref.set(state.observedPistonStates, current)
    if (changed.length > 0) {
      yield* Ref.update(state.pendingPistonTransitions, (pending) => [...pending, ...changed])
    }
  })

const TRIGGERED_KINDS = new Set<ComponentKind>(['dispenser', 'dropper', 'note-block'])
const POWERED_KINDS = new Set<ComponentKind>(['powered-rail', 'door', 'trapdoor'])

/** Emits deterministic rising-edge actions for one-shot powered components. */
export const collectTriggerEvents = (state: RedstoneWorldState): Effect.Effect<void> =>
  Effect.gen(function* () {
    const board = yield* Ref.get(state.board)
    const power = yield* Ref.get(state.power)
    const dimensions = yield* Ref.get(state.dimensions)
    const previous = yield* Ref.get(state.observedTriggerPower)
    const current = new Map<PositionKey, boolean>()
    const triggered: Array<[PositionKey, RedstoneTriggerEvent]> = []

    for (const [dimension, snapshot] of dimensions) {
      for (const [nodeId, component] of snapshot) {
        if (!TRIGGERED_KINDS.has(component.kind)) continue
        const powered = isPowered(board, power, nodeId)
        current.set(nodeId, powered)
        if (!(previous.get(nodeId) ?? false) && powered) {
          triggered.push([nodeId, {
            dimension,
            position: copyPosition(component.position),
            kind: component.kind as TriggeredComponentKind,
          }])
        }
      }
    }

    triggered.sort(([left], [right]) => left.localeCompare(right))
    yield* Ref.set(state.observedTriggerPower, current)
    if (triggered.length > 0) {
      yield* Ref.update(state.pendingTriggerEvents, (pending) => [
        ...pending,
        ...triggered.map(([, event]) => event),
      ])
    }
  })

/** Emits deterministic state transitions for continuously powered components. */
export const collectPoweredComponentTransitions = (state: RedstoneWorldState): Effect.Effect<void> =>
  Effect.gen(function* () {
    const board = yield* Ref.get(state.board)
    const power = yield* Ref.get(state.power)
    const dimensions = yield* Ref.get(state.dimensions)
    const previous = yield* Ref.get(state.observedPoweredComponents)
    const current = new Map<PositionKey, boolean>()
    const changed: Array<[PositionKey, PoweredComponentTransition]> = []

    for (const [dimension, snapshot] of dimensions) {
      for (const [nodeId, component] of snapshot) {
        if (!POWERED_KINDS.has(component.kind)) continue
        const powered = isPowered(board, power, nodeId)
        const observed = previous.get(nodeId) ?? component.powered ?? false
        current.set(nodeId, powered)
        if (observed !== powered) {
          changed.push([nodeId, {
            dimension,
            position: copyPosition(component.position),
            kind: component.kind as PoweredComponentKind,
            powered,
          }])
        }
      }
    }

    changed.sort(([left], [right]) => left.localeCompare(right))
    yield* Ref.set(state.observedPoweredComponents, current)
    if (changed.length > 0) {
      yield* Ref.update(state.pendingPoweredComponentTransitions, (pending) => [
        ...pending,
        ...changed.map(([, transition]) => transition),
      ])
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
    pressButton: (dimension, position) =>
      Ref.update(state.pendingButtonPresses, (pending) => {
        const next = new Set(pending)
        next.add(redstoneNodeId(dimension, position))
        return next
      }),
    drainLampTransitions: Ref.getAndSet(state.pendingLampTransitions, []),
    drainPistonTransitions: Ref.getAndSet(state.pendingPistonTransitions, []),
    drainTriggerEvents: Ref.getAndSet(state.pendingTriggerEvents, []),
    drainPoweredComponentTransitions: Ref.getAndSet(state.pendingPoweredComponentTransitions, []),
  }
  runtimeStates.set(runtime, state)
  return runtime
})

export const RedstoneWorldRuntimeLayer: Layer.Layer<RedstoneWorldRuntime> = Layer.effect(
  RedstoneWorldRuntime,
  makeRedstoneWorldRuntime,
)
