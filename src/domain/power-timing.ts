import {
  type CircuitBoard,
  type Component,
  MAX_POWER_LEVEL,
  type PowerMap,
  type PowerProvenanceCandidate,
  type PowerTickBlockLevels,
  type PowerTickContext,
  type PowerTickWithProvenance,
  componentEntriesForKinds,
  emptyPowerMap,
  powerAt,
  propagateTick,
  propagateTickState,
  propagateTickWithProvenance,
} from './power-graph.js'
import { type NonNegativeTickCount, NonNegativeTickCount as nonNegativeTickCount } from '@nerima-games/mc-kernel'
import { OBSERVER_PULSE_TICKS, type Sightings, observeChanges } from './observer.js'
import { type PlateOccupants, type PressurePlateKind, plateCheckTicks, plateOccupantSignal } from './pressure-plate.js'
import { type TargetHit, targetHoldTicks, targetSignal } from './target-block.js'
import type { PositionKey } from './position-key.js'
import type { PowerLevel } from './signal-level.js'

const TIMED_COMPONENT_KINDS: ReadonlySet<Component['kind']> = new Set([
  'repeater',
  'button',
  'observer',
  'pressure-plate',
  'target',
  'torch',
])
const OBSERVER_COMPONENT_KINDS: ReadonlySet<Component['kind']> = new Set(['observer'])

export const DEFAULT_BUTTON_PULSE_TICKS = 10
export const TORCH_BURNOUT_TOGGLE_LIMIT = 8
export const TORCH_BURNOUT_WINDOW_TICKS = 30
/** Delay before a burned-out torch is sampled for relighting. */
export const TORCH_BURNOUT_COOLDOWN_TICKS = 80

const NO_TICKS = 0
const NO_OCCUPANTS: PlateOccupants = { living: 0, other: 0 }
const NEXT_TICK = 1
/** The power level meaning "unpowered". */
const NO_POWER_LEVEL = 0
/** A freshly placed repeater's delay, and the shortest delay it can be set to. */
const MIN_REPEATER_DELAY_TICKS = 1
/** The longest delay a repeater can be set to (four right-clicks). */
const MAX_REPEATER_DELAY_TICKS = 4
/** The shortest a button's pulse can be truncated to. */
const MIN_BUTTON_PULSE_TICKS = 1
const EMPTY_PREVIOUS_BLOCK_POWER: ReadonlyMap<PositionKey, PowerTickBlockLevels> = new Map()

export type RepeaterTimer = {
  readonly output: boolean
  readonly pendingOutput?: boolean
  readonly remainingTicks: number
}

export type ButtonTimer = {
  readonly remainingTicks: number
  readonly inputActive: boolean
}

export type TorchTimer = {
  readonly burnedOut?: boolean
  readonly cooldownTicks?: NonNegativeTickCount
  readonly output: boolean
  readonly recentOffTicks: ReadonlyArray<number>
}

export type ObserverTimer = {
  readonly output: boolean
  readonly remainingTicks: number
}

/** A target kept powered by a hit: `remainingTicks` more powered ticks follow the current one. */
export type TargetTimer = {
  readonly level: PowerLevel
  readonly remainingTicks: NonNegativeTickCount
}

/** A plate that is powered: its signal holds until `remainingTicks` more ticks have passed. */
export type PlateTimer = {
  readonly remainingTicks: NonNegativeTickCount
  readonly strength: PowerLevel
}

export type TimedCircuitState = {
  readonly power: PowerMap
  readonly repeaters: ReadonlyMap<PositionKey, RepeaterTimer>
  readonly buttons: ReadonlyMap<PositionKey, ButtonTimer>
  /** Optional so states constructed before torch burnout support remain valid. */
  readonly torches?: ReadonlyMap<PositionKey, TorchTimer>
  readonly observers?: ReadonlyMap<PositionKey, ObserverTimer>
  readonly observerSeen?: Sightings
  readonly plates?: ReadonlyMap<PositionKey, PlateTimer>
  readonly targets?: ReadonlyMap<PositionKey, TargetTimer>
}

