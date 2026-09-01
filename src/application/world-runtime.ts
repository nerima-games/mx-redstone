import {
  type CircuitBoard,
  type Component,
  type ComponentKind,
  type PowerLevel,
  type PowerMap,
  emptyPowerMap,
  isLit,
  isPowered,
} from '../domain/power-graph.js'
import { type ComparatorMode, type ContainerSlot, containerSignalStrength } from '../domain/comparator.js'
import { Context, Effect, Layer, Ref } from 'effect'
import type { PistonFacing, PistonKind, PistonState, PistonTransitionRequest } from '../domain/piston.js'
import {
  type TimedCircuitState,
  emptyTimedCircuitState,
} from '../domain/power-timing.js'
import type { PositionKey } from '../domain/position-key.js'
import { hopperTransferDue } from '../domain/hopper.js'

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
  readonly containerSlots?: ReadonlyArray<ContainerSlot>
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

export type HopperTransferEvent = {
  readonly dimension: string
  readonly position: RedstonePosition
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
  readonly hopperTicksSinceTransfer: Ref.Ref<ReadonlyMap<PositionKey, number>>
  readonly pendingHopperTransferEvents: Ref.Ref<ReadonlyArray<HopperTransferEvent>>
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
  /** Returns due, unlocked hopper transfer requests for host application. */
  readonly drainHopperTransferEvents: Effect.Effect<ReadonlyArray<HopperTransferEvent>>
  /** Returns power-state changes for rails, doors, and trapdoors. */
  readonly drainPoweredComponentTransitions: Effect.Effect<ReadonlyArray<PoweredComponentTransition>>
}

/**
 * `Context.Tag` is an Effect factory, not a constructor, so it is invoked without `new` even
 * though its name is capitalized; aliasing it to a lower-case binding keeps the call site
 * itself unambiguous to `new-cap` without changing what is called or how.
 *
 * The intermediate `RedstoneWorldRuntimeBase` binding — with an explicit
 * `Context.TagClass` annotation — is required by `isolatedDeclarations`: an
 * `extends` clause must be a bare reference, not an invoked expression.
 */
const makeContextTag = Context.Tag

const RedstoneWorldRuntimeBase: Context.TagClass<
  RedstoneWorldRuntime,
  '@nerima-games/mx-redstone/RedstoneWorldRuntime',
  RedstoneWorldRuntimeService
> = makeContextTag('@nerima-games/mx-redstone/RedstoneWorldRuntime')<RedstoneWorldRuntime, RedstoneWorldRuntimeService>()

export class RedstoneWorldRuntime extends RedstoneWorldRuntimeBase {}

const copyPosition = ({ x, y, z }: RedstonePosition): RedstonePosition => ({ x, y, z })

/** Stable and collision-safe across dimensions. */
export const redstoneNodeId = (dimension: string, position: RedstonePosition): PositionKey =>
  JSON.stringify([dimension, position.x, position.y, position.z])

/** Includes `key` only when `value` is present, so omitted optional fields stay omitted
 * rather than becoming an explicit `key: undefined` in the constructed object. */
const withOptional = <Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): Partial<Record<Key, Value>> => {
  if (typeof value === 'undefined') {
    return {}
  }
  return { [key]: value } as Partial<Record<Key, Value>>
}

/** Includes `key: project(value)` only when `value` is present — the mapped counterpart of
 * `withOptional`, for optional fields that need a transform (e.g. position -> node id). */
const withOptionalMapped = <Key extends string, Value, Projected>(
  key: Key,
  value: Value | undefined,
  project: (value: Value) => Projected,
): Partial<Record<Key, Projected>> => {
  if (typeof value === 'undefined') {
    return {}
  }
  return { [key]: project(value) } as Partial<Record<Key, Projected>>
}

/** An explicit `containerSignal` wins; otherwise it is derived from `containerSlots` when any
 * are present. Split out because it is the one optional field with a fallback source. */
