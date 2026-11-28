import { describe, expect, it } from '@effect/vitest'
import { NonNegativeTickCount } from '@nerima-games/mc-kernel'
import * as fc from 'fast-check'
import { Effect } from 'effect'
import type { CircuitBoard, Component, PowerTickContext } from '../src/domain/power-graph'
import { powerAt } from '../src/domain/power-graph'
import type { TargetHit } from '../src/domain/target-block'
import {
  advanceTimedCircuit,
  advanceTimedCircuitWithContext,
  advanceTimedCircuitWithInputs,
  advanceTimedCircuitWithProvenanceContext,
  emptyTimedCircuitState,
  type TimedCircuitState,
} from '../src/domain/power-timing'

const NEXT_TICK = 1
const TORCH_CLOCK_PHASES = 2
// Java Edition burns a torch out after more than eight forced-off changes in the last 60 game ticks.
// One redstone tick is two game ticks. Source: https://minecraft.wiki/w/Redstone_Torch
const JAVA_TORCH_FORCED_OFF_CHANGE_LIMIT = 8
const JAVA_TORCH_BURNOUT_WINDOW_GAME_TICKS = 60
const GAME_TICKS_PER_REDSTONE_TICK = 2
const JAVA_TORCH_BURNOUT_WINDOW_REDSTONE_TICKS =
  JAVA_TORCH_BURNOUT_WINDOW_GAME_TICKS / GAME_TICKS_PER_REDSTONE_TICK
