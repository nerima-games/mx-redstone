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

export type RepeaterTimer = {
  readonly output: boolean
  readonly pendingOutput?: boolean
  readonly remainingTicks: number
}

export type ButtonTimer = {
  readonly remainingTicks: number
  readonly inputActive: boolean
}

export type TimedCircuitState = {
  readonly power: PowerMap
  readonly repeaters: ReadonlyMap<PositionKey, RepeaterTimer>
  readonly buttons: ReadonlyMap<PositionKey, ButtonTimer>
}

export const emptyTimedCircuitState: TimedCircuitState = {
  power: emptyPowerMap,
  repeaters: new Map(),
  buttons: new Map(),
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

/** Advances all timers exactly once, then computes this tick's 0–15 power map. */
export const advanceTimedCircuit = (
  board: CircuitBoard,
  previous: TimedCircuitState,
  pressedButtons: ReadonlySet<PositionKey> = new Set(),
): TimedCircuitState => {
  const repeaters = new Map<PositionKey, RepeaterTimer>()
  const buttons = new Map<PositionKey, ButtonTimer>()
  const components = new Map<PositionKey, Component>(board.components)

  for (const [key, component] of board.components) {
    if (component.kind === 'repeater') {
      const requested =
        component.inputFrom !== undefined && powerAt(previous.power, component.inputFrom) > 0
      const timer = advanceRepeater(previous.repeaters.get(key), requested, repeaterDelay(component))
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
    }
  }

  return {
    power: propagateTick({ ...board, components }, previous.power),
    repeaters,
    buttons,
  }
}
