import {
  type BlockAddress,
  BlockAxis,
  type BlockPosition,
  BlockPositionSchema,
  DimensionIdSchema,
  FixedDurationSecs,
  NonNegativeTickCount,
} from '@nerima-games/mc-kernel'
import {
  type CircuitBoard,
  type Component,
  type ComponentKind,
  type PowerLevel,
  type PowerMap,
  type PowerProvenanceCandidate,
  type PowerReadContext,
  type PowerTickBlockLevels,
  type PowerTickContext,
  type PowerTickWithProvenance,
  emptyPowerMap,
  isLit,
  isPowered,
} from '../domain/power-graph.js'
import {
  type ComparatorMode,
  type ContainerSlot,
  ContainerSlotSchema,
  containerSignalStrength,
} from '../domain/comparator.js'
import { Context, Effect, Layer, Option, Ref, Schema } from 'effect'
import {
  type PistonFacing,
  PistonFacingSchema,
  type PistonKind,
  PistonKindSchema,
  type PistonState,
  PistonStateSchema,
  type PistonTransitionRequest,
} from '../domain/piston.js'
import {
  type TimedCircuitState,
  emptyTimedCircuitState,
} from '../domain/power-timing.js'
import type { PositionKey } from '../domain/position-key.js'

type DimensionId = BlockAddress['dimension']
const NO_LOOKUPS = 0
const NO_ITEMS = 0
const BLOCK_POWER_READERS: ReadonlySet<ComponentKind> = new Set([
  'comparator',
  'dispenser',
  'door',
  'dropper',
  'hopper',
  'lamp',
  'note-block',
  'piston',
  'powered-rail',
  'repeater',
  'torch',
  'trapdoor',
])

export type RedstonePosition = BlockPosition

export type RedstoneComponentSnapshot = {
  readonly position: RedstonePosition
  readonly kind: ComponentKind
  readonly active?: boolean
  readonly emits?: PowerLevel
  readonly delayTicks?: NonNegativeTickCount
  readonly pulseTicks?: NonNegativeTickCount
  readonly invertedBy?: RedstonePosition
  readonly inputFrom?: RedstonePosition
  readonly sideInputs?: ReadonlyArray<RedstonePosition>
  readonly mode?: ComparatorMode
  readonly containerSlots?: ReadonlyArray<ContainerSlot>
  readonly containerSignal?: PowerLevel
  readonly outputTo?: RedstonePosition
  readonly strongPowerTo?: RedstonePosition
  readonly pistonFacing?: PistonFacing
  readonly pistonKind?: PistonKind
  readonly pistonState?: PistonState
  readonly powered?: boolean
}

/** A complete replacement snapshot for one dimension. */
export type RedstoneWorldSnapshot = {
  readonly dimension: DimensionId
  readonly components: ReadonlyArray<RedstoneComponentSnapshot>
}

export type RedstoneWorldSnapshotDuplicatePositionError = {
  readonly _tag: 'DuplicateRedstoneWorldSnapshotPosition'
  readonly dimension: DimensionId
  readonly position: RedstonePosition
}

export type LampTransition = {
  readonly dimension: DimensionId
  readonly position: RedstonePosition
  readonly lit: boolean
}

export type PoweredPistonTransition = PistonTransitionRequest & {
  readonly dimension: DimensionId
}

export type TriggeredComponentKind = 'dispenser' | 'dropper' | 'note-block'

export type RedstoneTriggerEvent = {
  readonly dimension: DimensionId
  readonly position: RedstonePosition
  readonly kind: TriggeredComponentKind
}

export type HopperTransferEvent = {
  readonly dimension: DimensionId
  readonly position: RedstonePosition
  readonly elapsedRedstoneTicks: NonNegativeTickCount
  readonly powered: boolean
}

export type PoweredComponentKind = 'powered-rail' | 'door' | 'trapdoor'

export type PoweredComponentTransition = {
  readonly dimension: DimensionId
  readonly position: RedstonePosition
  readonly kind: PoweredComponentKind
  readonly powered: boolean
}

type DimensionSnapshot = ReadonlyMap<PositionKey, RedstoneComponentSnapshot>
type RedstoneSnapshotSyncOptions = {
  readonly isRedstoneConductiveAt?: (position: RedstonePosition) => boolean
}

export type RedstoneTickObservation = {
  readonly tick: NonNegativeTickCount
  readonly dimensions: ReadonlyMap<DimensionId, DimensionSnapshot>
  readonly power: PowerMap
  readonly blockPower: ReadonlyMap<PositionKey, PowerTickBlockLevels>
  readonly provenance: ReadonlyMap<PositionKey, ReadonlyArray<PowerProvenanceCandidate>>
  readonly conductivityAnswers: ReadonlyMap<PositionKey, boolean>
  readonly timedCircuit: TimedCircuitState
}

type ObservationRecorder = {
  enabled: boolean
  ticks: Array<RedstoneTickObservation>
}

type ObservedLamp = LampTransition

export type RedstoneWorldState = {
  readonly dimensions: Ref.Ref<ReadonlyMap<DimensionId, DimensionSnapshot>>
  readonly conductivityLookups: Ref.Ref<ReadonlyMap<DimensionId, (position: RedstonePosition) => boolean>>
  readonly board: Ref.Ref<CircuitBoard>
  readonly power: Ref.Ref<PowerMap>
  readonly blockPower: Ref.Ref<ReadonlyMap<PositionKey, PowerTickBlockLevels>>
  readonly timedCircuit: Ref.Ref<TimedCircuitState>
  readonly pendingButtonPresses: Ref.Ref<ReadonlySet<PositionKey>>
  readonly observedLamps: Ref.Ref<ReadonlyMap<PositionKey, ObservedLamp>>
  readonly pendingLampTransitions: Ref.Ref<ReadonlyArray<LampTransition>>
  readonly observedPistonStates: Ref.Ref<ReadonlyMap<PositionKey, PistonState>>
  readonly pendingPistonTransitions: Ref.Ref<ReadonlyArray<PoweredPistonTransition>>
  readonly observedTriggerPower: Ref.Ref<ReadonlyMap<PositionKey, boolean>>
  readonly pendingTriggerEvents: Ref.Ref<ReadonlyArray<RedstoneTriggerEvent>>
  readonly pendingHopperTransferEvents: Ref.Ref<ReadonlyArray<HopperTransferEvent>>
  readonly observedPoweredComponents: Ref.Ref<ReadonlyMap<PositionKey, boolean>>
  readonly pendingPoweredComponentTransitions: Ref.Ref<ReadonlyArray<PoweredComponentTransition>>
  readonly tickAccumulatorSecs: Ref.Ref<FixedDurationSecs>
  readonly tickCount: Ref.Ref<NonNegativeTickCount>
}

export type RedstoneEventBatch = {
  readonly hopper: ReadonlyArray<HopperTransferEvent>
  readonly lamp: ReadonlyArray<LampTransition>
  readonly piston: ReadonlyArray<PoweredPistonTransition>
  readonly powered: ReadonlyArray<PoweredComponentTransition>
  readonly trigger: ReadonlyArray<RedstoneTriggerEvent>
}

