import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import type { CircuitBoard, Component } from '../src/domain/power-graph'
import { powerAt } from '../src/domain/power-graph'
import {
  advanceTimedCircuit,
  emptyTimedCircuitState,
  TORCH_BURNOUT_COOLDOWN_TICKS,
  TORCH_BURNOUT_TOGGLE_LIMIT,
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

  it.effect('a powered side locks the current output and discards a pending transition', () =>
    Effect.sync(() => {
      const board = line([
        ['rearLever', { kind: 'lever', active: true }],
        ['rear', { kind: 'wire' }],
        ['repeater', { kind: 'repeater', inputFrom: 'rear', outputTo: 'out', sideInputs: ['lock'], delayTicks: 3 }],
        ['out', { kind: 'wire' }],
        ['lock', { kind: 'lever', active: false }],
      ])
      let state = ticks(board, 2)
      expect(state.repeaters.get('repeater')).toMatchObject({ pendingOutput: true, remainingTicks: 2 })

      const locked: CircuitBoard = {
        ...board,
        components: new Map(board.components).set('lock', { kind: 'lever', active: true }),
      }
      state = advanceTimedCircuit(locked, state)
      state = advanceTimedCircuit(locked, state)
      expect(state.repeaters.get('repeater')).toStrictEqual({ output: false, remainingTicks: 0 })

      const unlocked: CircuitBoard = {
        ...locked,
        components: new Map(locked.components).set('lock', { kind: 'lever', active: false }),
      }
      state = advanceTimedCircuit(unlocked, state)
      expect(state.repeaters.get('repeater')).toStrictEqual({ output: false, remainingTicks: 0 })
      state = ticks(unlocked, 2, state)
      expect(state.repeaters.get('repeater')).toMatchObject({ output: false, remainingTicks: 1 })
      state = advanceTimedCircuit(unlocked, state)
      expect(state.repeaters.get('repeater')).toStrictEqual({ output: true, remainingTicks: 0 })
    }),
  )

  it.effect('samples the side from the previous tick before locking a powered repeater', () =>
    Effect.sync(() => {
      const board: CircuitBoard = {
        components: new Map([
          ['rear', { kind: 'lever', active: false }],
          ['side', { kind: 'lever', active: true }],
          ['repeater', { kind: 'repeater', inputFrom: 'rear', outputTo: 'out', sideInputs: ['side'], delayTicks: 1 }],
          ['out', { kind: 'wire' }],
        ]),
        adjacency: new Map([
          ['rear', []],
          ['side', []],
          ['repeater', []],
          ['out', []],
        ]),
      }
      const powered: TimedCircuitState = {
        power: new Map([['repeater', 15], ['out', 15]]),
        repeaters: new Map([['repeater', { output: true, remainingTicks: 0 }]]),
        buttons: new Map(),
      }

      const beforeLockArrives = advanceTimedCircuit(board, powered)
      expect(beforeLockArrives.repeaters.get('repeater')?.output).toBe(false)
      const locked = advanceTimedCircuit(board, {
        ...beforeLockArrives,
        repeaters: new Map([['repeater', { output: true, remainingTicks: 0 }]]),
      })
      expect(locked.repeaters.get('repeater')).toStrictEqual({ output: true, remainingTicks: 0 })
    }),
  )

  it.effect('side-lock cycles are insertion-order independent and missing side cells are unpowered', () =>
    Effect.sync(() => {
      const cells: ReadonlyArray<readonly [string, Component]> = [
        ['a', { kind: 'repeater', inputFrom: 'missing-rear-a', sideInputs: ['b'], outputTo: 'a-out' }],
        ['b', { kind: 'repeater', inputFrom: 'missing-rear-b', sideInputs: ['a'], outputTo: 'b-out' }],
        ['a-out', { kind: 'wire' }],
        ['b-out', { kind: 'wire' }],
        ['ordinary', { kind: 'repeater', inputFrom: 'rear', outputTo: 'ordinary-out' }],
        ['rear', { kind: 'lever', active: true }],
        ['ordinary-out', { kind: 'wire' }],
      ]
      const makeBoard = (entries: typeof cells): CircuitBoard => ({
        components: new Map(entries),
        adjacency: new Map(entries.map(([key]) => [key, []])),
      })
      const initial: TimedCircuitState = {
        power: new Map([['a', 15], ['b', 15]]),
        repeaters: new Map([
          ['a', { output: true, remainingTicks: 0 }],
          ['b', { output: true, remainingTicks: 0 }],
        ]),
        buttons: new Map(),
      }

      const forward = ticks(makeBoard(cells), 2, initial)
      const reverse = ticks(makeBoard([...cells].reverse()), 2, initial)
      expect([...forward.power].sort()).toStrictEqual([...reverse.power].sort())
      expect([...forward.repeaters].sort()).toStrictEqual([...reverse.repeaters].sort())
      expect(forward.repeaters.get('a')?.output).toBe(true)
      expect(forward.repeaters.get('b')?.output).toBe(true)
      expect(forward.repeaters.get('ordinary')?.output).toBe(true)
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

  it.effect('burns out a rapid torch clock and relights after the cooldown', () =>
    Effect.sync(() => {
      const board: CircuitBoard = {
        adjacency: new Map([['torch', []]]),
        components: new Map([['torch', { invertedBy: 'torch', kind: 'torch' }]]),
      }
      let state = emptyTimedCircuitState
      let offTransitions = 0
      let previousOutput = false

      while (offTransitions < TORCH_BURNOUT_TOGGLE_LIMIT) {
        state = advanceTimedCircuit(board, state)
        const output = state.torches?.get('torch')?.output ?? false
        if (previousOutput && !output) {
          offTransitions += 1
        }
        previousOutput = output
      }

      expect(state.torches?.get('torch')).toMatchObject({
        burnoutRemainingTicks: TORCH_BURNOUT_COOLDOWN_TICKS,
        output: false,
      })
      state = ticks(board, TORCH_BURNOUT_COOLDOWN_TICKS - 1, state)
      expect(state.torches?.get('torch')?.output).toBe(false)
      state = advanceTimedCircuit(board, state)
      expect(state.torches?.get('torch')?.output).toBe(true)
    }),
  )

  it.effect('torch burnout is deterministic across component insertion order', () =>
    Effect.sync(() => {
      const cells: ReadonlyArray<readonly [string, Component]> = [
        ['a', { invertedBy: 'a', kind: 'torch' }],
        ['b', { invertedBy: 'b', kind: 'torch' }],
      ]
      const makeBoard = (entries: typeof cells): CircuitBoard => ({
        adjacency: new Map(entries.map(([key]) => [key, []])),
        components: new Map(entries),
      })
      const count = TORCH_BURNOUT_TOGGLE_LIMIT * 2
      const forward = ticks(makeBoard(cells), count)
      const reverse = ticks(makeBoard([...cells].reverse()), count)

      expect([...forward.power].sort()).toStrictEqual([...reverse.power].sort())
      expect([...forward.torches ?? []].sort()).toStrictEqual([...reverse.torches ?? []].sort())
      expect(forward.torches?.get('a')?.burnoutRemainingTicks).toBeGreaterThan(0)
      expect(forward.torches?.get('b')?.burnoutRemainingTicks).toBeGreaterThan(0)
    }),
  )
})