type TimedCircuitInput = TimedCircuitState & {
  readonly blockPower?: ReadonlyMap<PositionKey, PowerTickBlockLevels>
}

type TimedCircuitAdvanceInput = {
  readonly board: CircuitBoard
  readonly previous: TimedCircuitInput
  readonly pressedButtons?: ReadonlySet<PositionKey>
  readonly targetHits?: ReadonlyMap<PositionKey, TargetHit>
  readonly context?: PowerTickContext
}

export type TimedCircuitWithBlockPower = Omit<TimedCircuitState, 'observers' | 'observerSeen' | 'plates' | 'targets' | 'torches'> & {
  readonly blockPower: ReadonlyMap<PositionKey, PowerTickBlockLevels>
  readonly observerSeen: Sightings
  readonly observers: ReadonlyMap<PositionKey, ObserverTimer>
  readonly plates: ReadonlyMap<PositionKey, PlateTimer>
  readonly targets: ReadonlyMap<PositionKey, TargetTimer>
  readonly torches: ReadonlyMap<PositionKey, TorchTimer>
}

export type TimedCircuitWithProvenance = TimedCircuitWithBlockPower & {
  readonly provenance: ReadonlyMap<PositionKey, ReadonlyArray<PowerProvenanceCandidate>>
}

export const emptyTimedCircuitState: TimedCircuitState = {
  buttons: new Map(),
  observerSeen: new Map(),
  observers: new Map(),
  plates: new Map(),
  power: emptyPowerMap,
  repeaters: new Map(),
  targets: new Map(),
  torches: new Map(),
}

const repeaterDelay = (component: Component): number =>
  Math.max(
    MIN_REPEATER_DELAY_TICKS,
    Math.min(MAX_REPEATER_DELAY_TICKS, Math.trunc(component.delayTicks ?? MIN_REPEATER_DELAY_TICKS)),
  )

const buttonDuration = (component: Component): number =>
  Math.max(MIN_BUTTON_PULSE_TICKS, Math.trunc(component.pulseTicks ?? DEFAULT_BUTTON_PULSE_TICKS))

/** How many ticks remain before `requestedOutput` takes effect. */
const nextRemainingTicks = (
  previous: RepeaterTimer | undefined,
  requestedOutput: boolean,
  delayTicks: number,
): number => {
  if (previous?.pendingOutput === requestedOutput) {
    return previous.remainingTicks - NEXT_TICK
  }
  return delayTicks - NEXT_TICK
}

const advanceRepeater = (
  previous: RepeaterTimer | undefined,
  requestedOutput: boolean,
  delayTicks: number,
): RepeaterTimer => {
  const output = previous?.output ?? false
  // A scheduled rising edge survives an input pulse shorter than the delay.
  const pendingOutput = previous?.pendingOutput === true || requestedOutput
  if (pendingOutput === output) {
    return { output, remainingTicks: NO_TICKS }
  }

  const remaining = nextRemainingTicks(previous, pendingOutput, delayTicks)
  if (remaining <= NO_TICKS) {
    if (pendingOutput && !requestedOutput) {
      return { output: true, pendingOutput: false, remainingTicks: delayTicks }
    }
    return { output: pendingOutput, remainingTicks: NO_TICKS }
  }
  return { output, pendingOutput, remainingTicks: remaining }
}

const repeaterIsLocked = (component: Component, previous: PowerMap): boolean => {
  if (typeof component.locked === 'boolean') {
    return component.locked
  }
  return (component.sideInputs ?? []).some((side) => powerAt(previous, side) > NO_POWER_LEVEL)
}

const holdRepeater = (previous: RepeaterTimer | undefined): RepeaterTimer => ({
  output: previous?.output ?? false,
  remainingTicks: NO_TICKS,
})

const advanceOrHoldRepeater = (options: {
  readonly component: Component
  readonly previousPower: PowerMap
  readonly previousTimer: RepeaterTimer | undefined
  readonly requested: boolean
}): RepeaterTimer => {
  const { component, previousPower, previousTimer, requested } = options
  if (repeaterIsLocked(component, previousPower)) {
    return holdRepeater(previousTimer)
  }

  return advanceRepeater(previousTimer, requested, repeaterDelay(component))
}

