import { BlockPositionSchema, type NonNegativeTickCount } from '@nerima-games/mc-kernel'
import type { ButtonTimer, RepeaterTimer, TorchTimer } from '../domain/power-timing.js'
import {
  type CircuitBoard,
  type Component,
  type ComponentKind,
  MAX_POWER_LEVEL,
  type PowerLevel,
  type PowerTickBlockLevels,
  powerAt,
} from '../domain/power-graph.js'
import { Effect, Option, Ref, Schema } from 'effect'
import {
  type RedstoneComponentSnapshot,
  type RedstonePosition,
  type RedstoneWorldRuntimeService,
  type RedstoneWorldRuntimeStateError,
  type RedstoneWorldSnapshot,
  type RedstoneWorldState,
  redstoneNodeId,
  redstoneWorldStateFor,
} from './world-runtime.js'
import type { PositionKey } from '../domain/position-key.js'

export type RedstoneCellTimers = {
  readonly button?: ButtonTimer
  readonly repeater?: RepeaterTimer
  readonly torch?: TorchTimer
}

export type RedstoneCellDynamicState = Omit<RedstoneComponentSnapshot, 'kind' | 'position'> & {
  readonly timers: RedstoneCellTimers
}

export type RedstoneCellObservation = {
  readonly position: RedstoneComponentSnapshot['position']
  readonly kind: ComponentKind
  readonly dynamicState: RedstoneCellDynamicState
  readonly power: PowerLevel
}

export type RedstoneDimensionObservation = {
  readonly dimension: RedstoneWorldSnapshot['dimension']
  readonly cells: ReadonlyArray<RedstoneCellObservation>
}

export type RedstoneFrameObservation = {
  readonly tick: NonNegativeTickCount
  readonly dimensions: ReadonlyArray<RedstoneDimensionObservation>
  readonly pendingButtonPresses: ReadonlySet<PositionKey>
}

export type RedstoneInvariantId =
  | 'power-level-range'
  | 'wire-neighbor-decay'
  | 'torch-support-exclusion'
  | 'block-power-channel-consistency'

export type RedstoneInvariantViolation = Readonly<{
  dimension: RedstoneWorldSnapshot['dimension']
  position: RedstoneComponentSnapshot['position']
}>

export type RedstoneInvariantResult = Readonly<{
  id: RedstoneInvariantId
  passed: boolean
  violations: ReadonlyArray<RedstoneInvariantViolation>
}>

type InvariantComponent = Readonly<{
  dimension: RedstoneWorldSnapshot['dimension']
  key: PositionKey
  position: RedstoneComponentSnapshot['position']
  snapshot: RedstoneComponentSnapshot
  component: Component
}>

type ExpectedBlockPower = Readonly<{
  channels: ReadonlyMap<PositionKey, PowerTickBlockLevels>
  locations: ReadonlyMap<PositionKey, RedstoneInvariantViolation>
}>

type InvariantReadout = Readonly<{
  dimensions: ReadonlyMap<RedstoneWorldSnapshot['dimension'], ReadonlyMap<PositionKey, RedstoneComponentSnapshot>>
  board: CircuitBoard
  power: ReadonlyMap<PositionKey, PowerLevel>
  blockPower: ReadonlyMap<PositionKey, PowerTickBlockLevels>
  conductivityLookups: ReadonlyMap<RedstoneWorldSnapshot['dimension'], (position: RedstonePosition) => boolean>
}>

type ExpectedBlockPowerInput = Readonly<{
  components: ReadonlyArray<InvariantComponent>
  board: CircuitBoard
  power: ReadonlyMap<PositionKey, PowerLevel>
  conductivityLookups: InvariantReadout['conductivityLookups']
}>

type BlockPowerCollector = Readonly<{
  input: ExpectedBlockPowerInput
  channels: Map<PositionKey, PowerTickBlockLevels>
  locations: Map<PositionKey, RedstoneInvariantViolation>
  conductivityAnswers: Map<PositionKey, boolean>
}>