const ZERO_DURATION_SECS = 0
const ZERO_TICK_COUNT = 0
const ONE_TICK = 1
const fixedDurationSecsSchema = Schema.Number.pipe(Schema.fromBrand('FixedDurationSecs', FixedDurationSecs))
const nonNegativeTickCountSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(ZERO_TICK_COUNT))
  .pipe(Schema.fromBrand('NonNegativeTickCount', NonNegativeTickCount))
const powerLevelSchema = Schema.Int.check(Schema.isBetween({ maximum: 15, minimum: 0 }))
const arraySchema = Schema.Array
const blockAxis = BlockAxis
const literalsSchema = Schema.Literals
const literalSchema = Schema.Literal
const structSchema = Schema.Struct

export const RedstoneComponentSnapshotSchema: Schema.Codec<RedstoneComponentSnapshot, unknown> = structSchema({
  active: Schema.optionalKey(Schema.Boolean),
  containerSignal: Schema.optionalKey(powerLevelSchema),
  containerSlots: Schema.optionalKey(arraySchema(ContainerSlotSchema)),
  delayTicks: Schema.optionalKey(nonNegativeTickCountSchema),
  emits: Schema.optionalKey(powerLevelSchema),
  inputFrom: Schema.optionalKey(BlockPositionSchema),
  invertedBy: Schema.optionalKey(BlockPositionSchema),
  kind: literalsSchema([
    'wire', 'torch', 'lever', 'button', 'repeater', 'lamp', 'comparator',
    'observer', 'pressure-plate', 'target', 'piston', 'hopper', 'dispenser',
    'dropper', 'note-block', 'powered-rail', 'door', 'trapdoor',
  ]),
  mode: Schema.optionalKey(literalsSchema(['compare', 'subtract'])),
  outputTo: Schema.optionalKey(BlockPositionSchema),
  pistonFacing: Schema.optionalKey(PistonFacingSchema),
  pistonKind: Schema.optionalKey(PistonKindSchema),
  pistonState: Schema.optionalKey(PistonStateSchema),
  position: BlockPositionSchema,
  powered: Schema.optionalKey(Schema.Boolean),
  pulseTicks: Schema.optionalKey(nonNegativeTickCountSchema),
  sideInputs: Schema.optionalKey(arraySchema(BlockPositionSchema)),
  strongPowerTo: Schema.optionalKey(BlockPositionSchema),
})

export const RedstoneWorldSnapshotSchema: Schema.Codec<RedstoneWorldSnapshot, unknown> = structSchema({
  components: arraySchema(RedstoneComponentSnapshotSchema),
  dimension: DimensionIdSchema,
})
const ORIGIN_COORDINATE = 0
const NEXT_COORDINATE = 1
const PREVIOUS_COORDINATE = -1
const ZERO_AXIS = blockAxis(ORIGIN_COORDINATE)
const POSITIVE_ONE_AXIS = blockAxis(NEXT_COORDINATE)
const NEGATIVE_ONE_AXIS = blockAxis(PREVIOUS_COORDINATE)

/** Strict decoding shape for every drained runtime event category. */
export const RedstoneEventBatchSchema: Schema.Codec<RedstoneEventBatch, unknown> = structSchema({
  hopper: arraySchema(structSchema({
    dimension: DimensionIdSchema,
    elapsedRedstoneTicks: nonNegativeTickCountSchema,
    position: BlockPositionSchema,
    powered: Schema.Boolean,
  })),
  lamp: arraySchema(structSchema({
    dimension: DimensionIdSchema,
    lit: Schema.Boolean,
    position: BlockPositionSchema,
  })),
  piston: arraySchema(structSchema({
    dimension: DimensionIdSchema,
    facing: literalsSchema(['down', 'east', 'north', 'south', 'up', 'west']),
    kind: literalsSchema(['normal', 'sticky']),
    piston: BlockPositionSchema,
    powered: Schema.Boolean,
    state: literalsSchema(['extended', 'retracted']),
  })),
  powered: arraySchema(structSchema({
    dimension: DimensionIdSchema,
    kind: literalsSchema(['powered-rail', 'door', 'trapdoor']),
    position: BlockPositionSchema,
    powered: Schema.Boolean,
  })),
  trigger: arraySchema(structSchema({
    dimension: DimensionIdSchema,
    kind: literalsSchema(['dispenser', 'dropper', 'note-block']),
    position: BlockPositionSchema,
  })),
})

export type RedstoneWorldRuntimeService = {
  /** Replaces only the named dimension; snapshots of other dimensions remain installed. */
  readonly syncSnapshot: (snapshot: RedstoneWorldSnapshot, options?: RedstoneSnapshotSyncOptions) => Effect.Effect<
    void,
    Schema.SchemaError | RedstoneWorldSnapshotDuplicatePositionError
  >
  /** Starts or restarts this button's configured pulse on the next redstone tick. */
  readonly pressButton: (dimension: DimensionId, position: RedstonePosition) => Effect.Effect<void>
  /** Restores a previously drained event batch after its host commit fails. */
  readonly restoreEvents: (events: RedstoneEventBatch) => Effect.Effect<void>
  /** Atomically returns and clears transitions produced by `redstone:effects`. */
  readonly drainLampTransitions: Effect.Effect<ReadonlyArray<LampTransition>>
  /** Atomically returns and clears power-driven requests for host planning/application. */
  readonly drainPistonTransitions: Effect.Effect<ReadonlyArray<PoweredPistonTransition>>
  /** Returns rising-edge actions for dispensers, droppers, and note blocks. */
  readonly drainTriggerEvents: Effect.Effect<ReadonlyArray<RedstoneTriggerEvent>>
  /** Returns per-hopper ticks and power state for HopperService planning. */
  readonly drainHopperTransferEvents: Effect.Effect<ReadonlyArray<HopperTransferEvent>>
  /** Returns power-state changes for rails, doors, and trapdoors. */
  readonly drainPoweredComponentTransitions: Effect.Effect<ReadonlyArray<PoweredComponentTransition>>
}

/**
 * `Context.Service` is a factory, so it is invoked without `new`.
 * The intermediate binding with an explicit `Context.ServiceClass` annotation
 * is required by `isolatedDeclarations`: an `extends` clause must be a bare
 * reference, not an invoked expression.
 */
const makeContextService = Context.Service

const RedstoneWorldRuntimeBase: Context.ServiceClass<
  RedstoneWorldRuntime,
  '@nerima-games/mx-redstone/RedstoneWorldRuntime',
  RedstoneWorldRuntimeService
> = makeContextService<RedstoneWorldRuntime, RedstoneWorldRuntimeService>()('@nerima-games/mx-redstone/RedstoneWorldRuntime')

export class RedstoneWorldRuntime extends RedstoneWorldRuntimeBase {}

const copyPosition = ({ x, y, z }: RedstonePosition): RedstonePosition => ({ x, y, z })

// Relational comparison stays locale-independent and returns zero for equal IDs.
const compareDimensionIds = (left: DimensionId, right: DimensionId): number =>
  Number(left > right) - Number(left < right)

