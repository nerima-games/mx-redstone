import {
  type CircuitBoard,
  type Component,
  MAX_POWER_LEVEL,
  type PowerMap,
  componentEntriesForKinds,
  emptyPowerMap,
  powerAt,
  propagateTick,
} from './power-graph'
import type { PositionKey } from './position-key'

const TIMED_COMPONENT_KINDS: ReadonlySet<Component['kind']> = new Set([
  'repeater',
  'button',
  'torch',
])

export const DEFAULT_BUTTON_PULSE_TICKS = 10
export const TORCH_BURNOUT_TOGGLE_LIMIT = 8
export const TORCH_BURNOUT_WINDOW_TICKS = 30
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
  readonly burnoutRemainingTicks: number
  readonly output: boolean
  readonly recentOffTicks: ReadonlyArray<number>
}

export type TimedCircuitState = {
  readonly power: PowerMap
  readonly repeaters: ReadonlyMap<PositionKey, RepeaterTimer>
  readonly buttons: ReadonlyMap<PositionKey, ButtonTimer>
  /** Optional so states constructed before torch burnout support remain valid. */
  readonly torches?: ReadonlyMap<PositionKey, TorchTimer>
}

export const emptyTimedCircuitState: TimedCircuitState = {
  buttons: new Map(),
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

const repeaterIsLocked = (component: Component, previous: PowerMap): boolean =>
  (component.sideInputs ?? []).some((side) => powerAt(previous, side) > NO_POWER_LEVEL)

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
  /**
   * Computed once and reused below: the guard and the return value must agree
   * on the same reading of `previous`, and re-deriving it a second time would
   * create a branch (the `?? NO_TICKS` fallback at this second site) that can
   * never fire — the guard already proves the fallback wasn't needed to reach
   * here, since NO_TICKS (0) can never satisfy `> NEXT_TICK`.
   */
  const burnoutRemainingTicks = previous?.burnoutRemainingTicks ?? NO_TICKS
  if (burnoutRemainingTicks > NEXT_TICK) {
    return {
      burnoutRemainingTicks: burnoutRemainingTicks - NEXT_TICK,
      output: false,
      recentOffTicks: [],
    }
  }

  const recentOffTicks = (previous?.recentOffTicks ?? [])
    .map((age) => age + NEXT_TICK)
    .filter((age) => age < TORCH_BURNOUT_WINDOW_TICKS)
  if (previousOutput && !requestedOutput) {
    recentOffTicks.push(NO_TICKS)
  }

  if (recentOffTicks.length >= TORCH_BURNOUT_TOGGLE_LIMIT) {
    return {
      burnoutRemainingTicks: TORCH_BURNOUT_COOLDOWN_TICKS,
      output: false,
      recentOffTicks: [],
    }
  }

  return { burnoutRemainingTicks: 0, output: requestedOutput, recentOffTicks }
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

const requestedRepeaterOutput = (component: Component, previousPower: PowerMap): boolean => {
  if (component.inputFrom) {
    return powerAt(previousPower, component.inputFrom) > NO_POWER_LEVEL
  }
  return false
}

const applyRepeaterEntry = (params: {
  readonly key: PositionKey
  readonly component: Component
  readonly previous: TimedCircuitState
  readonly repeaters: Map<PositionKey, RepeaterTimer>
  readonly components: Map<PositionKey, Component>
}): void => {
  const { component, components, key, previous, repeaters } = params
  const requested = requestedRepeaterOutput(component, previous.power)
  const prior = previous.repeaters.get(key)
  const timer = advanceOrHoldRepeater({
    component,
    previousPower: previous.power,
    previousTimer: prior,
    requested,
  })
  repeaters.set(key, timer)
  components.set(key, {
    active: timer.output,
    emits: MAX_POWER_LEVEL,
    kind: 'observer',
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
  readonly torches: Map<PositionKey, TorchTimer>
  readonly components: Map<PositionKey, Component>
}): void => {
  const { component, components, key, previous, torches } = params
  const invertedBy = component.invertedBy ?? null
  const requested = invertedBy === null || powerAt(previous.power, invertedBy) === NO_TICKS
  const prior = previous.torches?.get(key)
  const previousOutput = prior?.output ?? powerAt(previous.power, key) > NO_TICKS
  const timer = advanceTorch({ previous: prior, previousOutput, requestedOutput: requested })
  torches.set(key, timer)
  components.set(key, { ...component, active: timer.output })
}

const applyTimedEntry = (params: {
  readonly key: PositionKey
  readonly component: Component
  readonly previous: TimedCircuitState
  readonly pressedButtons: ReadonlySet<PositionKey>
  readonly repeaters: Map<PositionKey, RepeaterTimer>
  readonly buttons: Map<PositionKey, ButtonTimer>
  readonly torches: Map<PositionKey, TorchTimer>
  readonly components: Map<PositionKey, Component>
}): void => {
  const { buttons, component, components, key, pressedButtons, previous, repeaters, torches } = params
  if (component.kind === 'repeater') {
    applyRepeaterEntry({ component, components, key, previous, repeaters })
  } else if (component.kind === 'button') {
    applyButtonEntry({ buttons, component, components, key, pressedButtons, previous })
  } else if (component.kind === 'torch') {
    applyTorchEntry({ component, components, key, previous, torches })
  }
}

/** Advances all timers exactly once, then computes this tick's 0–15 power map. */
export const advanceTimedCircuit = (
  board: CircuitBoard,
  previous: TimedCircuitState,
  pressedButtons: ReadonlySet<PositionKey> = new Set(),
): TimedCircuitState => {
  const repeaters = new Map<PositionKey, RepeaterTimer>()
  const buttons = new Map<PositionKey, ButtonTimer>()
  const torches = new Map<PositionKey, TorchTimer>()
  const components = new Map<PositionKey, Component>()

  for (const [key, component] of componentEntriesForKinds(board, TIMED_COMPONENT_KINDS)) {
    applyTimedEntry({ buttons, component, components, key, pressedButtons, previous, repeaters, torches })
  }

  return {
    buttons,
    power: propagateTick(board, previous.power, components),
    repeaters,
    torches,
  }
}