type BlockPowerNeighborInput = Readonly<{
  collector: BlockPowerCollector
  entry: InvariantComponent
  position: RedstonePosition
  key: PositionKey
}>

type ExpectedWirePowerInput = Readonly<{
  entry: InvariantComponent
  board: CircuitBoard
  power: ReadonlyMap<PositionKey, PowerLevel>
  blockPower: ReadonlyMap<PositionKey, PowerTickBlockLevels>
}>

type DrivenNeighborInput = Readonly<{
  board: CircuitBoard
  power: ReadonlyMap<PositionKey, PowerLevel>
  neighbourKey: PositionKey
  targetKey: PositionKey
}>

type ViolationCollector = Readonly<{
  violations: Array<RedstoneInvariantViolation>
  positions: Set<PositionKey>
}>

type InvariantCheckContext = Readonly<{
  readout: InvariantReadout
  components: ReadonlyArray<InvariantComponent>
  componentLocations: ReadonlyMap<PositionKey, RedstoneInvariantViolation>
  expectedBlockPower: ExpectedBlockPower
  blockPowerRetained: boolean
}>

type InvalidPowerInput = Readonly<{
  level: PowerLevel
  location: RedstoneInvariantViolation
  collector: ViolationCollector
}>

type PositionOffset = Readonly<{ x: number; y: number; z: number }>

const ZERO_POWER_LEVEL = 0
const WIRE_SIGNAL_DECAY = 1
const NO_BLOCK_POWER: PowerTickBlockLevels = { strongLevel: ZERO_POWER_LEVEL, weakLevel: ZERO_POWER_LEVEL }
const FACE_OFFSETS: ReadonlyArray<PositionOffset> = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
]

const POWER_DRIVER_KINDS: ReadonlySet<ComponentKind> = new Set([
  'wire', 'lever', 'button', 'torch', 'repeater', 'comparator', 'observer', 'pressure-plate', 'target',
])

const BLOCK_POWER_READER_KINDS: ReadonlySet<ComponentKind> = new Set([
  'comparator', 'dispenser', 'door', 'dropper', 'hopper', 'lamp', 'note-block', 'piston',
  'powered-rail', 'repeater', 'torch', 'trapdoor',
])

const positionAtOffset = (
  position: RedstonePosition,
  offset: PositionOffset,
): Option.Option<RedstonePosition> => {
  const x = position.x + offset.x
  const y = position.y + offset.y
  const z = position.z + offset.z
  if (![x, y, z].every(Number.isSafeInteger)) {
    return Option.none()
  }
  return Option.some(Schema.decodeUnknownSync(BlockPositionSchema)({ x, y, z }))
}

const faceNeighbours = (position: RedstonePosition): ReadonlyArray<RedstonePosition> =>
  FACE_OFFSETS.flatMap((offset) => Option.match(positionAtOffset(position, offset), {
    onNone: () => [],
    onSome: (neighbour) => [neighbour],
  }))

const componentDrivesInto = (component: Component, target: PositionKey): boolean => {
  if (!POWER_DRIVER_KINDS.has(component.kind)) {
    return false
  }
  if (component.kind === 'repeater' || component.kind === 'comparator' || component.kind === 'observer') {
    return component.outputTo === target
  }
  return component.kind !== 'torch' || component.invertedBy !== target
}

const torchBlockPowerChannelFor = (component: Component, target: PositionKey): 'none' | 'strong' | 'weak' => {
  if (component.invertedBy === target) {
    return 'none'
  }
  if (component.strongPowerTo === target) {
    return 'strong'
  }
  return 'weak'
}

const directionalStrongPowerTarget = (component: Component): Option.Option<PositionKey> => {
  if (component.kind === 'lever' || component.kind === 'button' || component.kind === 'pressure-plate') {
    return Option.fromUndefinedOr(component.strongPowerTo)
  }
  if (component.kind === 'observer' || component.kind === 'repeater' || component.kind === 'comparator') {
    return Option.fromUndefinedOr(component.outputTo)
  }
  return Option.none()
}