const withOptionalContainerSignal = (
  component: RedstoneComponentSnapshot,
): Partial<Record<'containerSignal', PowerLevel>> => {
  if (typeof component.containerSignal !== 'undefined') {
    return { containerSignal: component.containerSignal }
  }
  return withOptionalMapped('containerSignal', component.containerSlots, containerSignalStrength)
}

const componentAt = (
  dimension: string,
  component: RedstoneComponentSnapshot,
): Component => {
  const positionToNodeId = (position: RedstonePosition): PositionKey => redstoneNodeId(dimension, position)
  return {
    kind: component.kind,
    ...withOptional('active', component.active),
    ...withOptional('emits', component.emits),
    ...withOptional('delayTicks', component.delayTicks),
    ...withOptional('pulseTicks', component.pulseTicks),
    ...withOptionalMapped('invertedBy', component.invertedBy, positionToNodeId),
    ...withOptionalMapped('inputFrom', component.inputFrom, positionToNodeId),
    ...withOptionalMapped('sideInputs', component.sideInputs, (positions) => positions.map(positionToNodeId)),
    ...withOptional('mode', component.mode),
    ...withOptionalContainerSignal(component),
    ...withOptionalMapped('outputTo', component.outputTo, positionToNodeId),
  }
}

const FACE_OFFSETS: ReadonlyArray<RedstonePosition> = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
]

/** One component, tagged with the dimension and node id it was read from — the flattened
 * unit every `collect*` pass and `circuitBoardFromSnapshots` iterate over. */
type SnapshotEntry = {
  readonly component: RedstoneComponentSnapshot
  readonly dimension: string
  readonly nodeId: PositionKey
}

const flattenSnapshotEntries = (
  dimensions: ReadonlyMap<string, DimensionSnapshot>,
): ReadonlyArray<SnapshotEntry> => {
  const entries: Array<SnapshotEntry> = []
  for (const [dimension, snapshot] of dimensions) {
    for (const [nodeId, component] of snapshot) {
      entries.push({ component, dimension, nodeId })
    }
  }
  return entries
}

/** `board`/`power` travel together everywhere a `collect*` pass needs to ask the power
 * graph a question, so they are threaded as one reader instead of two positional params. */
type CircuitReadout = {
  readonly board: CircuitBoard
  readonly power: PowerMap
}

type CircuitBoardAccumulator = {
  readonly adjacency: Map<PositionKey, ReadonlyArray<PositionKey>>
  readonly componentKeysByKind: Map<ComponentKind, Array<PositionKey>>
  readonly components: Map<PositionKey, Component>
}

const neighboursOf = (
  dimension: string,
  component: RedstoneComponentSnapshot,
  allNodeIds: ReadonlySet<PositionKey>,
): ReadonlyArray<PositionKey> => {
  const neighbours: Array<PositionKey> = []
  for (const offset of FACE_OFFSETS) {
    const neighbour = redstoneNodeId(dimension, {
      x: component.position.x + offset.x,
      y: component.position.y + offset.y,
      z: component.position.z + offset.z,
    })
    if (allNodeIds.has(neighbour)) {
      neighbours.push(neighbour)
    }
  }
  return neighbours
}

/**
 * A node id already encodes its dimension (`redstoneNodeId` stringifies `[dimension, x, y, z]`),
 * so membership in the global set of all node ids is equivalent to membership in just this
 * component's own dimension snapshot — no need to carry the per-dimension snapshot around too.
 */
const indexComponent = (
  accumulator: CircuitBoardAccumulator,
  entry: SnapshotEntry,
  allNodeIds: ReadonlySet<PositionKey>,
): void => {
  const { component, dimension, nodeId } = entry
  accumulator.components.set(nodeId, componentAt(dimension, component))
  const indexedKeys = accumulator.componentKeysByKind.get(component.kind) ?? []
  indexedKeys.push(nodeId)
  accumulator.componentKeysByKind.set(component.kind, indexedKeys)
  accumulator.adjacency.set(nodeId, neighboursOf(dimension, component, allNodeIds))
}