const JAVA_TORCH_BURNOUT_TRIGGER_TRANSITIONS = JAVA_TORCH_FORCED_OFF_CHANGE_LIMIT + 1

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
  it.effect('treats omitted pressedButtons as an empty set', () =>
    Effect.sync(() => {
      // BUG: omitting the optional frame input throws or accidentally retriggers a button.
      const board = line([
        ['button', { kind: 'button', active: false }],
        ['wire', { kind: 'wire' }],
      ])
      const state = advanceTimedCircuitWithContext({ board, previous: emptyTimedCircuitState })

      expect(state.buttons.get('button')).toStrictEqual({ inputActive: false, remainingTicks: 0 })
      expect(powerAt(state.power, 'wire')).toBe(0)
    }),
  )

  it.effect('collects block provenance in one timed traversal while ordinary ticks omit it', () =>
    Effect.sync(() => {
      // This catches recorder ticks that need a second graph traversal or normal ticks that retain provenance.
      const board: CircuitBoard = {
        adjacency: new Map([
          ['lever', []],
          ['wire', []],
        ]),
        components: new Map([
          ['lever', { kind: 'lever', active: true, strongPowerTo: 'block' }],
          ['wire', { kind: 'wire' }],
        ]),
      }
      const neighbourCalls = new Map<string, number>()
      const context: PowerTickContext = {
        faceNeighboursOf: (key) => {
          neighbourCalls.set(key, (neighbourCalls.get(key) ?? 0) + 1)
          return key === 'lever' ? ['block'] : key === 'block' ? ['wire'] : []
        },
        isRedstoneConductiveAt: (key) => key === 'block',
      }
      const normal = advanceTimedCircuitWithContext({ board, previous: emptyTimedCircuitState, pressedButtons: new Set(), context })
      neighbourCalls.clear()
      const recorded = advanceTimedCircuitWithProvenanceContext({ board, previous: emptyTimedCircuitState, pressedButtons: new Set(), context })

      expect(normal.power).toStrictEqual(recorded.power)
      expect(normal.blockPower).toStrictEqual(recorded.blockPower)
      expect('provenance' in normal).toBe(false)
      expect([...neighbourCalls.values()].reduce((total, count) => total + count, 0)).toBe(3)
      expect(recorded.provenance.get('wire')).toStrictEqual([
        { attenuation: 0, predecessor: 'block', source: 'lever', sourceLevel: 15 },
      ])
    }),
  )

  it.effect('reads previous block power for repeater rear input and torch inversion', () =>
    Effect.sync(() => {
      // This catches timers reading only component power when a solid block supplies their input.
      const board: CircuitBoard = {
        adjacency: new Map([
          ['repeater', ['out']],
          ['out', ['repeater']],
          ['torch', []],
        ]),
        components: new Map([
          ['repeater', { inputFrom: 'rear-block', kind: 'repeater', outputTo: 'out' }],
          ['out', { kind: 'wire' }],
          ['torch', { invertedBy: 'torch-support', kind: 'torch' }],
        ]),
      }
      const context: PowerTickContext = {
        faceNeighboursOf: () => [],
        isRedstoneConductiveAt: () => false,
        previousBlockPower: new Map([
          ['rear-block', { strongLevel: 1, weakLevel: 0 }],
          ['torch-support', { strongLevel: 0, weakLevel: 4 }],
        ]),
      }
      const state = advanceTimedCircuitWithContext({ board, previous: emptyTimedCircuitState, pressedButtons: new Set(), context })

      expect(state.repeaters.get('repeater')?.output).toBe(true)
      expect(powerAt(state.power, 'out')).toBe(15)
      expect(state.torches?.get('torch')?.output).toBe(false)
    }),
  )

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

  it.effect('repeater delay output matches an independent tick-count oracle', () =>
    Effect.sync(() => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 4 }), (delayTicks) => {
          const board = line([
            ['lever', { kind: 'lever', active: true }],
            ['rear', { kind: 'wire' }],
            ['repeater', { delayTicks, inputFrom: 'rear', kind: 'repeater' }],
          ])
          let state = emptyTimedCircuitState
          for (let tick = 1; tick <= delayTicks + 1; tick += 1) {
            state = advanceTimedCircuit(board, state)
            const expected = tick > delayTicks ? 15 : 0
            expect(powerAt(state.power, 'repeater')).toBe(expected)
          }
        }),
      )
    }),
  )

  it.effect('decoded locked state holds output and explicit unlocked state ignores side power', () =>
    Effect.sync(() => {
      const poweredInputs = new Map([
        ['rear', 15],
        ['side', 15],
      ])
      const base = line([
        ['rear', { active: false, kind: 'lever' }],
        ['side', { active: true, kind: 'lever' }],
        ['repeater', { delayTicks: 1, inputFrom: 'rear', kind: 'repeater', locked: false, sideInputs: ['side'] }],
      ])
      const powered = advanceTimedCircuit(base, { ...emptyTimedCircuitState, power: poweredInputs })
      expect(powered.repeaters.get('repeater')?.output).toBe(true)

      const outputOn = {
        ...emptyTimedCircuitState,
        power: new Map([
          ['rear', 0],
          ['side', 15],
          ['repeater', 15],
        ]),
        repeaters: new Map([['repeater', { output: true, remainingTicks: 0 }]]),
      }
      const explicitlyLocked = {
        ...base,
        components: new Map(base.components).set('repeater', {
          ...base.components.get('repeater'),
          kind: 'repeater' as const,
          locked: true,
        }),
      }
      expect(advanceTimedCircuit(explicitlyLocked, outputOn).repeaters.get('repeater')?.output).toBe(true)
      expect(advanceTimedCircuit(base, outputOn).repeaters.get('repeater')?.output).toBe(false)
    }),
  )

  it.effect('observer detects a state identity change and holds output for exactly one redstone tick', () =>
    Effect.sync(() => {
      const board = line([
        ['observer', { kind: 'observer', observedBlock: 'stone[lit=false]', outputTo: 'out' }],
        ['out', { kind: 'wire' }],
      ])
      let state = advanceTimedCircuit(board, emptyTimedCircuitState)
      expect(powerAt(state.power, 'out')).toBe(0)

      const changedBoard: CircuitBoard = {
        ...board,
        components: new Map(board.components).set('observer', {
          kind: 'observer',
          observedBlock: 'stone[lit=true]',
          outputTo: 'out',
        }),
      }
      state = advanceTimedCircuit(changedBoard, state)
      expect(state.observers?.get('observer')).toStrictEqual({ output: true, remainingTicks: 1 })
      expect(powerAt(state.power, 'out')).toBe(15)

      state = advanceTimedCircuit(changedBoard, state)
      expect(state.observers?.get('observer')).toStrictEqual({ output: false, remainingTicks: 0 })
      expect(powerAt(state.power, 'out')).toBe(0)
    }),
  )

  it.effect('does not track an observer whose watched block identity is unavailable', () =>
    Effect.sync(() => {
      const board = line([
        ['observer', { kind: 'observer', outputTo: 'out' }],
        ['out', { kind: 'wire' }],
      ])
      const state = advanceTimedCircuit(board, emptyTimedCircuitState)

      expect(state.observerSeen).toStrictEqual(new Map())
      expect(state.observers?.get('observer')).toStrictEqual({ output: false, remainingTicks: 0 })
      expect(powerAt(state.power, 'out')).toBe(0)
    }),
  )

  it.effect('extends short repeater pulses to the configured delay', () =>
    Effect.sync(() => {
      for (const delayTicks of [1, 2, 3, 4]) {
        for (let pulseTicks = 1; pulseTicks <= delayTicks + 1; pulseTicks += 1) {
          const board = line([
            ['lever', { kind: 'lever', active: true }],
            ['rear', { kind: 'wire' }],
            ['repeater', { kind: 'repeater', inputFrom: 'rear', outputTo: 'out', delayTicks }],
            ['out', { kind: 'wire' }],
          ])
          const off: CircuitBoard = {
            ...board,
            components: new Map(board.components).set('lever', { kind: 'lever', active: false }),
          }
          let state = emptyTimedCircuitState
          for (let frame = 1; frame <= delayTicks + Math.max(delayTicks, pulseTicks) + 1; frame += 1) {
            state = advanceTimedCircuit(frame <= pulseTicks ? board : off, state)
            const on = frame >= delayTicks + 1 && frame < delayTicks + Math.max(delayTicks, pulseTicks) + 1
            expect(powerAt(state.power, 'out')).toBe(on ? 15 : 0)
          }
        }
      }
    }),
  )

  it.effect('ignores short input interruptions and delays longer interruptions', () =>
    Effect.sync(() => {
      for (const delayTicks of [1, 2, 3, 4]) {
        for (let offTicks = 1; offTicks <= delayTicks + 1; offTicks += 1) {
          const on = line([
            ['lever', { kind: 'lever', active: true }],
            ['rear', { kind: 'wire' }],
            ['repeater', { kind: 'repeater', inputFrom: 'rear', outputTo: 'out', delayTicks }],
            ['out', { kind: 'wire' }],
          ])
          const off: CircuitBoard = {
            ...on,
            components: new Map(on.components).set('lever', { kind: 'lever', active: false }),
          }
          let state = ticks(on, delayTicks + 1)
          for (let frame = 1; frame <= offTicks + delayTicks + 1; frame += 1) {
            state = advanceTimedCircuit(frame <= offTicks ? off : on, state)
            const outputOff = offTicks >= delayTicks && frame >= delayTicks + 1 && frame < offTicks + delayTicks + 1
            expect(powerAt(state.power, 'out')).toBe(outputOff ? 0 : 15)
          }
        }
      }
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

  it.effect('a repeater whose side is already powered on its very first tick holds low, having never produced a timer', () =>
    Effect.sync(() => {
      const board: CircuitBoard = {
        components: new Map([
          ['side', { kind: 'lever', active: true }],
          ['repeater', { kind: 'repeater', inputFrom: 'rear', outputTo: 'out', sideInputs: ['side'] }],
          ['out', { kind: 'wire' }],
        ]),
        adjacency: new Map([
          ['side', []],
          ['repeater', []],
          ['out', []],
        ]),
      }
      // No prior tick ever ran: the repeaters map is empty, so this is
      // `holdRepeater(undefined)` — a repeater placed into a world where its
      // side input is already live, before it has ever produced a timer of
      // its own. It must hold at `output: false`, not throw or default to
      // whatever `previous.output` would have been.
      const alreadyPowered: TimedCircuitState = {
        power: new Map([['side', 15]]),
        repeaters: new Map(),
        buttons: new Map(),
      }
      const state = advanceTimedCircuit(board, alreadyPowered)
      expect(state.repeaters.get('repeater')).toStrictEqual({ output: false, remainingTicks: 0 })
      expect(powerAt(state.power, 'out')).toBe(0)
    }),
  )

  it.effect('a repeater with no rear input never requests output, even amid unrelated power', () =>
    Effect.sync(() => {
      const board = line([
        ['lever', { kind: 'lever', active: true }],
        ['unrelated', { kind: 'wire' }],
        ['repeater', { kind: 'repeater', outputTo: 'out' }],
        ['out', { kind: 'wire' }],
      ])
      const state = advanceTimedCircuit(board, emptyTimedCircuitState)
      expect(state.repeaters.get('repeater')).toStrictEqual({ output: false, remainingTicks: 0 })
      expect(powerAt(state.power, 'out')).toBe(0)
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

  it.effect('a two-torch loop with a one-tick repeater repeats every three redstone ticks', () =>
    Effect.sync(() => {
      const board = line([
        ['torch-a', { invertedBy: 'torch-b', kind: 'torch' }],
        ['torch-b', { invertedBy: 'repeater', kind: 'torch' }],
        ['repeater', { delayTicks: 1, inputFrom: 'torch-a', kind: 'repeater' }],
      ])
      const expectedTorchA = [true, false, false, true, false, false, true, false, false]
      const expectedTorchB = [true, true, false, true, true, false, true, true, false]
      const expectedRepeater = [false, true, false, false, true, false, false, true, false]
      let state = emptyTimedCircuitState

      for (let tick = 0; tick < expectedTorchA.length; tick += 1) {
        state = advanceTimedCircuit(board, state)
        expect(state.torches?.get('torch-a')?.output).toBe(expectedTorchA[tick])
        expect(state.torches?.get('torch-b')?.output).toBe(expectedTorchB[tick])
        expect(state.repeaters.get('repeater')?.output).toBe(expectedRepeater[tick])
      }
    }),
  )

  it.effect('burns out on the ninth forced-off transition and relights after 80 redstone ticks', () =>
    Effect.sync(() => {
      const board: CircuitBoard = {
        adjacency: new Map([['torch', []]]),
        components: new Map([['torch', { invertedBy: 'torch', kind: 'torch' }]]),
      }
      const eightOffs = ticks(board, JAVA_TORCH_FORCED_OFF_CHANGE_LIMIT * TORCH_CLOCK_PHASES)
      expect(eightOffs.torches?.get('torch')).toMatchObject({
        burnedOut: false,
        output: false,
      })
      expect(eightOffs.torches?.get('torch')?.recentOffTicks).toHaveLength(
        JAVA_TORCH_FORCED_OFF_CHANGE_LIMIT,
      )

      let state = ticks(board, TORCH_CLOCK_PHASES, eightOffs)
      expect(
        JAVA_TORCH_BURNOUT_TRIGGER_TRANSITIONS * TORCH_CLOCK_PHASES * GAME_TICKS_PER_REDSTONE_TICK,
      ).toBeLessThan(JAVA_TORCH_BURNOUT_WINDOW_GAME_TICKS)

      expect(state.torches?.get('torch')).toMatchObject({
        burnedOut: true,
        output: false,
      })
      expect(state.torches?.get('torch')?.recentOffTicks).toHaveLength(
        JAVA_TORCH_BURNOUT_TRIGGER_TRANSITIONS,
      )

      state = ticks(board, 79, state)
      expect(state.torches?.get('torch')).toMatchObject({ burnedOut: true, cooldownTicks: 1, output: false })
      expect(state.torches?.get('torch')?.recentOffTicks).toHaveLength(0)

      state = advanceTimedCircuit(board, state)
      expect(state.torches?.get('torch')).toStrictEqual({ burnedOut: false, output: true, recentOffTicks: [] })
    }),
  )

  it.effect('keeps an eighth change at 58 game ticks old and removes it at 60', () =>
    Effect.sync(() => {
      const board: CircuitBoard = {
        adjacency: new Map([['torch', []]]),
        components: new Map([['torch', { kind: 'torch' }]]),
      }
      const edgeState: TimedCircuitState = {
        ...emptyTimedCircuitState,
        torches: new Map([['torch', {
          burnedOut: false,
          output: false,
          recentOffTicks: [
            ...Array.from({ length: JAVA_TORCH_FORCED_OFF_CHANGE_LIMIT - NEXT_TICK }, () => 0),
            JAVA_TORCH_BURNOUT_WINDOW_REDSTONE_TICKS - 2,
          ],
        }]]),
      }

      const oneTickBeforeExpiry = advanceTimedCircuit(board, edgeState)
      expect(oneTickBeforeExpiry.torches?.get('torch')).toStrictEqual({
        burnedOut: false,
        output: true,
        recentOffTicks: [
          ...Array.from({ length: JAVA_TORCH_FORCED_OFF_CHANGE_LIMIT - NEXT_TICK }, () => NEXT_TICK),
          JAVA_TORCH_BURNOUT_WINDOW_REDSTONE_TICKS - NEXT_TICK,
        ],
      })

      const atExpiry = advanceTimedCircuit(board, oneTickBeforeExpiry)
      expect(atExpiry.torches?.get('torch')).toStrictEqual({
        burnedOut: false,
        output: true,
        recentOffTicks: Array.from(
          { length: JAVA_TORCH_FORCED_OFF_CHANGE_LIMIT - NEXT_TICK },
          () => 2,
        ),
      })
    }),
  )

  it.effect('treats an absent or expired cooldown as ready to sample the support', () =>
    Effect.sync(() => {
      const board: CircuitBoard = {
        adjacency: new Map([['torch', []]]),
        components: new Map([['torch', { invertedBy: 'support', kind: 'torch' }]]),
      }
      for (const cooldown of [undefined, 0, 1, 2]) {
        for (const inputPower of [0, 15]) {
          const state: TimedCircuitState = {
            ...emptyTimedCircuitState,
            power: new Map([['support', inputPower]]),
            torches: new Map([['torch', {
              burnedOut: true,
              output: false,
              recentOffTicks: Array.from({ length: JAVA_TORCH_BURNOUT_TRIGGER_TRANSITIONS }, () => 0),
              ...(cooldown === undefined ? {} : { cooldownTicks: NonNegativeTickCount(cooldown) }),
            }]]),
          }
          const next = advanceTimedCircuit(board, state)
          const held = cooldown === 2
          expect(next.torches?.get('torch')).toStrictEqual({
            burnedOut: held,
            ...(held ? { cooldownTicks: NonNegativeTickCount(1) } : {}),
            output: !held && inputPower === 0,
            recentOffTicks: Array.from({ length: JAVA_TORCH_BURNOUT_TRIGGER_TRANSITIONS }, () => 1),
          })
        }
      }
    }),
  )

  it.effect('samples the support at cooldown expiry and can burn out again', () =>
    Effect.sync(() => {
      const clock: CircuitBoard = {
        adjacency: new Map([['torch', []], ['other', []]]),
        components: new Map([
          ['torch', { invertedBy: 'torch', kind: 'torch' }],
          ['other', { invertedBy: 'other', kind: 'torch' }],
        ]),
      }
      const inputBoard: CircuitBoard = {
        adjacency: new Map([['torch', []], ['other', []]]),
        components: new Map([
          ['torch', { invertedBy: 'support', kind: 'torch' }],
          ['other', { invertedBy: 'other-support', kind: 'torch' }],
        ]),
      }
      let state = ticks(clock, JAVA_TORCH_BURNOUT_TRIGGER_TRANSITIONS * TORCH_CLOCK_PHASES)
      for (let tick = 1; tick < 80; tick += 1) {
        state = { ...state, power: new Map([['support', tick % 2 === 0 ? 15 : 0]]) }
        state = advanceTimedCircuit(inputBoard, state)
        expect(state.torches?.get('torch')).toMatchObject({ burnedOut: true, output: false, cooldownTicks: 80 - tick })
        expect(state.torches?.get('other')).toMatchObject({ burnedOut: true, output: false, cooldownTicks: 80 - tick })
      }
      state = { ...state, power: new Map([['support', 15]]) }
      state = advanceTimedCircuit(inputBoard, state)
      expect(state.torches?.get('torch')).toStrictEqual({ burnedOut: false, output: false, recentOffTicks: [] })
      expect(state.torches?.get('other')).toStrictEqual({ burnedOut: false, output: true, recentOffTicks: [] })

      state = advanceTimedCircuit(inputBoard, { ...state, power: new Map() })
      expect(state.torches?.get('torch')?.output).toBe(true)
      state = ticks(clock, JAVA_TORCH_BURNOUT_TRIGGER_TRANSITIONS * TORCH_CLOCK_PHASES - 1, state)
      expect(state.torches?.get('torch')).toMatchObject({ burnedOut: true, output: false, cooldownTicks: 80 })
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
      const count = JAVA_TORCH_BURNOUT_TRIGGER_TRANSITIONS * TORCH_CLOCK_PHASES
      const forward = ticks(makeBoard(cells), count)
      const reverse = ticks(makeBoard([...cells].reverse()), count)

      expect([...forward.power].sort()).toStrictEqual([...reverse.power].sort())
      expect([...forward.torches ?? []].sort()).toStrictEqual([...reverse.torches ?? []].sort())
      expect(forward.torches?.get('a')?.burnedOut).toBe(true)
      expect(forward.torches?.get('b')?.burnedOut).toBe(true)
    }),
  )

  it.effect('a torch with no invertedBy input is simply always on', () =>
    Effect.sync(() => {
      const board: CircuitBoard = {
        adjacency: new Map([['torch', []]]),
        // No `invertedBy`: this torch isn't wired to invert any neighbour's
        // signal, so it has nothing to ever turn it off — a standalone torch
        // stuck to a block always emits.
        components: new Map([['torch', { kind: 'torch' }]]),
      }
      const state = advanceTimedCircuit(board, emptyTimedCircuitState)
      expect(state.torches?.get('torch')).toStrictEqual({
        burnedOut: false,
        output: true,
        recentOffTicks: [],
      })
    }),
  )

  it.effect('a non-clock circuit reaches a fixed point and stays there, rather than drifting or oscillating', () =>
    Effect.sync(() => {
      // Two repeaters at different delays feeding a permanently-locked third:
      // everything here settles, unlike the self-inverting torch above, which
      // is a clock by construction and must never stop toggling. A circuit
      // that quietly drifts — a timer field that keeps counting past zero, a
      // `Map` entry that keeps getting rebuilt with a new identity each tick
      // — would pass every single-state assertion elsewhere in this file
      // while still failing this one, since none of them re-tick after the
      // state they check.
      const board = line([
        ['lever', { active: true, kind: 'lever' }],
        ['rear', { kind: 'wire' }],
        ['fast', { delayTicks: 1, inputFrom: 'rear', kind: 'repeater', outputTo: 'mid' }],
        ['mid', { kind: 'wire' }],
        ['slow', { delayTicks: 4, inputFrom: 'mid', kind: 'repeater', outputTo: 'lockedIn' }],
        ['lockedIn', { kind: 'wire' }],
      ])
      const boardWithLockedTail: CircuitBoard = {
        ...board,
        components: new Map(board.components)
          .set('lockLever', { active: true, kind: 'lever' })
          .set('locked', {
            delayTicks: 2,
            inputFrom: 'lockedIn',
            kind: 'repeater',
            outputTo: 'out',
            sideInputs: ['lockLever'],
          })
          .set('out', { kind: 'wire' }),
        adjacency: new Map(board.adjacency)
          .set('lockLever', [])
          .set('locked', ['lockedIn', 'out'])
          .set('out', ['locked']),
      }

      const SETTLE_TICKS = 12
      const EXTRA_TICKS = 6
      const settled = ticks(boardWithLockedTail, SETTLE_TICKS)
      // `locked`'s side is permanently powered, so it never gets to finish a
      // transition — the state most likely to be mistaken for "still moving".
      expect(settled.repeaters.get('locked')).toStrictEqual({ output: false, remainingTicks: 0 })

      let state = settled
      for (let tick = 0; tick < EXTRA_TICKS; tick += 1) {
        state = advanceTimedCircuit(boardWithLockedTail, state)
        expect(state).toStrictEqual(settled)
      }
    }),
  )
})

describe('target hold', () => {
  const targetBoard = line([
    ['target', { kind: 'target' }],
    ['wire', { kind: 'wire' }],
  ])
  const centreHit: TargetHit = { horizontal: 0.5, vertical: 0.5 }
  // Hit at 0.25 from the centre line: signal 8, against 15 at the centre.
  const offCentreHit: TargetHit = { horizontal: 0.25, vertical: 0.5 }

  /** Power on the wire after each of `count` ticks; `hits` maps a tick number to that tick's hit. */
  const wirePowerPerTick = (
    count: number,
    hits: ReadonlyMap<number, TargetHit>,
    board: CircuitBoard = targetBoard,
  ): ReadonlyArray<number> => {
    let state: TimedCircuitState = emptyTimedCircuitState
    const readings: Array<number> = []
    for (let tick = 0; tick < count; tick += 1) {
      const hit = hits.get(tick)
      state = advanceTimedCircuitWithInputs(board, state, {
        ...(hit === undefined ? {} : { targetHits: new Map([['target', hit]]) }),
      })
      readings.push(powerAt(state.power, 'wire'))
    }
    return readings
  }

  const poweredTicks = (readings: ReadonlyArray<number>): number => readings.filter((level) => level > 0).length

  it.effect('powers a target from the tick of the hit for exactly the projectile hold time', () =>
    Effect.sync(() => {
      const holdTicks = [
        ['arrow', 10],
        ['trident', 10],
        ['other', 4],
      ] as const
      for (const [projectile, hold] of holdTicks) {
        const readings = wirePowerPerTick(14, new Map([[0, { ...centreHit, projectile }]]))
        expect(readings.slice(0, hold).every((level) => level > 0), projectile).toBe(true)
        expect(poweredTicks(readings), projectile).toBe(hold)
      }
      expect(poweredTicks(wirePowerPerTick(14, new Map([[0, centreHit]])))).toBe(4)
    }),
  )

  it.effect('emits the signal of the hit for the whole hold', () =>
    Effect.sync(() => {
      const readings = wirePowerPerTick(6, new Map([[0, offCentreHit]]))
      expect(readings.slice(0, 4)).toStrictEqual([8, 8, 8, 8])
      expect(readings.slice(4)).toStrictEqual([0, 0])
    }),
  )

  it.effect('ignores a hit while the target is still held, keeping its signal and its release', () =>
    Effect.sync(() => {
      const readings = wirePowerPerTick(6, new Map([
        [0, offCentreHit],
        [2, { ...centreHit, projectile: 'arrow' }],
      ]))
      expect(readings).toStrictEqual([8, 8, 8, 8, 0, 0])
    }),
  )

  it.effect('a hit on the tick the hold ends powers the target afresh with its own signal and time', () =>
    Effect.sync(() => {
      const readings = wirePowerPerTick(12, new Map([
        [0, offCentreHit],
        [4, { ...centreHit, projectile: 'arrow' }],
      ]))
      expect(readings.slice(0, 4)).toStrictEqual([8, 8, 8, 8])
      expect(readings.slice(4, 12)).toStrictEqual([15, 15, 15, 15, 15, 15, 15, 15])
    }),
  )

  it.effect('keeps whatever the world declares for a target nothing has hit', () =>
    Effect.sync(() => {
      const declared = line([
        ['target', { kind: 'target', active: true, emits: 6 }],
        ['wire', { kind: 'wire' }],
      ])
      expect(wirePowerPerTick(3, new Map(), declared)).toStrictEqual([6, 6, 6])
      expect(wirePowerPerTick(3, new Map(), targetBoard)).toStrictEqual([0, 0, 0])
    }),
  )

  it.effect('a hit overrides a declared target while it holds and gives the declaration back after', () =>
    Effect.sync(() => {
      const declared = line([
        ['target', { kind: 'target', active: true, emits: 6 }],
        ['wire', { kind: 'wire' }],
      ])
      expect(wirePowerPerTick(6, new Map([[1, centreHit]]), declared)).toStrictEqual([6, 15, 15, 15, 15, 6])
    }),
  )

  it.effect('ignores a hit on a component that is not a target', () =>
    Effect.sync(() => {
      const board = line([
        ['lever', { kind: 'lever', active: false }],
        ['wire', { kind: 'wire' }],
      ])
      const state = advanceTimedCircuitWithInputs(board, emptyTimedCircuitState, {
        targetHits: new Map([['lever', centreHit]]),
      })
      expect(powerAt(state.power, 'wire')).toBe(0)
      expect(state.targets?.size).toBe(0)
    }),
  )

  it.effect('records the hold in the timed state and the context-aware advance agrees with the map-only one', () =>
    Effect.sync(() => {
      const targetHits = new Map([['target', { ...centreHit, projectile: 'arrow' as const }]])
      const plain = advanceTimedCircuitWithInputs(targetBoard, emptyTimedCircuitState, { targetHits })
      const withContext = advanceTimedCircuitWithContext({ board: targetBoard, previous: emptyTimedCircuitState, targetHits })
      const withProvenance = advanceTimedCircuitWithProvenanceContext({
        board: targetBoard,
        previous: emptyTimedCircuitState,
        targetHits,
      })

      expect(plain.targets?.get('target')).toStrictEqual({ level: 15, remainingTicks: 9 })
      expect(withContext.targets.get('target')).toStrictEqual({ level: 15, remainingTicks: 9 })
      expect(withProvenance.targets.get('target')).toStrictEqual({ level: 15, remainingTicks: 9 })
      expect(withContext.power).toStrictEqual(plain.power)
      expect(withProvenance.power).toStrictEqual(plain.power)
    }),
  )
})