const holdBurnedOutTorch = (previous: TorchTimer | undefined, recentOffTicks: ReadonlyArray<number>): TorchTimer | null => {
  if (previous?.burnedOut !== true) {
    return null
  }
  const cooldownTicks = previous.cooldownTicks ?? NO_TICKS
  if (cooldownTicks > NEXT_TICK) {
    return { burnedOut: true, cooldownTicks: nonNegativeTickCount(cooldownTicks - NEXT_TICK), output: false, recentOffTicks }
  }
  return null
}

const advanceTorch = (
  options: {
    readonly previous: TorchTimer | undefined
    readonly previousOutput: boolean
    readonly requestedOutput: boolean
  },
): TorchTimer => {
  const { previous, previousOutput, requestedOutput } = options
  const recentOffTicks = (previous?.recentOffTicks ?? [])
    .map((age) => age + NEXT_TICK)
    .filter((age) => age < TORCH_BURNOUT_WINDOW_TICKS)

  const held = holdBurnedOutTorch(previous, recentOffTicks)
  if (held) {
    return held
  }

  if (previousOutput && !requestedOutput) {
    recentOffTicks.push(NO_TICKS)
    if (recentOffTicks.length > TORCH_BURNOUT_TOGGLE_LIMIT) {
      return { burnedOut: true, cooldownTicks: nonNegativeTickCount(TORCH_BURNOUT_COOLDOWN_TICKS), output: false, recentOffTicks }
    }
  }

  return { burnedOut: false, output: requestedOutput, recentOffTicks }
}

/**
 * `{ outputTo }` when `outputTo` is present, or an empty object otherwise — never
 * `{ outputTo: undefined }`, which `exactOptionalPropertyTypes` treats as a
 * different (and here wrong) thing from the key being absent.
 */
const outputToFields = (outputTo: PositionKey | undefined): Pick<Component, 'outputTo'> | Record<string, never> => {
  if (outputTo) {
    return { outputTo }
  }
  return {}
}

const inputPowerAt = (
  previousPower: PowerMap,
  previousBlockPower: ReadonlyMap<PositionKey, PowerTickBlockLevels>,
  key: PositionKey | null | undefined,
): number => {
  if (key) {
    const block = previousBlockPower.get(key)
    return Math.max(powerAt(previousPower, key), block?.strongLevel ?? NO_POWER_LEVEL, block?.weakLevel ?? NO_POWER_LEVEL)
  }
  return NO_POWER_LEVEL
}

const requestedRepeaterOutput = (
  component: Component,
  previousPower: PowerMap,
  previousBlockPower: ReadonlyMap<PositionKey, PowerTickBlockLevels>,
): boolean => inputPowerAt(previousPower, previousBlockPower, component.inputFrom) > NO_POWER_LEVEL

const applyRepeaterEntry = (params: {
  readonly key: PositionKey
  readonly component: Component
  readonly previous: TimedCircuitState
  readonly previousBlockPower: ReadonlyMap<PositionKey, PowerTickBlockLevels>
  readonly repeaters: Map<PositionKey, RepeaterTimer>
  readonly components: Map<PositionKey, Component>
}): void => {
  const { component, components, key, previous, previousBlockPower, repeaters } = params
  const requested = requestedRepeaterOutput(component, previous.power, previousBlockPower)
  const prior = previous.repeaters.get(key)
  const timer = advanceOrHoldRepeater({
    component,
    previousPower: previous.power,
    previousTimer: prior,
    requested,
  })
  repeaters.set(key, timer)
  /**
   * `kind: 'repeater'`, not the component's other placement fields — this
   * override REPLACES the board entry rather than extending it, and that is
   * deliberate. `inputFrom`/`sideInputs` are omitted on purpose: the timer
   * above already resolved this tick's output from them, and the shared
   * `power-graph.ts` recognises an `active`-bearing repeater as pre-resolved
   * (`sourceLevelFor`) rather than re-deriving it from a rear input this
   * entry does not carry. Carrying `inputFrom` through instead would make
   * `sourcesOf` re-read the RAW, undelayed input on every tick and silently
   * defeat the whole point of `advanceOrHoldRepeater`.
   */
  components.set(key, {
    active: timer.output,
    emits: MAX_POWER_LEVEL,
    kind: 'repeater',
    ...outputToFields(component.outputTo),
  })
}