export const circuitBoardFromSnapshots = (
  dimensions: ReadonlyMap<string, DimensionSnapshot>,
): CircuitBoard => {
  const entries = flattenSnapshotEntries(dimensions)
  const allNodeIds = new Set(entries.map((entry) => entry.nodeId))
  const accumulator: CircuitBoardAccumulator = {
    adjacency: new Map(),
    componentKeysByKind: new Map(),
    components: new Map(),
  }
  for (const entry of entries) {
    indexComponent(accumulator, entry, allNodeIds)
  }
  return accumulator
}

const NO_ITEMS = 0
const INITIAL_TICK_ACCUMULATOR_SECS = 0
const INITIAL_TICK_COUNT = 0
const INITIAL_TICKS_SINCE_TRANSFER = 0

export const makeRedstoneWorldState: Effect.Effect<RedstoneWorldState> = Effect.gen(
  function* makeRedstoneWorldStateGenerator() {
    const [
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
      hopperTicksSinceTransfer,
      pendingHopperTransferEvents,
      observedPoweredComponents,
      pendingPoweredComponentTransitions,
      tickAccumulatorSecs,
      tickCount,
    ] = yield* Effect.all([
      Ref.make<ReadonlyMap<string, DimensionSnapshot>>(new Map()),
      Ref.make<CircuitBoard>({ adjacency: new Map(), components: new Map() }),
      Ref.make<PowerMap>(emptyPowerMap),
      Ref.make<TimedCircuitState>(emptyTimedCircuitState),
      Ref.make<ReadonlySet<PositionKey>>(new Set()),
      Ref.make<ReadonlyMap<PositionKey, ObservedLamp>>(new Map()),
      Ref.make<ReadonlyArray<LampTransition>>([]),
      Ref.make<ReadonlyMap<PositionKey, PistonState>>(new Map()),
      Ref.make<ReadonlyArray<PoweredPistonTransition>>([]),
      Ref.make<ReadonlyMap<PositionKey, boolean>>(new Map()),
      Ref.make<ReadonlyArray<RedstoneTriggerEvent>>([]),
      Ref.make<ReadonlyMap<PositionKey, number>>(new Map()),
      Ref.make<ReadonlyArray<HopperTransferEvent>>([]),
      Ref.make<ReadonlyMap<PositionKey, boolean>>(new Map()),
      Ref.make<ReadonlyArray<PoweredComponentTransition>>([]),
      Ref.make(INITIAL_TICK_ACCUMULATOR_SECS),
      Ref.make(INITIAL_TICK_COUNT),
    ])
    return {
      board,
      dimensions,
      hopperTicksSinceTransfer,
      observedLamps,
      observedPistonStates,
      observedPoweredComponents,
      observedTriggerPower,
      pendingButtonPresses,
      pendingHopperTransferEvents,
      pendingLampTransitions,
      pendingPistonTransitions,
      pendingPoweredComponentTransitions,
      pendingTriggerEvents,
      power,
      tickAccumulatorSecs,
      tickCount,
      timedCircuit,
    }
  },
)

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
  Effect.gen(function* syncRedstoneSnapshotGenerator() {
    const current = yield* Ref.get(state.dimensions)
    const next = new Map(current)
    next.set(snapshot.dimension, snapshotMap(snapshot))
    yield* Ref.set(state.dimensions, next)
    yield* Ref.set(state.board, circuitBoardFromSnapshots(next))
  })

type LampTransitionResult = {
  readonly changed: ReadonlyArray<LampTransition>
  readonly current: ReadonlyMap<PositionKey, ObservedLamp>
}