const comparePositionCoordinates = (left: RedstonePosition, right: RedstonePosition): number =>
  left.x - right.x || left.y - right.y || left.z - right.z

/** Stable and collision-safe across dimensions. */
export const redstoneNodeId = (dimension: DimensionId, position: RedstonePosition): PositionKey =>
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
  const result: Partial<Record<Key, Value>> = {}
  Object.defineProperty(result, key, { enumerable: true, value })
  return result
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
  const result: Partial<Record<Key, Projected>> = {}
  Object.defineProperty(result, key, { enumerable: true, value: project(value) })
  return result
}

const copyComponentSnapshot = (component: RedstoneComponentSnapshot): RedstoneComponentSnapshot => ({
  ...withOptional('active', component.active),
  ...withOptional('containerSignal', component.containerSignal),
  ...withOptionalMapped('containerSlots', component.containerSlots, (slots) => slots.map((slot) => ({ ...slot }))),
  ...withOptional('delayTicks', component.delayTicks),
  ...withOptional('emits', component.emits),
  ...withOptionalMapped('inputFrom', component.inputFrom, copyPosition),
  kind: component.kind,
  ...withOptionalMapped('invertedBy', component.invertedBy, copyPosition),
  ...withOptional('mode', component.mode),
  ...withOptionalMapped('outputTo', component.outputTo, copyPosition),
  ...withOptionalMapped('strongPowerTo', component.strongPowerTo, copyPosition),
  ...withOptional('pistonFacing', component.pistonFacing),
  ...withOptional('pistonKind', component.pistonKind),
  ...withOptional('pistonState', component.pistonState),
  position: copyPosition(component.position),
  ...withOptional('powered', component.powered),
  ...withOptional('pulseTicks', component.pulseTicks),
  ...withOptionalMapped('sideInputs', component.sideInputs, (positions) => positions.map(copyPosition)),
})

const copyDimensions = (
  dimensions: ReadonlyMap<DimensionId, DimensionSnapshot>,
): ReadonlyMap<DimensionId, DimensionSnapshot> => new Map(
  [...dimensions].map(([dimension, snapshots]) => [
    dimension,
    new Map([...snapshots].map(([key, component]) => [key, copyComponentSnapshot(component)])),
  ]),
)

const copyTimedCircuit = (timedCircuit: TimedCircuitState): TimedCircuitState => ({
  buttons: new Map([...timedCircuit.buttons].map(([key, timer]) => [key, { ...timer }])),
  power: new Map(timedCircuit.power),
  repeaters: new Map([...timedCircuit.repeaters].map(([key, timer]) => [key, { ...timer }])),
  ...withOptionalMapped('torches', timedCircuit.torches, (torches) => new Map(
    [...torches].map(([key, timer]) => [key, { ...timer, recentOffTicks: [...timer.recentOffTicks] }]),
  )),
})

const copyProvenance = (
  provenance: ReadonlyMap<PositionKey, ReadonlyArray<PowerProvenanceCandidate>>,
): ReadonlyMap<PositionKey, ReadonlyArray<PowerProvenanceCandidate>> => new Map(
  [...provenance].map(([key, candidates]) => [key, candidates.map((candidate) => ({ ...candidate }))]),
)

const copyBlockPower = (
  blockPower: ReadonlyMap<PositionKey, PowerTickBlockLevels>,
): ReadonlyMap<PositionKey, PowerTickBlockLevels> => new Map(
  [...blockPower].map(([key, levels]) => [key, { ...levels }]),
)

const copyTickObservation = (tick: RedstoneTickObservation): RedstoneTickObservation => ({
  blockPower: copyBlockPower(tick.blockPower),
  conductivityAnswers: new Map(tick.conductivityAnswers),
  dimensions: copyDimensions(tick.dimensions),
  power: new Map(tick.power),
  provenance: copyProvenance(tick.provenance),
  tick: tick.tick,
  timedCircuit: copyTimedCircuit(tick.timedCircuit),
})

const observationRecorders = new WeakMap<RedstoneWorldState, ObservationRecorder>()
export const REDSTONE_OBSERVATION_HISTORY_LIMIT = 120

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

const positionAtOffset = (
  position: RedstonePosition,
  offset: RedstonePosition,
): Option.Option<RedstonePosition> => {
  const x = position.x + offset.x
  const y = position.y + offset.y
  const z = position.z + offset.z
  if (![x, y, z].every(Number.isSafeInteger)) {
    return Option.none()
  }
  return Option.some({ x: blockAxis(x), y: blockAxis(y), z: blockAxis(z) })
}

const torchStrongPowerTarget = (position: RedstonePosition): RedstonePosition | undefined =>
  Option.getOrUndefined(positionAtOffset(position, { x: ZERO_AXIS, y: POSITIVE_ONE_AXIS, z: ZERO_AXIS }))

const strongPowerTargetFor = (component: RedstoneComponentSnapshot): RedstonePosition | undefined => {
  if (component.kind === 'torch') {
    return torchStrongPowerTarget(component.position)
  }
  return component.strongPowerTo
}

const componentAt = (
  dimension: DimensionId,
  component: RedstoneComponentSnapshot,
): Component => {
  const positionToNodeId = (position: RedstonePosition): PositionKey => redstoneNodeId(dimension, position)
  const strongPowerTo = strongPowerTargetFor(component)
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
    ...withOptionalMapped('strongPowerTo', strongPowerTo, positionToNodeId),
  }
}

const FACE_OFFSETS: ReadonlyArray<RedstonePosition> = [
  { x: POSITIVE_ONE_AXIS, y: ZERO_AXIS, z: ZERO_AXIS },
  { x: NEGATIVE_ONE_AXIS, y: ZERO_AXIS, z: ZERO_AXIS },
  { x: ZERO_AXIS, y: POSITIVE_ONE_AXIS, z: ZERO_AXIS },
  { x: ZERO_AXIS, y: NEGATIVE_ONE_AXIS, z: ZERO_AXIS },
  { x: ZERO_AXIS, y: ZERO_AXIS, z: POSITIVE_ONE_AXIS },
  { x: ZERO_AXIS, y: ZERO_AXIS, z: NEGATIVE_ONE_AXIS },
]

/** One component, tagged with the dimension and node id it was read from — the flattened
 * unit every `collect*` pass and `circuitBoardFromSnapshots` iterate over. */
type SnapshotEntry = {
  readonly component: RedstoneComponentSnapshot
  readonly dimension: DimensionId
  readonly nodeId: PositionKey
}

type NonEmptyReadonlyArray<Item> = readonly [Item, ...ReadonlyArray<Item>]

const isNonEmptyReadonlyArray = <Item>(
  values: ReadonlyArray<Item>,
): values is NonEmptyReadonlyArray<Item> =>
  values.length > NO_ITEMS

/** Snapshot installation replaces this map, so its identity bounds the cached entries. */
const flattenedSnapshotEntries = new WeakMap<
  ReadonlyMap<DimensionId, DimensionSnapshot>,
  ReadonlyArray<SnapshotEntry>