const blockPowerChannelFor = (component: Component, target: PositionKey): 'none' | 'strong' | 'weak' => {
  if (component.kind === 'torch') {
    return torchBlockPowerChannelFor(component, target)
  }
  if (component.kind === 'wire') {
    return 'weak'
  }
  return Option.match(directionalStrongPowerTarget(component), {
    onNone: () => 'none',
    onSome: (strongTarget) => {
      if (strongTarget === target) {
        return 'strong'
      }
      return 'none'
    },
  })
}

type AddBlockChannelInput = Readonly<{
  channels: Map<PositionKey, PowerTickBlockLevels>
  key: PositionKey
  channel: 'strong' | 'weak'
  level: PowerLevel
}>

const addBlockChannel = (input: AddBlockChannelInput): void => {
  const previous = input.channels.get(input.key) ?? NO_BLOCK_POWER
  if (input.channel === 'strong') {
    input.channels.set(input.key, {
      strongLevel: Math.max(previous.strongLevel, input.level),
      weakLevel: previous.weakLevel,
    })
    return
  }
  input.channels.set(input.key, {
    strongLevel: previous.strongLevel,
    weakLevel: Math.max(previous.weakLevel, input.level),
  })
}

const conductiveAt = (input: BlockPowerNeighborInput): boolean => {
  const { collector, entry, key, position } = input
  return Option.match(Option.fromUndefinedOr(collector.conductivityAnswers.get(key)), {
    onNone: () => {
      const lookup = Option.fromUndefinedOr(collector.input.conductivityLookups.get(entry.dimension))
      const conductive = Option.match(lookup, {
        onNone: () => false,
        onSome: (isConductiveAt) => isConductiveAt(position),
      })
      collector.conductivityAnswers.set(key, conductive)
      return conductive
    },
    onSome: (cachedAnswer) => cachedAnswer,
  })
}

const recordExpectedBlockPower = (input: BlockPowerNeighborInput): void => {
  const { collector, entry, key, position } = input
  if (!collector.locations.has(key)) {
    collector.locations.set(key, { dimension: entry.dimension, position })
  }
  const level = powerAt(collector.input.power, entry.key)
  if (
    level <= ZERO_POWER_LEVEL ||
    collector.input.board.components.has(key)
  ) {
    return
  }
  const channel = blockPowerChannelFor(entry.component, key)
  if (channel === 'none' || !conductiveAt(input)) {
    return
  }
  addBlockChannel({ channel, channels: collector.channels, key, level })
}

const expectedBlockPowerFor = (input: ExpectedBlockPowerInput): ExpectedBlockPower => {
  const collector: BlockPowerCollector = {
    channels: new Map(),
    conductivityAnswers: new Map(),
    input,
    locations: new Map(),
  }
  for (const entry of input.components) {
    for (const position of faceNeighbours(entry.position)) {
      const key = redstoneNodeId(entry.dimension, position)
      recordExpectedBlockPower({ collector, entry, key, position })
    }
  }
  return { channels: collector.channels, locations: collector.locations }
}

const validPowerLevel = (level: PowerLevel): boolean =>
  Number.isInteger(level) && level >= ZERO_POWER_LEVEL && level <= MAX_POWER_LEVEL

const invariantResult = (
  id: RedstoneInvariantId,
  violations: ReadonlyArray<RedstoneInvariantViolation>,
): RedstoneInvariantResult => ({ id, passed: violations.length === ZERO_POWER_LEVEL, violations })

const addViolation = (
  violations: Array<RedstoneInvariantViolation>,
  positions: Set<PositionKey>,
  location: RedstoneInvariantViolation,
): void => {
  const key = redstoneNodeId(location.dimension, location.position)
  if (!positions.has(key)) {
    positions.add(key)
    violations.push(location)
  }
}