/** The button's replacement `active` flag alongside its next timer. */
const advanceButton = (
  component: Component,
  prior: ButtonTimer | undefined,
  triggered: boolean,
): { readonly active: boolean; readonly timer: ButtonTimer } => {
  let available = prior?.remainingTicks ?? NO_TICKS
  if (triggered) {
    available = buttonDuration(component)
  }
  const active = available > NO_TICKS
  const timer: ButtonTimer = {
    inputActive: component.active === true,
    remainingTicks: Math.max(NO_TICKS, available - NEXT_TICK),
  }
  return { active, timer }
}

const applyButtonEntry = (params: {
  readonly key: PositionKey
  readonly component: Component
  readonly previous: TimedCircuitState
  readonly pressedButtons: ReadonlySet<PositionKey>
  readonly buttons: Map<PositionKey, ButtonTimer>
  readonly components: Map<PositionKey, Component>
}): void => {
  const { buttons, component, components, key, pressedButtons, previous } = params
  const prior = previous.buttons.get(key)
  const risingEdge = component.active === true && prior?.inputActive !== true
  const triggered = risingEdge || pressedButtons.has(key)
  const { active, timer } = advanceButton(component, prior, triggered)
  buttons.set(key, timer)
  components.set(key, { ...component, active })
}

/**
 * Vanilla's target schedules one reset per powering and ignores a hit while that reset is still
 * pending, so a hit neither re-reads the signal strength nor restarts the hold. A hit on the tick
 * the hold ends powers the target afresh.
 */
const advanceTarget = (prior: TargetTimer | null, hit: TargetHit | null): TargetTimer | null => {
  if (prior !== null && prior.remainingTicks > NO_TICKS) {
    return { level: prior.level, remainingTicks: nonNegativeTickCount(prior.remainingTicks - NEXT_TICK) }
  }
  if (hit === null) {
    return null
  }
  return { level: targetSignal(hit), remainingTicks: nonNegativeTickCount(targetHoldTicks(hit) - NEXT_TICK) }
}

/** A target with no hold in progress keeps whatever the owner of the world declared for it. */
const applyTargetEntry = (params: {
  readonly key: PositionKey
  readonly component: Component
  readonly previous: TimedCircuitState
  readonly targetHits: ReadonlyMap<PositionKey, TargetHit>
  readonly targets: Map<PositionKey, TargetTimer>
  readonly components: Map<PositionKey, Component>
}): void => {
  const { component, components, key, previous, targetHits, targets } = params
  const timer = advanceTarget(previous.targets?.get(key) ?? null, targetHits.get(key) ?? null)
  if (timer === null) {
    return
  }
  targets.set(key, timer)
  components.set(key, { ...component, active: true, emits: timer.level })
}

/**
 * A powered plate does not look at its occupants until its re-check is due, so an arrival
 * between checks changes nothing and a departure releases the plate only at the next check
 * (`pressure-plate.ts`). An idle plate reacts to an occupant at once.
 */
const advancePlate = (
  prior: PlateTimer | null,
  component: Component & { readonly plate: PressurePlateKind },
): PlateTimer | null => {
  if (prior !== null && prior.remainingTicks > NO_TICKS) {
    return { remainingTicks: nonNegativeTickCount(prior.remainingTicks - NEXT_TICK), strength: prior.strength }
  }
  const strength = plateOccupantSignal(component.plate, component.occupants ?? NO_OCCUPANTS)
  if (strength === NO_POWER_LEVEL) {
    return null
  }
  return { remainingTicks: nonNegativeTickCount(plateCheckTicks(component.plate) - NEXT_TICK), strength }
}