>()

const flattenSnapshotEntries = (
  dimensions: ReadonlyMap<DimensionId, DimensionSnapshot>,
): ReadonlyArray<SnapshotEntry> => {
  const cached = flattenedSnapshotEntries.get(dimensions)
  if (cached) {
    return cached
  }
  const entries: Array<SnapshotEntry> = []
  for (const [dimension, snapshot] of dimensions) {
    for (const [nodeId, component] of snapshot) {
      entries.push({ component, dimension, nodeId })
    }
  }
  flattenedSnapshotEntries.set(dimensions, entries)
  return entries
}

const hopperEntriesBySnapshot = new WeakMap<
  ReadonlyMap<DimensionId, DimensionSnapshot>,
  ReadonlyArray<SnapshotEntry>
>()

const hopperEntriesFromSnapshots = (
  dimensions: ReadonlyMap<DimensionId, DimensionSnapshot>,
): ReadonlyArray<SnapshotEntry> => {
  const cached = hopperEntriesBySnapshot.get(dimensions)
  if (cached) {
    return cached
  }
  const entries = flattenSnapshotEntries(dimensions).filter(({ component }) => component.kind === 'hopper')
  hopperEntriesBySnapshot.set(dimensions, entries)
  return entries
}

/** `board`/`power` travel together everywhere a `collect*` pass needs to ask the power
 * graph a question, so they are threaded as one reader instead of two positional params. */
type CircuitReadout = {
  readonly board: CircuitBoard
  readonly power: PowerMap
  readonly powerReadContext: PowerReadContext
}

type CircuitBoardAccumulator = {
  readonly adjacency: Map<PositionKey, ReadonlyArray<PositionKey>>
  readonly componentKeysByKind: Map<ComponentKind, Array<PositionKey>>
  readonly components: Map<PositionKey, Component>
}

type NeighbourLookup = {
  readonly allNodeIds: ReadonlySet<PositionKey>
  readonly dimension: DimensionId
}

const neighbourAtOffset = (
  lookup: NeighbourLookup,
  position: RedstonePosition,
  offset: RedstonePosition,
): Option.Option<PositionKey> => {
  const x = position.x + offset.x
  const y = position.y + offset.y
  const z = position.z + offset.z
  if (![x, y, z].every(Number.isSafeInteger)) {
    return Option.none()
  }
  const nodeId = redstoneNodeId(lookup.dimension, {
    x: blockAxis(x),
    y: blockAxis(y),
    z: blockAxis(z),
  })
  if (!lookup.allNodeIds.has(nodeId)) {
    return Option.none()
  }
  return Option.some(nodeId)
}

const neighboursOf = (
  dimension: DimensionId,
  component: RedstoneComponentSnapshot,
  allNodeIds: ReadonlySet<PositionKey>,
): ReadonlyArray<PositionKey> =>
  FACE_OFFSETS.flatMap((offset) =>
    Option.match(neighbourAtOffset({ allNodeIds, dimension }, component.position, offset), {
      onNone: () => [],
      onSome: (nodeId) => [nodeId],
    }),
  )

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
  dimensions: ReadonlyMap<DimensionId, DimensionSnapshot>,
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

export type RedstonePowerTickContextBundle =
  | {
      readonly captureProvenance: true
      readonly conductivityAnswers: ReadonlyMap<PositionKey, boolean>
      readonly context: PowerTickContext
    }
  | {
      readonly captureProvenance: false
      readonly context: PowerTickContext
    }

export type RedstoneObservationTickContext = Extract<
  RedstonePowerTickContextBundle,
  { readonly captureProvenance: true }
>

type RedstonePowerTickContextFactory = (
  previousBlockPower: ReadonlyMap<PositionKey, PowerTickBlockLevels>,
) => RedstonePowerTickContextBundle

const redstonePowerTickContextFactories = new WeakMap<RedstoneWorldState, RedstonePowerTickContextFactory>()
const EMPTY_DIMENSIONS: ReadonlyMap<DimensionId, DimensionSnapshot> = new Map()
const EMPTY_CONDUCTIVITY_LOOKUPS: ReadonlyMap<DimensionId, (position: RedstonePosition) => boolean> = new Map()
const EMPTY_BLOCK_POWER_MAP: ReadonlyMap<PositionKey, PowerTickBlockLevels> = new Map()

type SnapshotPosition = {
  readonly dimension: DimensionId
  readonly kind?: ComponentKind
  readonly position: RedstonePosition
  faceBlockNeighbours: ReadonlyArray<PositionKey> | null
  faceComponentNeighbours: ReadonlyArray<PositionKey> | null
  faceWireNeighbours: ReadonlyArray<PositionKey> | null
  faceLampNeighbours: ReadonlyArray<PositionKey> | null
  faceNeighbours: ReadonlyArray<PositionKey> | null
  faceSupportBlockNeighbour: PositionKey | null
}

const NO_FACE_NEIGHBOURS: ReadonlyArray<PositionKey> = []
const SUPPORT_BLOCK_OFFSET: RedstonePosition = {
  x: ZERO_AXIS,
  y: NEGATIVE_ONE_AXIS,
  z: ZERO_AXIS,
}

const snapshotPositionFor = (
  dimension: DimensionId,
  position: RedstonePosition,
  kind?: ComponentKind,
): SnapshotPosition => {
  if (typeof kind === 'undefined') {
    return {
      dimension,
      faceBlockNeighbours: null,
      faceComponentNeighbours: null,
      faceLampNeighbours: null,
      faceNeighbours: null,
      faceSupportBlockNeighbour: null,
      faceWireNeighbours: null,
      position,
    }
  }
  return {
    dimension,
    faceBlockNeighbours: null,
    faceComponentNeighbours: null,
    faceLampNeighbours: null,
    faceNeighbours: null,
    faceSupportBlockNeighbour: null,
    faceWireNeighbours: null,
    kind,
    position,
  }
}

const positionsFromSnapshots = (
  dimensions: ReadonlyMap<DimensionId, DimensionSnapshot>,
): Map<PositionKey, SnapshotPosition> => {
  const positions = new Map<PositionKey, SnapshotPosition>()
  for (const entry of flattenSnapshotEntries(dimensions)) {
    positions.set(entry.nodeId, snapshotPositionFor(
      entry.dimension,
      entry.component.position,
      entry.component.kind,
    ))
  }
  return positions
}

const appendFaceNeighbour = (params: {
  readonly location: SnapshotPosition
  readonly offset: RedstonePosition
  readonly positions: Map<PositionKey, SnapshotPosition>
  readonly neighbours: Array<PositionKey>
}): void => {
  const { location, offset, positions, neighbours } = params
  const position = positionAtOffset(location.position, offset)
  if (Option.isSome(position)) {
    const neighbourPosition = position.value
    const neighbour = redstoneNodeId(location.dimension, neighbourPosition)
    if (!positions.has(neighbour)) {
      positions.set(neighbour, snapshotPositionFor(location.dimension, neighbourPosition))
    }
    neighbours.push(neighbour)
  }
}

