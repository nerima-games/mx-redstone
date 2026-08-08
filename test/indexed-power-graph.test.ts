import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import {
  type CircuitBoard,
  type Component,
  type ComponentKind,
  componentEntriesForKinds,
  emptyPowerMap,
  MAX_POWER_LEVEL,
  powerAt,
  sourcesOf,
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

  it.effect('an override that changes a component’s kind is not laundered through the stale index bucket', () =>
    Effect.sync(() => {
      // `indexedComponentEntries` looks a key up by KIND in `componentKeysByKind`
      // and then resolves the component at that key through `overrides`, without
      // re-checking that the resolved component's actual kind still belongs in
      // the bucket it was found under. A circuit-board preview overriding a
      // torch with a different component at the same key is exactly this: the
      // index still says "torch" here; the override says otherwise.
      const board = indexedLine([
        ['torch', { kind: 'torch' }],
        ['wire', { kind: 'wire' }],
      ])

      // Without an override, the indexed torch is a source: nothing inverts it,
      // so it burns permanently.
      expect(sourcesOf(board, emptyPowerMap).get('torch')).toBe(MAX_POWER_LEVEL)

      // A preview override replacing that torch with a wire does not touch
      // `componentKeysByKind` — the index still buckets this key under 'torch'.
      // `indexedComponentEntries` yields the override's ACTUAL component
      // (kind: 'wire') unfiltered, which sends a non-source kind through
      // `sourceLevelFor`'s four `if`s to its trailing `return NO_POWER_LEVEL`.
      const overrides = new Map<string, Component>([['torch', { kind: 'wire' }]])
      expect(sourcesOf(board, emptyPowerMap, overrides).has('torch')).toBe(false)

      // The full-scan oracle agrees: an override to a non-source kind is simply
      // not a source, so the indexed path is not merely quieter about it.
      expect(sourcesOf(withoutIndex(board), emptyPowerMap, overrides).has('torch')).toBe(false)
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