const invariantComponentsFor = (
  dimensions: ReadonlyMap<RedstoneWorldSnapshot['dimension'], ReadonlyMap<PositionKey, RedstoneComponentSnapshot>>,
  board: CircuitBoard,
): ReadonlyArray<InvariantComponent> => {
  const components: Array<InvariantComponent> = []
  for (const [dimension, snapshots] of dimensions) {
    for (const [key, snapshot] of snapshots) {
      Option.match(Option.fromUndefinedOr(board.components.get(key)), {
        onNone: () => false,
        onSome: (component) => {
          components.push({ component, dimension, key, position: snapshot.position, snapshot })
          return true
        },
      })
    }
  }
  return components
}

const drivenNeighbourPower = (input: DrivenNeighborInput): PowerLevel =>
  Option.match(Option.fromUndefinedOr(input.board.components.get(input.neighbourKey)), {
    onNone: () => ZERO_POWER_LEVEL,
    onSome: (neighbour) => {
      if (!componentDrivesInto(neighbour, input.targetKey)) {
        return ZERO_POWER_LEVEL
      }
      const neighbourPower = powerAt(input.power, input.neighbourKey)
      if (neighbour.kind === 'wire') {
        return Math.max(ZERO_POWER_LEVEL, neighbourPower - WIRE_SIGNAL_DECAY)
      }
      return neighbourPower
    },
  })

const expectedWirePowerAt = (input: ExpectedWirePowerInput): PowerLevel => {
  const { entry, board, power, blockPower } = input
  let expected = ZERO_POWER_LEVEL
  for (const neighbourKey of board.adjacency.get(entry.key) ?? []) {
    expected = Math.max(expected, drivenNeighbourPower({
      board,
      neighbourKey,
      power,
      targetKey: entry.key,
    }))
  }
  for (const position of faceNeighbours(entry.position)) {
    const neighbourKey = redstoneNodeId(entry.dimension, position)
    expected = Math.max(expected, blockPower.get(neighbourKey)?.strongLevel ?? ZERO_POWER_LEVEL)
  }
  return expected
}

const recordInvalidPower = (input: InvalidPowerInput): void => {
  if (!validPowerLevel(input.level)) {
    addViolation(input.collector.violations, input.collector.positions, input.location)
  }
}

const powerRangeViolationsFor = (context: InvariantCheckContext): ReadonlyArray<RedstoneInvariantViolation> => {
  const collector: ViolationCollector = { positions: new Set(), violations: [] }
  const { readout, componentLocations, expectedBlockPower } = context
  for (const [key, location] of componentLocations) {
    recordInvalidPower({ collector, level: readout.power.get(key) ?? ZERO_POWER_LEVEL, location })
  }
  for (const [key, location] of expectedBlockPower.locations) {
    const channels = readout.blockPower.get(key) ?? NO_BLOCK_POWER
    recordInvalidPower({
      collector,
      level: channels.strongLevel,
      location,
    })
    recordInvalidPower({
      collector,
      level: channels.weakLevel,
      location,
    })
  }
  return collector.violations
}

const wirePowerViolationsFor = (context: InvariantCheckContext): ReadonlyArray<RedstoneInvariantViolation> => {
  const collector: ViolationCollector = { positions: new Set(), violations: [] }
  const { readout, components, expectedBlockPower } = context
  for (const entry of components) {
    if (entry.component.kind === 'wire') {
      const actual = powerAt(readout.power, entry.key)
      const expected = expectedWirePowerAt({
        blockPower: expectedBlockPower.channels,
        board: readout.board,
        entry,
        power: readout.power,
      })
      if (actual !== expected) {
        addViolation(collector.violations, collector.positions, {
          dimension: entry.dimension,
          position: entry.position,
        })
      }
    }
  }
  return collector.violations
}

const sameBlockPower = (left: PowerTickBlockLevels, right: PowerTickBlockLevels): boolean =>
  left.strongLevel === right.strongLevel && left.weakLevel === right.weakLevel