/** A plate with no kind keeps whatever the owner of the world declared for it. */
const applyPlateEntry = (params: {
  readonly key: PositionKey
  readonly component: Component
  readonly previous: TimedCircuitState
  readonly plates: Map<PositionKey, PlateTimer>
  readonly components: Map<PositionKey, Component>
}): void => {
  const { component, components, key, plates, previous } = params
  if (!component.plate) {
    return
  }
  const timer = advancePlate(previous.plates?.get(key) ?? null, { ...component, plate: component.plate })
  if (timer === null) {
    components.set(key, { ...component, active: false })
    return
  }
  plates.set(key, timer)
  components.set(key, { ...component, active: true, emits: timer.strength })
}

const applyTorchEntry = (params: {
  readonly key: PositionKey
  readonly component: Component
  readonly previous: TimedCircuitState
  readonly previousBlockPower: ReadonlyMap<PositionKey, PowerTickBlockLevels>
  readonly torches: Map<PositionKey, TorchTimer>
  readonly components: Map<PositionKey, Component>
}): void => {
  const { component, components, key, previous, previousBlockPower, torches } = params
  const invertedBy = component.invertedBy ?? null
  const requested = invertedBy === null || inputPowerAt(previous.power, previousBlockPower, invertedBy) === NO_POWER_LEVEL
  const prior = previous.torches?.get(key)
  const previousOutput = prior?.output ?? powerAt(previous.power, key) > NO_TICKS
  const timer = advanceTorch({ previous: prior, previousOutput, requestedOutput: requested })
  torches.set(key, timer)
  components.set(key, { ...component, active: timer.output })
}

const advanceObserver = (previous: ObserverTimer | undefined, changed: boolean): ObserverTimer => {
  if (changed) {
    return { output: true, remainingTicks: OBSERVER_PULSE_TICKS }
  }
  const remainingTicks = Math.max(NO_TICKS, (previous?.remainingTicks ?? NO_TICKS) - NEXT_TICK)
  return { output: remainingTicks > NO_TICKS, remainingTicks }
}

const applyObserverEntry = (params: {
  readonly key: PositionKey
  readonly component: Component
  readonly previous: TimedCircuitState
  readonly changedObservers: ReadonlySet<PositionKey>
  readonly observers: Map<PositionKey, ObserverTimer>
  readonly components: Map<PositionKey, Component>
}): void => {
  const { changedObservers, component, components, key, observers, previous } = params
  const timer = advanceObserver(previous.observers?.get(key), changedObservers.has(key))
  observers.set(key, timer)
  components.set(key, { ...component, active: timer.output })
}

type ApplyTimedEntryParameters = {
  readonly key: PositionKey
  readonly component: Component
  readonly previous: TimedCircuitState
  readonly previousBlockPower: ReadonlyMap<PositionKey, PowerTickBlockLevels>
  readonly pressedButtons: ReadonlySet<PositionKey>
  readonly targetHits: ReadonlyMap<PositionKey, TargetHit>
  readonly repeaters: Map<PositionKey, RepeaterTimer>
  readonly buttons: Map<PositionKey, ButtonTimer>
  readonly plates: Map<PositionKey, PlateTimer>
  readonly targets: Map<PositionKey, TargetTimer>
  readonly torches: Map<PositionKey, TorchTimer>
  readonly observers: Map<PositionKey, ObserverTimer>
  readonly changedObservers: ReadonlySet<PositionKey>
  readonly components: Map<PositionKey, Component>
}

const NON_TORCH_APPLIERS: ReadonlyMap<Component['kind'], (params: ApplyTimedEntryParameters) => void> = new Map<
  Component['kind'],
  (params: ApplyTimedEntryParameters) => void
>([
  ['button', applyButtonEntry],
  ['observer', applyObserverEntry],
  ['pressure-plate', applyPlateEntry],
  ['repeater', applyRepeaterEntry],
  ['target', applyTargetEntry],
])