const lampEntry = (
  entry: SnapshotEntry,
  circuit: CircuitReadout,
  previous: ReadonlyMap<PositionKey, ObservedLamp>,
): { readonly changed: boolean; readonly lamp: LampTransition } => {
  const { component, dimension, nodeId } = entry
  const lamp: LampTransition = {
    dimension,
    lit: isLit(circuit.board, circuit.power, nodeId),
    position: copyPosition(component.position),
  }
  const wasLit = previous.get(nodeId)?.lit ?? false
  return { changed: wasLit !== lamp.lit, lamp }
}

const collectLitLamps = (
  circuit: CircuitReadout,
  entries: ReadonlyArray<SnapshotEntry>,
  previous: ReadonlyMap<PositionKey, ObservedLamp>,
): LampTransitionResult => {
  const current = new Map<PositionKey, ObservedLamp>()
  const changed: Array<LampTransition> = []
  for (const entry of entries) {
    if (entry.component.kind === 'lamp') {
      const result = lampEntry(entry, circuit, previous)
      current.set(entry.nodeId, result.lamp)
      if (result.changed) {
        changed.push(result.lamp)
      }
    }
  }
  return { changed, current }
}

/** Lamps present in `previous` but no longer in `current` were removed from the world while
 * still lit, which is itself a lit -> unlit transition the host must be told about. */
const collectRemovedLampTransitions = (
  current: ReadonlyMap<PositionKey, ObservedLamp>,
  previous: ReadonlyMap<PositionKey, ObservedLamp>,
): ReadonlyArray<LampTransition> => {
  const removed: Array<LampTransition> = []
  for (const [nodeId, lamp] of previous) {
    if (!current.has(nodeId) && lamp.lit) {
      removed.push({ ...lamp, lit: false })
    }
  }
  return removed
}

/** Computes changed lamps and records them for the host-facing drain. */
export const collectLampTransitions = (state: RedstoneWorldState): Effect.Effect<void> =>
  Effect.gen(function* collectLampTransitionsGenerator() {
    const [board, power, dimensions, previous] = yield* Effect.all([
      Ref.get(state.board),
      Ref.get(state.power),
      Ref.get(state.dimensions),
      Ref.get(state.observedLamps),
    ])
    const entries = flattenSnapshotEntries(dimensions)
    const { changed, current } = collectLitLamps({ board, power }, entries, previous)
    const allChanged = [...changed, ...collectRemovedLampTransitions(current, previous)]
    yield* Ref.set(state.observedLamps, current)
    if (allChanged.length > NO_ITEMS) {
      yield* Ref.update(state.pendingLampTransitions, (pending) => [...pending, ...allChanged])
    }
  })

const pistonStateFor = (powered: boolean): PistonState => {
  if (powered) {
    return 'extended'
  }
  return 'retracted'
}

type PistonTransitionResult = {
  readonly changed: ReadonlyArray<readonly [PositionKey, PoweredPistonTransition]>
  readonly current: ReadonlyMap<PositionKey, PistonState>
}

/** 0 or 1 tagged transitions — an array rather than `T | undefined` so "no transition" is a
 * concrete, structural value instead of a sentinel a caller must remember to check for. */
const pistonTransitionEntry = (
  entry: SnapshotEntry,
  circuit: CircuitReadout,
  previous: ReadonlyMap<PositionKey, PistonState>,
): { readonly desired: PistonState; readonly transitions: ReadonlyArray<readonly [PositionKey, PoweredPistonTransition]> } => {
  const { component, dimension, nodeId } = entry
  const powered = isPowered(circuit.board, circuit.power, nodeId)
  const desired = pistonStateFor(powered)
  const observed = previous.get(nodeId) ?? component.pistonState ?? 'retracted'
  const physicalState = component.pistonState ?? observed
  if (observed === desired || physicalState === desired) {
    return { desired, transitions: [] }
  }
  return {
    desired,
    transitions: [[nodeId, {
      dimension,
      facing: component.pistonFacing ?? 'north',
      kind: component.pistonKind ?? 'normal',
      piston: copyPosition(component.position),
      powered,
      state: physicalState,
    }]],
  }
}

