import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import {
  type CircuitBoard,
  type Component,
  type ComponentKind,
  componentEntriesForKinds,
  powerAt,
} from '../src/domain/power-graph'
import {
  type TimedCircuitState,
  advanceTimedCircuit,
  emptyTimedCircuitState,
} from '../src/domain/timed-power-graph'

const indexedLine = (cells: ReadonlyArray<readonly [string, Component]>): CircuitBoard => {
  const componentKeysByKind = new Map<ComponentKind, Array<string>>()
  for (const [key, component] of cells) {
    const keys = componentKeysByKind.get(component.kind) ?? []
    keys.push(key)
    componentKeysByKind.set(component.kind, keys)
  }
  return {
    adjacency: new Map(
      cells.map(([key], index) => [
        key,
        [cells[index - 1]?.[0], cells[index + 1]?.[0]].filter(
          (candidate): candidate is string => candidate !== undefined,
        ),
      ]),
    ),
    componentKeysByKind,
    components: new Map(cells),
  }
}

const withoutIndex = (board: CircuitBoard): CircuitBoard => ({
  adjacency: board.adjacency,
  components: board.components,
})

const advanceBoth = (
  board: CircuitBoard,
  indexed: TimedCircuitState,
  oracle: TimedCircuitState,
  pressed: ReadonlySet<string> = new Set(),
): readonly [TimedCircuitState, TimedCircuitState] => {
  const nextIndexed = advanceTimedCircuit(board, indexed, pressed)
  const nextOracle = advanceTimedCircuit(withoutIndex(board), oracle, pressed)
  expect(nextIndexed).toStrictEqual(nextOracle)
  return [nextIndexed, nextOracle]
}

describe('indexed power graph', () => {
  it.effect('keeps indexed and full-scan component selection equivalent with overrides', () =>
    Effect.sync(() => {
      const board = indexedLine([
        ['button', { kind: 'button', pulseTicks: 3 }],
        ['torch', { kind: 'torch' }],
        ['wire', { kind: 'wire' }],
      ])
      const kinds = new Set<ComponentKind>(['button', 'torch'])
      const overrides = new Map<string, Component>([
        ['button', { kind: 'button', active: true, pulseTicks: 3 }],
      ])

      expect([...componentEntriesForKinds(board, kinds, overrides)]).toStrictEqual(
        [...componentEntriesForKinds(withoutIndex(board), kinds, overrides)],
      )
    }),
  )

  it.effect('matches the full-scan oracle across boundaries, edits, continuous ticks and reruns', () =>
    Effect.sync(() => {
      const makeBoard = (includeTail: boolean) =>
        indexedLine([
          ['button', { kind: 'button', pulseTicks: 4 }],
          ...Array.from({ length: 14 }, (_, index) => [
            `wire-${index + 1}`,
            { kind: 'wire' },
          ] as const),
          ['boundary-lamp', { kind: 'lamp' }],
          ...(includeTail ? ([['dark-lamp', { kind: 'lamp' }]] as const) : []),
          ['repeater', { kind: 'repeater', inputFrom: 'boundary-lamp', delayTicks: 2 }],
          ['torch', { kind: 'torch', invertedBy: 'repeater' }],
        ])

      const run = () => {
        let indexed = emptyTimedCircuitState
        let oracle = emptyTimedCircuitState
        let board = makeBoard(true)
        for (let tick = 0; tick < 8; tick += 1) {
          ;[indexed, oracle] = advanceBoth(
            board,
            indexed,
            oracle,
            tick === 0 ? new Set(['button']) : new Set(),
          )
          if (tick === 0) {
            expect(powerAt(indexed.power, 'boundary-lamp')).toBe(1)
            expect(powerAt(indexed.power, 'dark-lamp')).toBe(0)
          }
        }
        expect(powerAt(indexed.power, 'boundary-lamp')).toBe(0)
        expect(powerAt(indexed.power, 'dark-lamp')).toBe(0)

        board = makeBoard(false)
        for (let tick = 0; tick < 4; tick += 1) {
          ;[indexed, oracle] = advanceBoth(board, indexed, oracle)
        }
        return indexed
      }

      expect(run()).toStrictEqual(run())
    }),
  )
})
