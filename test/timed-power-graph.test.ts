import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import type { CircuitBoard, Component } from '../src/domain/power-graph'
import { powerAt } from '../src/domain/power-graph'
import {
  advanceTimedCircuit,
  emptyTimedCircuitState,
  type TimedCircuitState,
} from '../src/domain/timed-power-graph'

const line = (cells: ReadonlyArray<readonly [string, Component]>): CircuitBoard => ({
  components: new Map(cells),
  adjacency: new Map(
    cells.map(([key], index) => [
      key,
      [cells[index - 1]?.[0], cells[index + 1]?.[0]].filter(
        (candidate): candidate is string => candidate !== undefined,
      ),
    ]),
  ),
})

const ticks = (board: CircuitBoard, count: number, initial = emptyTimedCircuitState) => {
  let state: TimedCircuitState = initial
  for (let tick = 0; tick < count; tick += 1) state = advanceTimedCircuit(board, state)
  return state
}

describe('timed redstone', () => {
  it.effect('applies timing defaults and clamps invalid component timing', () =>
    Effect.sync(() => {
      for (const [configuredDelay, expectedDelay] of [
        [undefined, 1],
        [0, 1],
        [9, 4],
      ] as const) {
        const board = line([
          ['lever', { kind: 'lever', active: true }],
          ['rear', { kind: 'wire' }],
          [
            'repeater',
            configuredDelay === undefined
              ? { kind: 'repeater', inputFrom: 'rear' }
              : { kind: 'repeater', inputFrom: 'rear', delayTicks: configuredDelay },
          ],
        ])
        expect(powerAt(ticks(board, expectedDelay + 1).power, 'repeater')).toBe(15)
      }

      const defaultButton = line([
        ['button', { kind: 'button', active: true }],
        ['wire', { kind: 'wire' }],
      ])
      let state = advanceTimedCircuit(defaultButton, emptyTimedCircuitState)
      expect(state.buttons.get('button')?.remainingTicks).toBe(9)
      state = advanceTimedCircuit(defaultButton, state)
      expect(state.buttons.get('button')?.remainingTicks).toBe(8)

      const minimumButton = line([
        ['button', { kind: 'button', pulseTicks: 0 }],
        ['wire', { kind: 'wire' }],
      ])
      state = advanceTimedCircuit(minimumButton, emptyTimedCircuitState, new Set(['button']))
      expect(powerAt(state.power, 'wire')).toBe(15)
      state = advanceTimedCircuit(minimumButton, state)
      expect(powerAt(state.power, 'wire')).toBe(0)
    }),
  )

  it.effect('honours repeater delay boundaries and restores full power', () =>
    Effect.sync(() => {
      for (const delayTicks of [1, 2, 3, 4]) {
        const board = line([
          ['lever', { kind: 'lever', active: true }],
          ['rear', { kind: 'wire' }],
          ['repeater', { kind: 'repeater', inputFrom: 'rear', outputTo: 'out', delayTicks }],
          ['out', { kind: 'wire' }],
        ])
        const before = ticks(board, delayTicks)
        expect(powerAt(before.power, 'repeater')).toBe(0)
        const after = advanceTimedCircuit(board, before)
        expect(powerAt(after.power, 'repeater')).toBe(15)
        expect(powerAt(after.power, 'out')).toBe(15)
      }
    }),
  )

  it.effect('cancels a pending repeater transition when its input stops', () =>
    Effect.sync(() => {
      const on = line([
        ['lever', { kind: 'lever', active: true }],
        ['rear', { kind: 'wire' }],
        ['repeater', { kind: 'repeater', inputFrom: 'rear', outputTo: 'out', delayTicks: 4 }],
        ['out', { kind: 'wire' }],
      ])
      let state = ticks(on, 3)
      const off: CircuitBoard = {
        ...on,
        components: new Map(on.components).set('lever', { kind: 'lever', active: false }),
      }
      state = ticks(off, 5, state)
      expect(powerAt(state.power, 'repeater')).toBe(0)
    }),
  )

  it.effect('emits an exact button pulse, stops, and explicit retrigger restarts it', () =>
    Effect.sync(() => {
      const board = line([
        ['button', { kind: 'button', pulseTicks: 3 }],
        ['wire', { kind: 'wire' }],
      ])
      let state = advanceTimedCircuit(board, emptyTimedCircuitState, new Set(['button']))
      expect(powerAt(state.power, 'wire')).toBe(15)
      state = advanceTimedCircuit(board, state)
      expect(powerAt(state.power, 'wire')).toBe(15)
      state = advanceTimedCircuit(board, state, new Set(['button']))
      expect(powerAt(state.power, 'wire')).toBe(15)
      state = ticks(board, 2, state)
      expect(powerAt(state.power, 'wire')).toBe(15)
      state = advanceTimedCircuit(board, state)
      expect(powerAt(state.power, 'wire')).toBe(0)
    }),
  )

  it.effect('is independent of component insertion order', () =>
    Effect.sync(() => {
      const cells: ReadonlyArray<readonly [string, Component]> = [
        ['lever', { kind: 'lever', active: true }],
        ['rear', { kind: 'wire' }],
        ['repeater', { kind: 'repeater', inputFrom: 'rear', outputTo: 'out', delayTicks: 2 }],
        ['out', { kind: 'wire' }],
      ]
      const forward = ticks(line(cells), 4)
      const reverse = ticks(line([...cells].reverse()), 4)
      expect([...forward.power].sort()).toStrictEqual([...reverse.power].sort())
      expect(forward.repeaters.get('repeater')).toStrictEqual(reverse.repeaters.get('repeater'))
    }),
  )
})