const computePistonTransitions = (
  circuit: CircuitReadout,
  entries: ReadonlyArray<SnapshotEntry>,
  previous: ReadonlyMap<PositionKey, PistonState>,
): PistonTransitionResult => {
  const current = new Map<PositionKey, PistonState>()
  const changed: Array<readonly [PositionKey, PoweredPistonTransition]> = []
  for (const entry of entries) {
    if (entry.component.kind === 'piston') {
      const { desired, transitions } = pistonTransitionEntry(entry, circuit, previous)
      current.set(entry.nodeId, desired)
      changed.push(...transitions)
    }
  }
  return { changed, current }
}

/** Emits one request when a piston's desired powered state changes. */
export const collectPistonTransitions = (state: RedstoneWorldState): Effect.Effect<void> =>
  Effect.gen(function* collectPistonTransitionsGenerator() {
    const [board, power, dimensions, previous] = yield* Effect.all([
      Ref.get(state.board),
      Ref.get(state.power),
      Ref.get(state.dimensions),
      Ref.get(state.observedPistonStates),
    ])
    const entries = flattenSnapshotEntries(dimensions)
    const { changed, current } = computePistonTransitions({ board, power }, entries, previous)
    const sorted = [...changed].sort(([left], [right]) => left.localeCompare(right))
    yield* Ref.set(state.observedPistonStates, current)
    if (sorted.length > NO_ITEMS) {
      yield* Ref.update(state.pendingPistonTransitions, (pending) => [
        ...pending,
        ...sorted.map(([, transition]) => transition),
      ])
    }
  })

const TRIGGERED_KINDS = new Set<ComponentKind>(['dispenser', 'dropper', 'note-block'])
const POWERED_KINDS = new Set<ComponentKind>(['powered-rail', 'door', 'trapdoor'])

type TriggerEventResult = {
  readonly current: ReadonlyMap<PositionKey, boolean>
  readonly triggered: ReadonlyArray<readonly [PositionKey, RedstoneTriggerEvent]>
}

const triggerEventEntry = (
  entry: SnapshotEntry,
  circuit: CircuitReadout,
  previous: ReadonlyMap<PositionKey, boolean>,
): { readonly events: ReadonlyArray<readonly [PositionKey, RedstoneTriggerEvent]>; readonly powered: boolean } => {
  const { component, dimension, nodeId } = entry
  const powered = isPowered(circuit.board, circuit.power, nodeId)
  const wasPowered = previous.get(nodeId) ?? false
  if (wasPowered || !powered) {
    return { events: [], powered }
  }
  return {
    events: [[nodeId, {
      dimension,
      kind: component.kind as TriggeredComponentKind,
      position: copyPosition(component.position),
    }]],
    powered,
  }
}

const computeTriggerEvents = (
  circuit: CircuitReadout,
  entries: ReadonlyArray<SnapshotEntry>,
  previous: ReadonlyMap<PositionKey, boolean>,
): TriggerEventResult => {
  const current = new Map<PositionKey, boolean>()
  const triggered: Array<readonly [PositionKey, RedstoneTriggerEvent]> = []
  for (const entry of entries) {
    if (TRIGGERED_KINDS.has(entry.component.kind)) {
      const { events, powered } = triggerEventEntry(entry, circuit, previous)
      current.set(entry.nodeId, powered)
      triggered.push(...events)
    }
  }
  return { current, triggered }
}

/** Emits deterministic rising-edge actions for one-shot powered components. */
export const collectTriggerEvents = (state: RedstoneWorldState): Effect.Effect<void> =>
  Effect.gen(function* collectTriggerEventsGenerator() {
    const [board, power, dimensions, previous] = yield* Effect.all([
      Ref.get(state.board),
      Ref.get(state.power),
      Ref.get(state.dimensions),
      Ref.get(state.observedTriggerPower),
    ])
    const entries = flattenSnapshotEntries(dimensions)
    const { current, triggered } = computeTriggerEvents({ board, power }, entries, previous)
    const sorted = [...triggered].sort(([left], [right]) => left.localeCompare(right))
    yield* Ref.set(state.observedTriggerPower, current)
    if (sorted.length > NO_ITEMS) {
      yield* Ref.update(state.pendingTriggerEvents, (pending) => [
        ...pending,
        ...sorted.map(([, event]) => event),
      ])
    }
  })

