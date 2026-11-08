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
import { OBSERVER_PULSE_TICKS, type Sightings, observeChanges } from './observer.js'
import type { PositionKey } from './position-key.js'

const TIMED_COMPONENT_KINDS: ReadonlySet<Component['kind']> = new Set([
  'repeater',
  'button',
  'observer',
  'torch',
])
const OBSERVER_COMPONENT_KINDS: ReadonlySet<Component['kind']> = new Set(['observer'])

export const DEFAULT_BUTTON_PULSE_TICKS = 10
export const TORCH_BURNOUT_TOGGLE_LIMIT = 8
export const TORCH_BURNOUT_WINDOW_TICKS = 30
/** Java's optional 160-game-tick relight attempt; this sampler does not schedule it. */
export const TORCH_BURNOUT_COOLDOWN_TICKS = 80

const NO_TICKS = 0
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
  readonly output: boolean
  readonly recentOffTicks: ReadonlyArray<number>
}

export type ObserverTimer = {
  readonly output: boolean
  readonly remainingTicks: number
}

export type TimedCircuitState = {
  readonly power: PowerMap
  readonly repeaters: ReadonlyMap<PositionKey, RepeaterTimer>
  readonly buttons: ReadonlyMap<PositionKey, ButtonTimer>
  /** Optional so states constructed before torch burnout support remain valid. */
  readonly torches?: ReadonlyMap<PositionKey, TorchTimer>
  readonly observers?: ReadonlyMap<PositionKey, ObserverTimer>
  readonly observerSeen?: Sightings
}

type TimedCircuitInput = TimedCircuitState & {
  readonly blockPower?: ReadonlyMap<PositionKey, PowerTickBlockLevels>
}

type TimedCircuitAdvanceInput = {
  readonly board: CircuitBoard
  readonly previous: TimedCircuitInput
  readonly pressedButtons?: ReadonlySet<PositionKey>
  readonly context?: PowerTickContext
}

export type TimedCircuitWithBlockPower = Omit<TimedCircuitState, 'observers' | 'observerSeen' | 'torches'> & {
  readonly blockPower: ReadonlyMap<PositionKey, PowerTickBlockLevels>
  readonly observerSeen: Sightings
  readonly observers: ReadonlyMap<PositionKey, ObserverTimer>
  readonly torches: ReadonlyMap<PositionKey, TorchTimer>
}

export type TimedCircuitWithProvenance = TimedCircuitWithBlockPower & {
  readonly provenance: ReadonlyMap<PositionKey, ReadonlyArray<PowerProvenanceCandidate>>
}

export const emptyTimedCircuitState: TimedCircuitState = {
  buttons: new Map(),
  observerSeen: new Map(),
  observers: new Map(),
  power: emptyPowerMap,
  repeaters: new Map(),
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
  if (requestedOutput === output) {
    return { output, remainingTicks: NO_TICKS }
  }

  const remaining = nextRemainingTicks(previous, requestedOutput, delayTicks)
  if (remaining <= NO_TICKS) {
    return { output: requestedOutput, remainingTicks: NO_TICKS }
  }
  return { output, pendingOutput: requestedOutput, remainingTicks: remaining }
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

  if (previous?.burnedOut === true && recentOffTicks.length >= TORCH_BURNOUT_TOGGLE_LIMIT) {
    return { burnedOut: true, output: false, recentOffTicks }
  }

  // Support is sampled every redstone tick, so the next sample is the relight
  // Attempt once fewer than eight forced-off transitions remain.
  if (previousOutput && !requestedOutput) {
    recentOffTicks.push(NO_TICKS)
  }

  const burnedOut = recentOffTicks.length > TORCH_BURNOUT_TOGGLE_LIMIT
  if (burnedOut) {
    return { burnedOut, output: false, recentOffTicks }
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
  readonly repeaters: Map<PositionKey, RepeaterTimer>
  readonly buttons: Map<PositionKey, ButtonTimer>
  readonly torches: Map<PositionKey, TorchTimer>
  readonly observers: Map<PositionKey, ObserverTimer>
  readonly changedObservers: ReadonlySet<PositionKey>
  readonly components: Map<PositionKey, Component>
}

const applyNonTorchTimedEntry = (params: ApplyTimedEntryParameters): boolean => {
  if (params.component.kind === 'repeater') {
    applyRepeaterEntry(params)
    return true
  }
  if (params.component.kind === 'button') {
    applyButtonEntry(params)
    return true
  }
  if (params.component.kind === 'observer') {
    applyObserverEntry(params)
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
   * 'repeater' and 'button', `component.kind` is provably 'torch' here. A
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
  readonly repeaters: ReadonlyMap<PositionKey, RepeaterTimer>
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
  power: tickState.power,
  provenance: tickState.provenance,
  repeaters: resolved.repeaters,
  torches: resolved.torches,
})

type TimedComponentMaps = {
  readonly buttons: Map<PositionKey, ButtonTimer>
  readonly components: Map<PositionKey, Component>
  readonly observers: Map<PositionKey, ObserverTimer>
  readonly repeaters: Map<PositionKey, RepeaterTimer>
  readonly torches: Map<PositionKey, TorchTimer>
}

const emptyTimedComponentMaps = (): TimedComponentMaps => ({
  buttons: new Map(),
  components: new Map(),
  observers: new Map(),
  repeaters: new Map(),
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

const resolveTimedCircuitTick = (input: TimedCircuitAdvanceInput): ResolvedTimedCircuitTick => {
  const { board, previous, context } = input
  const pressedButtons = input.pressedButtons ?? new Set<PositionKey>()
  const { buttons, components, observers, repeaters, torches } = emptyTimedComponentMaps()
  const previousBlockPower = previousBlockPowerFor(input)
  const sweep = observerSweepFor(board, previous)
  const changedObservers = new Set(sweep.fired)

  for (const [key, component] of componentEntriesForKinds(board, TIMED_COMPONENT_KINDS)) {
    applyTimedEntry({
      buttons,
      changedObservers,
      component,
      components,
      key,
      observers,
      pressedButtons,
      previous,
      previousBlockPower,
      repeaters,
      torches,
    })
  }

  const tickContext: PowerTickContext = { ...context, previousBlockPower }
  return { buttons, components, observerSeen: sweep.seen, observers, repeaters, tickContext, torches }
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
    power: tickState.power,
    repeaters: resolved.repeaters,
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

export const advanceTimedCircuit = (
  board: CircuitBoard,
  previous: TimedCircuitState,
  pressedButtons: ReadonlySet<PositionKey> = new Set(),
): TimedCircuitState => {
  const { buttons, components, observers, repeaters, torches } = emptyTimedComponentMaps()
  const previousBlockPower = previousBlockPowerFor({ board, pressedButtons, previous })
  const sweep = observerSweepFor(board, previous)
  const changedObservers = new Set(sweep.fired)

  for (const [key, component] of componentEntriesForKinds(board, TIMED_COMPONENT_KINDS)) {
    applyTimedEntry({
      buttons,
      changedObservers,
      component,
      components,
      key,
      observers,
      pressedButtons,
      previous,
      previousBlockPower,
      repeaters,
      torches,
    })
  }

  // The map-only API avoids constructing block-power contexts and result wrappers on every tick.
  return {
    buttons,
    observerSeen: sweep.seen,
    observers,
    power: propagateTick(board, previous.power, components),
    repeaters,
    torches,
  }
}