const faceNeighboursFor = (
  positions: Map<PositionKey, SnapshotPosition>,
  key: PositionKey,
): ReadonlyArray<PositionKey> => {
  const location = positions.get(key)
  if (!location) {
    return NO_FACE_NEIGHBOURS
  }
  if (location.faceNeighbours !== null) {
    return location.faceNeighbours
  }
  const neighbours: Array<PositionKey> = []
  for (const offset of FACE_OFFSETS) {
    appendFaceNeighbour({ location, neighbours, offset, positions })
  }
  location.faceNeighbours = neighbours
  return neighbours
}

const faceBlockNeighboursFor = (
  positions: Map<PositionKey, SnapshotPosition>,
  componentPositions: ReadonlySet<PositionKey>,
  key: PositionKey,
): ReadonlyArray<PositionKey> => {
  const location = positions.get(key)
  if (!location) {
    return NO_FACE_NEIGHBOURS
  }
  if (location.faceBlockNeighbours !== null) {
    return location.faceBlockNeighbours
  }
  const neighbours = faceNeighboursFor(positions, key)
    .filter((neighbour) => !componentPositions.has(neighbour))
  location.faceBlockNeighbours = neighbours
  return neighbours
}

const supportBlockNeighbourForLocation = (input: {
  readonly componentPositions: ReadonlySet<PositionKey>
  readonly location: SnapshotPosition
  readonly positions: Map<PositionKey, SnapshotPosition>
}): PositionKey | null => {
  const { componentPositions, location, positions } = input
  const supportPosition = positionAtOffset(location.position, SUPPORT_BLOCK_OFFSET)
  if (Option.isNone(supportPosition)) {
    return null
  }
  const neighbourPosition = supportPosition.value
  const neighbour = redstoneNodeId(location.dimension, neighbourPosition)
  if (componentPositions.has(neighbour)) {
    return null
  }
  positions.set(neighbour, snapshotPositionFor(location.dimension, neighbourPosition))
  return neighbour
}

const cacheSupportBlockNeighbours = (
  positions: Map<PositionKey, SnapshotPosition>,
  componentPositions: ReadonlySet<PositionKey>,
): void => {
  for (const [key, location] of positions) {
    if (componentPositions.has(key)) {
      const support = supportBlockNeighbourForLocation({ componentPositions, location, positions })
      if (support !== null) {
        location.faceSupportBlockNeighbour = support
      }
    }
  }
}

const faceSupportBlockNeighbourFor = (
  positions: Map<PositionKey, SnapshotPosition>,
  key: PositionKey,
): PositionKey | null => {
  const location = positions.get(key)
  if (!location) {
    return null
  }
  return location.faceSupportBlockNeighbour
}

const faceComponentNeighboursFor = (
  positions: Map<PositionKey, SnapshotPosition>,
  componentPositions: ReadonlySet<PositionKey>,
  key: PositionKey,
): ReadonlyArray<PositionKey> => {
  const location = positions.get(key)
  if (!location) {
    return NO_FACE_NEIGHBOURS
  }
  if (location.faceComponentNeighbours !== null) {
    return location.faceComponentNeighbours
  }
  const neighbours = faceNeighboursFor(positions, key)
    .filter((neighbour) => componentPositions.has(neighbour))
  location.faceComponentNeighbours = neighbours
  return neighbours
}

const cachedFaceReceiverNeighbours = (location: SnapshotPosition, kind: 'wire' | 'lamp'): ReadonlyArray<PositionKey> | null => {
  if (kind === 'wire') {
    return location.faceWireNeighbours
  }
  return location.faceLampNeighbours
}

const cacheFaceReceiverNeighbours = (
  location: SnapshotPosition,
  kind: 'wire' | 'lamp',
  neighbours: ReadonlyArray<PositionKey>,
): void => {
  if (kind === 'wire') {
    location.faceWireNeighbours = neighbours
  } else {
    location.faceLampNeighbours = neighbours
  }
}

const faceReceiverNeighboursFor = (input: {
  readonly positions: Map<PositionKey, SnapshotPosition>
  readonly componentPositions: ReadonlySet<PositionKey>
  readonly key: PositionKey
  readonly kind: 'wire' | 'lamp'
}): ReadonlyArray<PositionKey> => {
  const { componentPositions, key, kind, positions } = input
  const location = positions.get(key)
  if (!location) {
    return NO_FACE_NEIGHBOURS
  }
  const cached = cachedFaceReceiverNeighbours(location, kind)
  if (cached !== null) {
    return cached
  }
  const neighbours = faceComponentNeighboursFor(positions, componentPositions, key)
    .filter((neighbour) => positions.get(neighbour)?.kind === kind)
  cacheFaceReceiverNeighbours(location, kind, neighbours)
  return neighbours
}

type TickPowerContextInput = {
  readonly componentPositions: ReadonlySet<PositionKey>
  readonly hasLampReceivers: boolean
  readonly positions: Map<PositionKey, SnapshotPosition>
  readonly lookups: ReadonlyMap<DimensionId, (position: RedstonePosition) => boolean>
  readonly retainBlockPower: boolean
  previousBlockPower: ReadonlyMap<PositionKey, PowerTickBlockLevels>
  conductivityAnswers: Map<PositionKey, boolean> | null
}

const redstoneConductiveAt = (input: TickPowerContextInput, key: PositionKey): boolean => {
  const location = input.positions.get(key)
  if (!location) {
    return false
  }
  const lookup = input.lookups.get(location.dimension)
  if (!lookup) {
    return false
  }
  const conductive = lookup(location.position)
  input.conductivityAnswers?.set(key, conductive)
  return conductive
}

const powerContextFor = (input: TickPowerContextInput): PowerTickContext => ({
  faceBlockNeighboursOf: (key) => faceBlockNeighboursFor(input.positions, input.componentPositions, key),
  faceComponentNeighboursOf: (key) => faceComponentNeighboursFor(input.positions, input.componentPositions, key),
  faceLampNeighboursOf: (key) => faceReceiverNeighboursFor({
    componentPositions: input.componentPositions,
    key,
    kind: 'lamp',
    positions: input.positions,
  }),
  faceNeighboursOf: (key) => faceNeighboursFor(input.positions, key),
  faceSupportBlockNeighbourOf: (key) => faceSupportBlockNeighbourFor(input.positions, key),
  faceWireNeighboursOf: (key) => faceReceiverNeighboursFor({
    componentPositions: input.componentPositions,
    key,
    kind: 'wire',
    positions: input.positions,
  }),
  hasLampReceivers: input.hasLampReceivers,
  isRedstoneConductiveAt: (key) => redstoneConductiveAt(input, key),
  get previousBlockPower() { return input.previousBlockPower },
  retainBlockPower: input.retainBlockPower,
})

const snapshotRetainsBlockPower = (dimensions: ReadonlyMap<DimensionId, DimensionSnapshot>): boolean =>
  flattenSnapshotEntries(dimensions).some(({ component }) => BLOCK_POWER_READERS.has(component.kind))

const hasLampReceiver = (positions: ReadonlyMap<PositionKey, SnapshotPosition>): boolean =>
  [...positions.values()].some(({ kind }) => kind === 'lamp')