type BlockPowerViolationInput = Readonly<{
  context: InvariantCheckContext
  collector: ViolationCollector
  key: PositionKey
  location: RedstoneInvariantViolation
}>

const recordBlockPowerViolation = (input: BlockPowerViolationInput): void => {
  const expected = input.context.expectedBlockPower.channels.get(input.key) ?? NO_BLOCK_POWER
  const actual = input.context.readout.blockPower.get(input.key) ?? NO_BLOCK_POWER
  if (!sameBlockPower(actual, expected)) {
    addViolation(input.collector.violations, input.collector.positions, input.location)
  }
}

const blockPowerChannelViolationsFor = (
  context: InvariantCheckContext,
): ReadonlyArray<RedstoneInvariantViolation> => {
  const collector: ViolationCollector = { positions: new Set(), violations: [] }
  if (!context.blockPowerRetained) {
    return collector.violations
  }
  for (const [key, location] of context.expectedBlockPower.locations) {
    recordBlockPowerViolation({ collector, context, key, location })
  }
  return collector.violations
}

const recordTorchSupportViolation = (
  context: InvariantCheckContext,
  collector: ViolationCollector,
  entry: InvariantComponent,
): void => {
  if (entry.component.kind !== 'torch') {
    return
  }
  Option.match(Option.fromUndefinedOr(entry.snapshot.invertedBy), {
    onNone: () => false,
    onSome: (support) => {
      const key = redstoneNodeId(entry.dimension, support)
      const actual = context.readout.blockPower.get(key) ?? NO_BLOCK_POWER
      const permitted = context.expectedBlockPower.channels.get(key) ?? NO_BLOCK_POWER
      if (actual.strongLevel > permitted.strongLevel || actual.weakLevel > permitted.weakLevel) {
        addViolation(collector.violations, collector.positions, { dimension: entry.dimension, position: support })
        return true
      }
      return false
    },
  })
}

const torchSupportViolationsFor = (context: InvariantCheckContext): ReadonlyArray<RedstoneInvariantViolation> => {
  const collector: ViolationCollector = { positions: new Set(), violations: [] }
  if (context.blockPowerRetained) {
    for (const entry of context.components) {
      recordTorchSupportViolation(context, collector, entry)
    }
  }
  return collector.violations
}

const invariantResultsFor = (readout: InvariantReadout): ReadonlyArray<RedstoneInvariantResult> => {
  const components = invariantComponentsFor(readout.dimensions, readout.board)
  const componentLocations = new Map(components.map((entry) => [entry.key, {
    dimension: entry.dimension,
    position: entry.position,
  }]))
  const expectedBlockPower = expectedBlockPowerFor({
    board: readout.board,
    components,
    conductivityLookups: readout.conductivityLookups,
    power: readout.power,
  })
  const context: InvariantCheckContext = {
    blockPowerRetained: components.some((entry) => BLOCK_POWER_READER_KINDS.has(entry.component.kind)),
    componentLocations,
    components,
    expectedBlockPower,
    readout,
  }
  return [
    invariantResult('power-level-range', powerRangeViolationsFor(context)),
    invariantResult('wire-neighbor-decay', wirePowerViolationsFor(context)),
    invariantResult('torch-support-exclusion', torchSupportViolationsFor(context)),
    invariantResult('block-power-channel-consistency', blockPowerChannelViolationsFor(context)),
  ]
}

const invariantReadoutFor = (state: RedstoneWorldState): Effect.Effect<InvariantReadout> =>
  Effect.all({
    blockPower: Ref.get(state.blockPower),
    board: Ref.get(state.board),
    conductivityLookups: Ref.get(state.conductivityLookups),
    dimensions: Ref.get(state.dimensions),
    power: Ref.get(state.power),
  }, { concurrency: 1 })

const copyPosition = (
  position: RedstoneComponentSnapshot['position'],
): RedstoneComponentSnapshot['position'] => ({
  x: position.x,
  y: position.y,
  z: position.z,
})

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

