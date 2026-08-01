import type { PositionKey } from './position-key'
import {
  emptyPowerMap,
  MAX_POWER_LEVEL,
  powerAt,
  propagateTick,
  type CircuitBoard,
  type Component,
  type PowerMap,
} from './power-graph'

export const DEFAULT_BUTTON_PULSE_TICKS = 10
export const TORCH_BURNOUT_TOGGLE_LIMIT = 8
export const TORCH_BURNOUT_WINDOW_TICKS = 30
export const TORCH_BURNOUT_COOLDOWN_TICKS = 80

const NO_TICKS = 0
const NEXT_TICK = 1

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
  Math.max(1, Math.min(4, Math.trunc(component.delayTicks ?? 1)))

const buttonDuration = (component: Component): number =>
  Math.max(1, Math.trunc(component.pulseTicks ?? DEFAULT_BUTTON_PULSE_TICKS))

const advanceRepeater = (
  previous: RepeaterTimer | undefined,
  requestedOutput: boolean,
  delayTicks: number,
): RepeaterTimer => {
  const output = previous?.output ?? false
  if (requestedOutput === output) {
    return { output, remainingTicks: 0 }
  }

  const remaining =
    previous?.pendingOutput === requestedOutput ? previous.remainingTicks - 1 : delayTicks - 1
  if (remaining <= 0) {
    return { output: requestedOutput, remainingTicks: 0 }
  }
  return { output, pendingOutput: requestedOutput, remainingTicks: remaining }
}

const repeaterIsLocked = (component: Component, previous: PowerMap): boolean =>
  (component.sideInputs ?? []).some((side) => powerAt(previous, side) > 0)

const holdRepeater = (previous: RepeaterTimer | undefined): RepeaterTimer => ({
  output: previous?.output ?? false,
  remainingTicks: 0,
})

const advanceOrHoldRepeater = (
  component: Component,
  previousPower: PowerMap,
  previousTimer: RepeaterTimer | undefined,
  requested: boolean,
): RepeaterTimer => {
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
  if ((previous?.burnoutRemainingTicks ?? NO_TICKS) > NEXT_TICK) {
    return {
      burnoutRemainingTicks: (previous?.burnoutRemainingTicks ?? NO_TICKS) - NEXT_TICK,
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

/** Advances all timers exactly once, then computes this tick's 0–15 power map. */
export const advanceTimedCircuit = (
  board: CircuitBoard,
  previous: TimedCircuitState,
  pressedButtons: ReadonlySet<PositionKey> = new Set(),
): TimedCircuitState => {
  const repeaters = new Map<PositionKey, RepeaterTimer>()
  const buttons = new Map<PositionKey, ButtonTimer>()
  const torches = new Map<PositionKey, TorchTimer>()
  const components = new Map<PositionKey, Component>(board.components)

  for (const [key, component] of board.components) {
    if (component.kind === 'repeater') {
      const requested =
        component.inputFrom !== undefined && powerAt(previous.power, component.inputFrom) > 0
      const prior = previous.repeaters.get(key)
      const timer = advanceOrHoldRepeater(component, previous.power, prior, requested)
      repeaters.set(key, timer)
      components.set(key, {
        kind: 'observer',
        active: timer.output,
        emits: MAX_POWER_LEVEL,
        ...(component.outputTo === undefined ? {} : { outputTo: component.outputTo }),
      })
      continue
    }

    if (component.kind === 'button') {
      const prior = previous.buttons.get(key)
      const risingEdge = component.active === true && prior?.inputActive !== true
      const triggered = risingEdge || pressedButtons.has(key)
      const available = triggered ? buttonDuration(component) : (prior?.remainingTicks ?? 0)
      const active = available > 0
      buttons.set(key, {
        remainingTicks: Math.max(0, available - 1),
        inputActive: component.active === true,
      })
      components.set(key, { ...component, active })
    } else if (component.kind === 'torch') {
      const invertedBy = component.invertedBy ?? null
      const requested =
        invertedBy === null || powerAt(previous.power, invertedBy) === NO_TICKS
      const prior = previous.torches?.get(key)
      const previousOutput = prior?.output ?? powerAt(previous.power, key) > NO_TICKS
      const timer = advanceTorch({ previous: prior, previousOutput, requestedOutput: requested })
      torches.set(key, timer)
      components.set(key, { ...component, active: timer.output })
    }
  }

  return {
    buttons,
    power: propagateTick({ ...board, components }, previous.power),
    repeaters,
    torches,
  }
}