const makeNonConductiveContextFactory = (state: RedstoneWorldState): RedstonePowerTickContextFactory => {
  let previousBlockPower: ReadonlyMap<PositionKey, PowerTickBlockLevels> = EMPTY_BLOCK_POWER_MAP
  const context: PowerTickContext = { get previousBlockPower() { return previousBlockPower } }
  const bundle: RedstonePowerTickContextBundle = { captureProvenance: false, context }
  return (nextBlockPower) => {
    previousBlockPower = nextBlockPower
    if (observationRecorders.get(state)?.enabled === true) {
      return { captureProvenance: true, conductivityAnswers: new Map<PositionKey, boolean>(), context }
    }
    return bundle
  }
}

const makeConductiveContextFactory = (
  state: RedstoneWorldState,
  dimensions: ReadonlyMap<DimensionId, DimensionSnapshot>,
  lookups: ReadonlyMap<DimensionId, (position: RedstonePosition) => boolean>,
): RedstonePowerTickContextFactory => {
  const positions = positionsFromSnapshots(dimensions)
  const componentPositions = new Set(positions.keys())
  cacheSupportBlockNeighbours(positions, componentPositions)
  const input: TickPowerContextInput = {
    componentPositions,
    conductivityAnswers: null,
    hasLampReceivers: hasLampReceiver(positions),
    lookups,
    positions,
    previousBlockPower: EMPTY_BLOCK_POWER_MAP,
    retainBlockPower: snapshotRetainsBlockPower(dimensions),
  }
  const context = powerContextFor(input)
  const normalBundle: RedstonePowerTickContextBundle = { captureProvenance: false, context }
  return (previousBlockPower) => {
    input.previousBlockPower = previousBlockPower
    if (observationRecorders.get(state)?.enabled === true) {
      const conductivityAnswers = new Map<PositionKey, boolean>()
      input.conductivityAnswers = conductivityAnswers
      return { captureProvenance: true, conductivityAnswers, context }
    }
    input.conductivityAnswers = null
    return normalBundle
  }
}

/** Prepares stable snapshot geometry once, then supplies each tick's prior block power. */
const makeRedstonePowerTickContextFactory = (
  state: RedstoneWorldState,
  dimensions: ReadonlyMap<DimensionId, DimensionSnapshot>,
  lookups: ReadonlyMap<DimensionId, (position: RedstonePosition) => boolean>,
): RedstonePowerTickContextFactory => {
  if (lookups.size === NO_LOOKUPS) {
    return makeNonConductiveContextFactory(state)
  }
  return makeConductiveContextFactory(state, dimensions, lookups)
}

export const redstonePowerTickContextFactoryFor = (
  state: RedstoneWorldState,
): Effect.Effect<RedstonePowerTickContextFactory> => {
  const contextFactory = redstonePowerTickContextFactories.get(state)
  if (contextFactory) {
    return Effect.succeed(contextFactory)
  }
  return Effect.die(new Error('Redstone power context factory is missing for this world state'))
}

export const redstonePowerTickContextFor = (
  state: RedstoneWorldState,
  previousBlockPower: ReadonlyMap<PositionKey, PowerTickBlockLevels>,
): Effect.Effect<RedstonePowerTickContextBundle> =>
  Effect.flatMap(redstonePowerTickContextFactoryFor(state), (contextFactory) =>
    Effect.sync(() => contextFactory(previousBlockPower)),
  )

const circuitReadoutFor = (state: RedstoneWorldState): Effect.Effect<CircuitReadout> => Effect.gen(
  function* circuitReadoutForGenerator() {
    const [board, power, blockPower] = yield* Effect.all([
      Ref.get(state.board),
      Ref.get(state.power),
      Ref.get(state.blockPower),
    ], { concurrency: 1 })
    const { context } = yield* redstonePowerTickContextFor(state, blockPower)
    const powerReadContext: PowerReadContext = {
      blockPower,
      faceNeighboursOf: context.faceNeighboursOf ?? (() => []),
    }
    return { board, power, powerReadContext }
  },
)

const INITIAL_TICK_ACCUMULATOR_SECS = Schema.decodeUnknownSync(fixedDurationSecsSchema)(ZERO_DURATION_SECS)
const INITIAL_TICK_COUNT = Schema.decodeUnknownSync(nonNegativeTickCountSchema)(ZERO_TICK_COUNT)