const applyNonTorchTimedEntry = (params: ApplyTimedEntryParameters): boolean => {
  const apply = NON_TORCH_APPLIERS.get(params.component.kind)
  if (apply) {
    apply(params)
    return true
  }
  return false
}

const applyTimedEntry = (params: ApplyTimedEntryParameters): void => {
  if (applyNonTorchTimedEntry(params)) {
    return
  }
  const { component, components, key, previous, previousBlockPower, torches } = params
  /**
   * `advanceTimedCircuit` only ever calls this for `TIMED_COMPONENT_KINDS`
   * members (`componentEntriesForKinds` filters upstream), so having ruled out
   * 'repeater', 'button', 'observer' and 'target', `component.kind` is provably 'torch' here. A
   * trailing `else if ('torch')` would leave a branch no test can reach
   * (DN-RS-11), so this is an unconditional call instead of a third guard.
   */
  applyTorchEntry({ component, components, key, previous, previousBlockPower, torches })
}

type ResolvedTimedCircuitTick = {
  readonly buttons: ReadonlyMap<PositionKey, ButtonTimer>
  readonly components: ReadonlyMap<PositionKey, Component>
  readonly observerSeen: Sightings
  readonly observers: ReadonlyMap<PositionKey, ObserverTimer>
  readonly plates: ReadonlyMap<PositionKey, PlateTimer>
  readonly repeaters: ReadonlyMap<PositionKey, RepeaterTimer>
  readonly targets: ReadonlyMap<PositionKey, TargetTimer>
  readonly tickContext: PowerTickContext
  readonly torches: ReadonlyMap<PositionKey, TorchTimer>
}

const timedCircuitWithProvenance = (
  tickState: PowerTickWithProvenance,
  resolved: ResolvedTimedCircuitTick,
): TimedCircuitWithProvenance => ({
  blockPower: tickState.blockPower,
  buttons: resolved.buttons,
  observerSeen: resolved.observerSeen,
  observers: resolved.observers,
  plates: resolved.plates,
  power: tickState.power,
  provenance: tickState.provenance,
  repeaters: resolved.repeaters,
  targets: resolved.targets,
  torches: resolved.torches,
})

type TimedComponentMaps = {
  readonly buttons: Map<PositionKey, ButtonTimer>
  readonly components: Map<PositionKey, Component>
  readonly observers: Map<PositionKey, ObserverTimer>
  readonly plates: Map<PositionKey, PlateTimer>
  readonly repeaters: Map<PositionKey, RepeaterTimer>
  readonly targets: Map<PositionKey, TargetTimer>
  readonly torches: Map<PositionKey, TorchTimer>
}

const emptyTimedComponentMaps = (): TimedComponentMaps => ({
  buttons: new Map(),
  components: new Map(),
  observers: new Map(),
  plates: new Map(),
  repeaters: new Map(),
  targets: new Map(),
  torches: new Map(),
})

const previousBlockPowerFor = (input: TimedCircuitAdvanceInput): ReadonlyMap<PositionKey, PowerTickBlockLevels> =>
  input.previous.blockPower ?? input.context?.previousBlockPower ?? EMPTY_PREVIOUS_BLOCK_POWER

const observerSweepFor = (board: CircuitBoard, previous: TimedCircuitState): ReturnType<typeof observeChanges> => {
  const current = new Map<PositionKey, NonNullable<Component['observedBlock']>>()
  for (const [key, component] of componentEntriesForKinds(board, OBSERVER_COMPONENT_KINDS)) {
    if (typeof component.observedBlock !== 'undefined') {
      current.set(key, component.observedBlock)
    }
  }
  return observeChanges(current, previous.observerSeen ?? new Map())
}

type TimedInputs = {
  readonly pressedButtons: ReadonlySet<PositionKey>
  readonly targetHits: ReadonlyMap<PositionKey, TargetHit>
}

const timedInputsOf = (input: Pick<TimedCircuitAdvanceInput, 'pressedButtons' | 'targetHits'>): TimedInputs => ({
  pressedButtons: input.pressedButtons ?? new Set<PositionKey>(),
  targetHits: input.targetHits ?? new Map<PositionKey, TargetHit>(),
})