type HopperTransferResult = {
  readonly current: ReadonlyMap<PositionKey, number>
  readonly due: ReadonlyArray<readonly [PositionKey, HopperTransferEvent]>
}

/** `previous` and `ticks` are always consumed together (both describe hopper timing since the
 * last collection pass), so they travel as one param to keep every helper at 3 parameters. */
type HopperTiming = {
  readonly previous: ReadonlyMap<PositionKey, number>
  readonly ticks: number
}

const hopperTransferEntry = (
  entry: SnapshotEntry,
  circuit: CircuitReadout,
  timing: HopperTiming,
): { readonly due: ReadonlyArray<readonly [PositionKey, HopperTransferEvent]>; readonly ticksSinceTransfer: number } => {
  const { component, dimension, nodeId } = entry
  const ticksSinceTransfer = (timing.previous.get(nodeId) ?? INITIAL_TICKS_SINCE_TRANSFER) + timing.ticks
  const isDue = hopperTransferDue({
    powered: isPowered(circuit.board, circuit.power, nodeId),
    ticksSinceTransfer,
  })
  if (!isDue) {
    return { due: [], ticksSinceTransfer }
  }
  return {
    due: [[nodeId, { dimension, position: copyPosition(component.position) }]],
    ticksSinceTransfer: INITIAL_TICKS_SINCE_TRANSFER,
  }
}

const computeHopperTransfers = (
  circuit: CircuitReadout,
  entries: ReadonlyArray<SnapshotEntry>,
  timing: HopperTiming,
): HopperTransferResult => {
  const current = new Map<PositionKey, number>()
  const due: Array<readonly [PositionKey, HopperTransferEvent]> = []
  for (const entry of entries) {
    if (entry.component.kind === 'hopper') {
      const result = hopperTransferEntry(entry, circuit, timing)
      current.set(entry.nodeId, result.ticksSinceTransfer)
      due.push(...result.due)
    }
  }
  return { current, due }
}

/** Emits due, unlocked hopper requests without acquiring inventory ownership. */
export const collectHopperTransferEvents = (
  state: RedstoneWorldState,
  ticks: number,
): Effect.Effect<void> =>
  Effect.gen(function* collectHopperTransferEventsGenerator() {
    const [board, power, dimensions, previous] = yield* Effect.all([
      Ref.get(state.board),
      Ref.get(state.power),
      Ref.get(state.dimensions),
      Ref.get(state.hopperTicksSinceTransfer),
    ])
    const entries = flattenSnapshotEntries(dimensions)
    const { current, due } = computeHopperTransfers({ board, power }, entries, { previous, ticks })
    const sorted = [...due].sort(([left], [right]) => left.localeCompare(right))
    yield* Ref.set(state.hopperTicksSinceTransfer, current)
    if (sorted.length > NO_ITEMS) {
      yield* Ref.update(state.pendingHopperTransferEvents, (pending) => [
        ...pending,
        ...sorted.map(([, event]) => event),
      ])
    }
  })

type PoweredComponentResult = {
  readonly changed: ReadonlyArray<readonly [PositionKey, PoweredComponentTransition]>
  readonly current: ReadonlyMap<PositionKey, boolean>
}