export const makeRedstoneWorldState: Effect.Effect<RedstoneWorldState> = Effect.gen(
  function* makeRedstoneWorldStateGenerator() {
    const [
      dimensions,
      conductivityLookups,
      board,
      power,
      blockPower,
      timedCircuit,
      pendingButtonPresses,
      observedLamps,
      pendingLampTransitions,
      observedPistonStates,
      pendingPistonTransitions,
      observedTriggerPower,
      pendingTriggerEvents,
      pendingHopperTransferEvents,
      observedPoweredComponents,
      pendingPoweredComponentTransitions,
      tickAccumulatorSecs,
      tickCount,
    ] = yield* Effect.all([
      Ref.make(EMPTY_DIMENSIONS),
      Ref.make(EMPTY_CONDUCTIVITY_LOOKUPS),
      Ref.make<CircuitBoard>({ adjacency: new Map(), components: new Map() }),
      Ref.make<PowerMap>(emptyPowerMap),
      Ref.make<ReadonlyMap<PositionKey, PowerTickBlockLevels>>(new Map()),
      Ref.make<TimedCircuitState>(emptyTimedCircuitState),
      Ref.make<ReadonlySet<PositionKey>>(new Set()),
      Ref.make<ReadonlyMap<PositionKey, ObservedLamp>>(new Map()),
      Ref.make<ReadonlyArray<LampTransition>>([]),
      Ref.make<ReadonlyMap<PositionKey, PistonState>>(new Map()),
      Ref.make<ReadonlyArray<PoweredPistonTransition>>([]),
      Ref.make<ReadonlyMap<PositionKey, boolean>>(new Map()),
      Ref.make<ReadonlyArray<RedstoneTriggerEvent>>([]),
      Ref.make<ReadonlyArray<HopperTransferEvent>>([]),
      Ref.make<ReadonlyMap<PositionKey, boolean>>(new Map()),
      Ref.make<ReadonlyArray<PoweredComponentTransition>>([]),
      Ref.make(INITIAL_TICK_ACCUMULATOR_SECS),
      Ref.make(INITIAL_TICK_COUNT),
    ])
    const state: RedstoneWorldState = {
      blockPower,
      board,
      conductivityLookups,
      dimensions,
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
    redstonePowerTickContextFactories.set(
      state,
      makeRedstonePowerTickContextFactory(state, EMPTY_DIMENSIONS, EMPTY_CONDUCTIVITY_LOOKUPS),
    )
    return state
  },
)

const snapshotMap = (snapshot: RedstoneWorldSnapshot): DimensionSnapshot => {
  const components = new Map<PositionKey, RedstoneComponentSnapshot>()
  const orderedComponents = [...snapshot.components]
    .sort((left, right) => comparePositionCoordinates(left.position, right.position))
  for (const component of orderedComponents) {
    const copied = copyComponentSnapshot(component)
    components.set(redstoneNodeId(snapshot.dimension, copied.position), copied)
  }
  return components
}

const findDuplicateSnapshotPosition = (
  snapshot: RedstoneWorldSnapshot,
): Option.Option<RedstonePosition> => {
  const positions = new Set<PositionKey>()
  for (const component of snapshot.components) {
    const nodeId = redstoneNodeId(snapshot.dimension, component.position)
    if (positions.has(nodeId)) {
      return Option.some(component.position)
    }
    positions.add(nodeId)
  }
  return Option.none()
}

type NextSnapshotState = Readonly<{
  dimensions: ReadonlyMap<DimensionId, DimensionSnapshot>
  conductivityLookups: ReadonlyMap<DimensionId, (position: RedstonePosition) => boolean>
}>

const orderedSnapshotDimensions = (
  current: ReadonlyMap<DimensionId, DimensionSnapshot>,
  snapshot: RedstoneWorldSnapshot,
): ReadonlyMap<DimensionId, DimensionSnapshot> => {
  const next = new Map(current)
  next.set(snapshot.dimension, snapshotMap(snapshot))
  return new Map([...next].sort(([left], [right]) => compareDimensionIds(left, right)))
}

const snapshotConductivityLookups = (
  current: ReadonlyMap<DimensionId, (position: RedstonePosition) => boolean>,
  dimension: DimensionId,
  options?: RedstoneSnapshotSyncOptions,
): ReadonlyMap<DimensionId, (position: RedstonePosition) => boolean> => {
  const next = new Map(current)
  if (typeof options?.isRedstoneConductiveAt === 'function') {
    next.set(dimension, options.isRedstoneConductiveAt)
  } else {
    next.delete(dimension)
  }
  return next
}

const nextSnapshotStateFor = (
  state: RedstoneWorldState,
  snapshot: RedstoneWorldSnapshot,
  options?: RedstoneSnapshotSyncOptions,
): Effect.Effect<NextSnapshotState> => Effect.gen(function* nextSnapshotStateGenerator() {
  const [dimensions, conductivityLookups] = yield* Effect.all([
    Ref.get(state.dimensions),
    Ref.get(state.conductivityLookups),
  ], { concurrency: 1 })
  return {
    conductivityLookups: snapshotConductivityLookups(conductivityLookups, snapshot.dimension, options),
    dimensions: orderedSnapshotDimensions(dimensions, snapshot),
  }
})

const installSnapshotState = (state: RedstoneWorldState, next: NextSnapshotState): Effect.Effect<void> =>
  Effect.gen(function* installSnapshotStateGenerator() {
    yield* Ref.set(state.dimensions, next.dimensions)
    yield* Ref.set(state.conductivityLookups, next.conductivityLookups)
    yield* Ref.set(state.board, circuitBoardFromSnapshots(next.dimensions))
    redstonePowerTickContextFactories.set(
      state,
      makeRedstonePowerTickContextFactory(state, next.dimensions, next.conductivityLookups),
    )
  })

export const syncRedstoneSnapshot = (
  state: RedstoneWorldState,
  snapshot: RedstoneWorldSnapshot,
  options?: RedstoneSnapshotSyncOptions,
): Effect.Effect<void, Schema.SchemaError | RedstoneWorldSnapshotDuplicatePositionError> =>
  Effect.gen(function* syncRedstoneSnapshotGenerator() {
    const decoded = yield* Schema.decodeUnknownEffect(RedstoneWorldSnapshotSchema, { onExcessProperty: 'error' })(snapshot)
    const duplicatePosition = findDuplicateSnapshotPosition(decoded)
    if (Option.isSome(duplicatePosition)) {
      yield* Effect.fail({
        _tag: 'DuplicateRedstoneWorldSnapshotPosition',
        dimension: decoded.dimension,
        position: copyPosition(duplicatePosition.value),
      } satisfies RedstoneWorldSnapshotDuplicatePositionError)
    }
    const next = yield* nextSnapshotStateFor(state, decoded, options)
    yield* installSnapshotState(state, next)
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
    lit: isLit(circuit.board, circuit.power, { context: circuit.powerReadContext, key: nodeId }),
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
    const [circuit, dimensions, previous] = yield* Effect.all([
      circuitReadoutFor(state),
      Ref.get(state.dimensions),
      Ref.get(state.observedLamps),
    ])
    const entries = flattenSnapshotEntries(dimensions)
    const { changed, current } = collectLitLamps(circuit, entries, previous)
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
  const powered = isPowered(circuit.board, circuit.power, { context: circuit.powerReadContext, key: nodeId })
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
    const [circuit, dimensions, previous] = yield* Effect.all([
      circuitReadoutFor(state),
      Ref.get(state.dimensions),
      Ref.get(state.observedPistonStates),
    ])
    const entries = flattenSnapshotEntries(dimensions)
    const { changed, current } = computePistonTransitions(circuit, entries, previous)
    yield* Ref.set(state.observedPistonStates, current)
    if (changed.length > NO_ITEMS) {
      yield* Ref.update(state.pendingPistonTransitions, (pending) => [
        ...pending,
        ...changed.map(([, transition]) => transition),
      ])
    }
  })

const TRIGGERED_KINDS = new Set<ComponentKind>(['dispenser', 'dropper', 'note-block'])
const POWERED_KINDS = new Set<ComponentKind>(['powered-rail', 'door', 'trapdoor'])

const isTriggeredComponentKind = (kind: ComponentKind): kind is TriggeredComponentKind =>
  TRIGGERED_KINDS.has(kind)

const isPoweredComponentKind = (kind: ComponentKind): kind is PoweredComponentKind =>
  POWERED_KINDS.has(kind)

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
  const powered = isPowered(circuit.board, circuit.power, { context: circuit.powerReadContext, key: nodeId })
  const wasPowered = previous.get(nodeId) ?? false
  if (wasPowered || !powered || !isTriggeredComponentKind(component.kind)) {
    return { events: [], powered }
  }
  return {
    events: [[nodeId, {
      dimension,
      kind: component.kind,
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
    const [circuit, dimensions, previous] = yield* Effect.all([
      circuitReadoutFor(state),
      Ref.get(state.dimensions),
      Ref.get(state.observedTriggerPower),
    ])
    const entries = flattenSnapshotEntries(dimensions)
    const { current, triggered } = computeTriggerEvents(circuit, entries, previous)
    yield* Ref.set(state.observedTriggerPower, current)
    if (triggered.length > NO_ITEMS) {
      yield* Ref.update(state.pendingTriggerEvents, (pending) => [
        ...pending,
        ...triggered.map(([, event]) => event),
      ])
    }
  })

const computeHopperTransfers = (
  circuit: CircuitReadout,
  entries: NonEmptyReadonlyArray<SnapshotEntry>,
  elapsedRedstoneTicks: NonNegativeTickCount,
): NonEmptyReadonlyArray<readonly [PositionKey, HopperTransferEvent]> => {
  const eventFor = ({ component, dimension, nodeId }: SnapshotEntry) => [nodeId, {
    dimension,
    elapsedRedstoneTicks,
    position: copyPosition(component.position),
    powered: isPowered(circuit.board, circuit.power, { context: circuit.powerReadContext, key: nodeId }),
  }] as const
  const [first, ...rest] = entries
  return [eventFor(first), ...rest.map(eventFor)]
}

export const captureObservedTick = (
  state: RedstoneWorldState,
  context: RedstoneObservationTickContext,
  result: PowerTickWithProvenance,
): Effect.Effect<void> => Effect.gen(function* captureObservedTickGenerator() {
  const recorder = observationRecorders.get(state)
  if (recorder?.enabled !== true) {
    return
  }
  const [dimensions, timedCircuit, tickCount] = yield* Effect.all([
    Ref.get(state.dimensions),
    Ref.get(state.timedCircuit),
    Ref.get(state.tickCount),
  ], { concurrency: 1 })
  const tick = Schema.decodeUnknownSync(nonNegativeTickCountSchema)(tickCount + ONE_TICK)
  recorder.ticks.push({
    blockPower: copyBlockPower(result.blockPower),
    conductivityAnswers: new Map(context.conductivityAnswers),
    dimensions: copyDimensions(dimensions),
    power: new Map(result.power),
    provenance: copyProvenance(result.provenance),
    tick,
    timedCircuit: copyTimedCircuit(timedCircuit),
  })
  if (recorder.ticks.length > REDSTONE_OBSERVATION_HISTORY_LIMIT) {
    recorder.ticks.shift()
  }
})

/** Emits each hopper's power state and the elapsed redstone ticks for host planning. */
export const collectHopperTransferEvents = (
  state: RedstoneWorldState,
  ticks: NonNegativeTickCount,
): Effect.Effect<void> =>
  Effect.gen(function* collectHopperTransferEventsGenerator() {
    const dimensions = yield* Ref.get(state.dimensions)
    const entries = hopperEntriesFromSnapshots(dimensions)
    if (!isNonEmptyReadonlyArray(entries)) {
      return
    }
    const circuit = yield* circuitReadoutFor(state)
    const transfers = computeHopperTransfers(circuit, entries, ticks)
    yield* Ref.update(state.pendingHopperTransferEvents, (pending) => [
      ...pending,
      ...transfers.map(([, event]) => event),
    ])
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
  const powered = isPowered(circuit.board, circuit.power, { context: circuit.powerReadContext, key: nodeId })
  const observed = previous.get(nodeId) ?? component.powered ?? false
  if (observed === powered || !isPoweredComponentKind(component.kind)) {
    return { powered, transitions: [] }
  }
  return {
    powered,
    transitions: [[nodeId, {
      dimension,
      kind: component.kind,
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
    const [circuit, dimensions, previous] = yield* Effect.all([
      circuitReadoutFor(state),
      Ref.get(state.dimensions),
      Ref.get(state.observedPoweredComponents),
    ])
    const entries = flattenSnapshotEntries(dimensions)
    const { changed, current } = computePoweredComponentTransitions(circuit, entries, previous)
    yield* Ref.set(state.observedPoweredComponents, current)
    if (changed.length > NO_ITEMS) {
      yield* Ref.update(state.pendingPoweredComponentTransitions, (pending) => [
        ...pending,
        ...changed.map(([, transition]) => transition),
      ])
    }
  })

const runtimeStates = new WeakMap<RedstoneWorldRuntimeService, RedstoneWorldState>()

export type RedstoneWorldRuntimeStateError = {
  readonly _tag: 'UnregisteredRedstoneWorldRuntime'
  readonly message: 'RedstoneWorldRuntime was not created by makeRedstoneWorldRuntime'
}

export const RedstoneWorldRuntimeStateErrorSchema: Schema.Codec<RedstoneWorldRuntimeStateError, unknown> =
  structSchema({
    _tag: literalSchema('UnregisteredRedstoneWorldRuntime'),
    message: literalSchema('RedstoneWorldRuntime was not created by makeRedstoneWorldRuntime'),
  })

export const redstoneWorldStateFor = (
  runtime: RedstoneWorldRuntimeService,
): Effect.Effect<RedstoneWorldState, RedstoneWorldRuntimeStateError> => {
  const state = runtimeStates.get(runtime)
  if (typeof state === 'undefined') {
    return Effect.fail({
      _tag: 'UnregisteredRedstoneWorldRuntime',
      message: 'RedstoneWorldRuntime was not created by makeRedstoneWorldRuntime',
    })
  }
  return Effect.succeed(state)
}

const enableObservationRecorder = (
  state: RedstoneWorldState,
  recorder: ObservationRecorder | undefined,
): Effect.Effect<void> => Effect.sync(() => {
  if (recorder) {
    recorder.enabled = true
    return
  }
  observationRecorders.set(state, { enabled: true, ticks: [] })
})

/** Enables or disables per-tick captures for internal observation consumers. */
export const setRedstoneObservationEnabled = (
  runtime: RedstoneWorldRuntimeService,
  enabled: boolean,
): Effect.Effect<void, RedstoneWorldRuntimeStateError> => Effect.gen(function* setRedstoneObservationEnabledGenerator() {
  const state = yield* redstoneWorldStateFor(runtime)
  const recorder = observationRecorders.get(state)
  if (enabled) {
    if (recorder?.enabled) {
      return
    }
    yield* enableObservationRecorder(state, recorder)
    return
  }
  if (recorder) {
    recorder.enabled = false
  }
})

/** Returns isolated copies of recorded ticks; reading history never changes the runtime. */
export const redstoneTickObservationsFor = (
  runtime: RedstoneWorldRuntimeService,
): Effect.Effect<ReadonlyArray<RedstoneTickObservation>, RedstoneWorldRuntimeStateError> =>
  Effect.map(redstoneWorldStateFor(runtime), (state) =>
    (observationRecorders.get(state)?.ticks ?? []).map(copyTickObservation),
  )

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
      restoreEvents: (events) =>
        Effect.uninterruptible(
          Effect.all([
            Ref.update(state.pendingHopperTransferEvents, (pending) => [...events.hopper, ...pending]),
            Ref.update(state.pendingLampTransitions, (pending) => [...events.lamp, ...pending]),
            Ref.update(state.pendingPistonTransitions, (pending) => [...events.piston, ...pending]),
            Ref.update(state.pendingPoweredComponentTransitions, (pending) => [...events.powered, ...pending]),
            Ref.update(state.pendingTriggerEvents, (pending) => [...events.trigger, ...pending]),
          ], { concurrency: 1, discard: true }),
        ),
      syncSnapshot: (snapshot, options) => syncRedstoneSnapshot(state, snapshot, options),
    }
    runtimeStates.set(runtime, state)
    return runtime
  },
)

export const RedstoneWorldRuntimeLayer: Layer.Layer<RedstoneWorldRuntime> = Layer.effect(
  RedstoneWorldRuntime,
  makeRedstoneWorldRuntime,
)