const advanceTimedEntries = (input: {
  readonly board: CircuitBoard
  readonly inputs: TimedInputs
  readonly previous: TimedCircuitState
  readonly previousBlockPower: ReadonlyMap<PositionKey, PowerTickBlockLevels>
}): { readonly maps: TimedComponentMaps; readonly sweep: ReturnType<typeof observeChanges> } => {
  const { board, inputs, previous, previousBlockPower } = input
  const maps = emptyTimedComponentMaps()
  const sweep = observerSweepFor(board, previous)
  const changedObservers = new Set(sweep.fired)

  for (const [key, component] of componentEntriesForKinds(board, TIMED_COMPONENT_KINDS)) {
    applyTimedEntry({ ...maps, ...inputs, changedObservers, component, key, previous, previousBlockPower })
  }
  return { maps, sweep }
}

const resolveTimedCircuitTick = (input: TimedCircuitAdvanceInput): ResolvedTimedCircuitTick => {
  const { board, previous, context } = input
  const previousBlockPower = previousBlockPowerFor(input)
  const { maps, sweep } = advanceTimedEntries({ board, inputs: timedInputsOf(input), previous, previousBlockPower })
  const tickContext: PowerTickContext = { ...context, previousBlockPower }
  return { ...maps, observerSeen: sweep.seen, tickContext }
}

/** Advances all timers once, then computes this tick's state without provenance. */
export const advanceTimedCircuitWithContext = (
  input: TimedCircuitAdvanceInput,
): TimedCircuitWithBlockPower => {
  const { board, previous } = input
  const resolved = resolveTimedCircuitTick(input)
  const tickState = propagateTickState(board, previous.power, {
    context: resolved.tickContext,
    overrides: resolved.components,
  })
  return {
    blockPower: tickState.blockPower,
    buttons: resolved.buttons,
    observerSeen: resolved.observerSeen,
    observers: resolved.observers,
    plates: resolved.plates,
    power: tickState.power,
    repeaters: resolved.repeaters,
    targets: resolved.targets,
    torches: resolved.torches,
  }
}

/** Advances timers once and collects provenance in the same propagation traversal. */
export const advanceTimedCircuitWithProvenanceContext = (
  input: TimedCircuitAdvanceInput,
): TimedCircuitWithProvenance => {
  const { board, previous } = input
  const resolved = resolveTimedCircuitTick(input)
  const tickState = propagateTickWithProvenance(board, previous.power, {
    context: resolved.tickContext,
    overrides: resolved.components,
  })
  return timedCircuitWithProvenance(tickState, resolved)
}

/** The external events one redstone tick consumes. Both are optional and default to none. */
export type TimedCircuitInputs = {
  readonly pressedButtons?: ReadonlySet<PositionKey>
  readonly targetHits?: ReadonlyMap<PositionKey, TargetHit>
}

export const advanceTimedCircuitWithInputs = (
  board: CircuitBoard,
  previous: TimedCircuitState,
  inputs: TimedCircuitInputs = {},
): TimedCircuitState => {
  const previousBlockPower = previousBlockPowerFor({ board, previous })
  const { maps, sweep } = advanceTimedEntries({ board, inputs: timedInputsOf(inputs), previous, previousBlockPower })

  // The map-only API avoids constructing block-power contexts and result wrappers on every tick.
  return {
    buttons: maps.buttons,
    observerSeen: sweep.seen,
    observers: maps.observers,
    plates: maps.plates,
    power: propagateTick(board, previous.power, maps.components),
    repeaters: maps.repeaters,
    targets: maps.targets,
    torches: maps.torches,
  }
}

export const advanceTimedCircuit = (
  board: CircuitBoard,
  previous: TimedCircuitState,
  pressedButtons: ReadonlySet<PositionKey> = new Set(),
): TimedCircuitState => advanceTimedCircuitWithInputs(board, previous, { pressedButtons })