const poweredComponentEntry = (
  entry: SnapshotEntry,
  circuit: CircuitReadout,
  previous: ReadonlyMap<PositionKey, boolean>,
): { readonly powered: boolean; readonly transitions: ReadonlyArray<readonly [PositionKey, PoweredComponentTransition]> } => {
  const { component, dimension, nodeId } = entry
  const powered = isPowered(circuit.board, circuit.power, nodeId)
  const observed = previous.get(nodeId) ?? component.powered ?? false
  if (observed === powered) {
    return { powered, transitions: [] }
  }
  return {
    powered,
    transitions: [[nodeId, {
      dimension,
      kind: component.kind as PoweredComponentKind,
      position: copyPosition(component.position),
      powered,
    }]],
  }
}

const computePoweredComponentTransitions = (
  circuit: CircuitReadout,
  entries: ReadonlyArray<SnapshotEntry>,
  previous: ReadonlyMap<PositionKey, boolean>,
): PoweredComponentResult => {
  const current = new Map<PositionKey, boolean>()
  const changed: Array<readonly [PositionKey, PoweredComponentTransition]> = []
  for (const entry of entries) {
    if (POWERED_KINDS.has(entry.component.kind)) {
      const { powered, transitions } = poweredComponentEntry(entry, circuit, previous)
      current.set(entry.nodeId, powered)
      changed.push(...transitions)
    }
  }
  return { changed, current }
}

/** Emits deterministic state transitions for continuously powered components. */
export const collectPoweredComponentTransitions = (state: RedstoneWorldState): Effect.Effect<void> =>
  Effect.gen(function* collectPoweredComponentTransitionsGenerator() {
    const [board, power, dimensions, previous] = yield* Effect.all([
      Ref.get(state.board),
      Ref.get(state.power),
      Ref.get(state.dimensions),
      Ref.get(state.observedPoweredComponents),
    ])
    const entries = flattenSnapshotEntries(dimensions)
    const { changed, current } = computePoweredComponentTransitions({ board, power }, entries, previous)
    const sorted = [...changed].sort(([left], [right]) => left.localeCompare(right))
    yield* Ref.set(state.observedPoweredComponents, current)
    if (sorted.length > NO_ITEMS) {
      yield* Ref.update(state.pendingPoweredComponentTransitions, (pending) => [
        ...pending,
        ...sorted.map(([, transition]) => transition),
      ])
    }
  })

const runtimeStates = new WeakMap<RedstoneWorldRuntimeService, RedstoneWorldState>()

export const redstoneWorldStateFor = (runtime: RedstoneWorldRuntimeService): RedstoneWorldState => {
  const state = runtimeStates.get(runtime)
  if (typeof state === 'undefined') {
    throw new Error('RedstoneWorldRuntime was not created by makeRedstoneWorldRuntime')
  }
  return state
}

export const makeRedstoneWorldRuntime: Effect.Effect<RedstoneWorldRuntimeService> = Effect.gen(
  function* makeRedstoneWorldRuntimeGenerator() {
    const state = yield* makeRedstoneWorldState
    const runtime: RedstoneWorldRuntimeService = {
      drainHopperTransferEvents: Ref.getAndSet(state.pendingHopperTransferEvents, []),
      drainLampTransitions: Ref.getAndSet(state.pendingLampTransitions, []),
      drainPistonTransitions: Ref.getAndSet(state.pendingPistonTransitions, []),
      drainPoweredComponentTransitions: Ref.getAndSet(state.pendingPoweredComponentTransitions, []),
      drainTriggerEvents: Ref.getAndSet(state.pendingTriggerEvents, []),
      pressButton: (dimension, position) =>
        Ref.update(state.pendingButtonPresses, (pending) => {
          const next = new Set(pending)
          next.add(redstoneNodeId(dimension, position))
          return next
        }),
      syncSnapshot: (snapshot) => syncRedstoneSnapshot(state, snapshot),
    }
    runtimeStates.set(runtime, state)
    return runtime
  },
)

export const RedstoneWorldRuntimeLayer: Layer.Layer<RedstoneWorldRuntime> = Layer.effect(
  RedstoneWorldRuntime,
  makeRedstoneWorldRuntime,
)