const copySnapshotDynamicState = (
  component: RedstoneComponentSnapshot,
): Omit<RedstoneComponentSnapshot, 'kind' | 'position'> => ({
  ...withOptional('active', component.active),
  ...withOptional('containerSignal', component.containerSignal),
  ...withOptionalMapped('containerSlots', component.containerSlots, (slots) => slots.map((slot) => ({ ...slot }))),
  ...withOptional('delayTicks', component.delayTicks),
  ...withOptional('emits', component.emits),
  ...withOptionalMapped('inputFrom', component.inputFrom, copyPosition),
  ...withOptionalMapped('invertedBy', component.invertedBy, copyPosition),
  ...withOptional('mode', component.mode),
  ...withOptionalMapped('outputTo', component.outputTo, copyPosition),
  ...withOptionalMapped('strongPowerTo', component.strongPowerTo, copyPosition),
  ...withOptional('pistonFacing', component.pistonFacing),
  ...withOptional('pistonKind', component.pistonKind),
  ...withOptional('pistonState', component.pistonState),
  ...withOptional('powered', component.powered),
  ...withOptional('pulseTicks', component.pulseTicks),
  ...withOptionalMapped('sideInputs', component.sideInputs, (positions) => positions.map(copyPosition)),
})

const copyCellTimers = (
  nodeId: PositionKey,
  timedCircuit: {
    readonly buttons: ReadonlyMap<PositionKey, ButtonTimer>
    readonly repeaters: ReadonlyMap<PositionKey, RepeaterTimer>
    readonly torches?: ReadonlyMap<PositionKey, TorchTimer>
  },
): RedstoneCellTimers => {
  const button = timedCircuit.buttons.get(nodeId)
  const repeater = timedCircuit.repeaters.get(nodeId)
  const torch = timedCircuit.torches?.get(nodeId)

  return {
    ...withOptionalMapped('button', button, (timer) => ({ ...timer })),
    ...withOptionalMapped('repeater', repeater, (timer) => ({ ...timer })),
    ...withOptionalMapped('torch', torch, (timer) => ({ ...timer, recentOffTicks: [...timer.recentOffTicks] })),
  }
}

export const observeRedstoneFrame = (
  runtime: RedstoneWorldRuntimeService,
): Effect.Effect<RedstoneFrameObservation, RedstoneWorldRuntimeStateError> =>
  Effect.gen(function* observeRedstoneFrameGenerator() {
    const state = yield* redstoneWorldStateFor(runtime)
    const [dimensions, power, timedCircuit, tick, pendingButtonPresses] = yield* Effect.all([
      Ref.get(state.dimensions),
      Ref.get(state.power),
      Ref.get(state.timedCircuit),
      Ref.get(state.tickCount),
      Ref.get(state.pendingButtonPresses),
    ], { concurrency: 1 })

    return {
      dimensions: [...dimensions].map(([dimension, snapshots]) => ({
        cells: [...snapshots.values()].map((component) => {
          const nodeId = redstoneNodeId(dimension, component.position)
          return {
            dynamicState: {
              ...copySnapshotDynamicState(component),
              timers: copyCellTimers(nodeId, timedCircuit),
            },
            kind: component.kind,
            position: copyPosition(component.position),
            power: powerAt(power, nodeId),
          }
        }),
        dimension,
      })),
      pendingButtonPresses: new Set(pendingButtonPresses),
      tick,
    }
  })

export const checkRedstoneInvariants = (
  runtime: RedstoneWorldRuntimeService,
): Effect.Effect<ReadonlyArray<RedstoneInvariantResult>, RedstoneWorldRuntimeStateError> =>
  Effect.gen(function* checkRedstoneInvariantsGenerator() {
    const state = yield* redstoneWorldStateFor(runtime)
    const readout = yield* invariantReadoutFor(state)
    return invariantResultsFor(readout)
  })
