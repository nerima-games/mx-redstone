/**
 * Circuit scenario tests: fixture circuit in, expected power out.
 *
 * This is the verification shape plan.md §3.12 asks for
 * (「回路シナリオテスト(fixture回路→期待状態)」). Each fixture is a literal, which
 * is only possible because `domain/power-graph.ts` takes adjacency as data
 * rather than deriving it from world geometry.
 */
import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import {
  emptyPowerMap,
  isLit,
  MAX_POWER_LEVEL,
  powerAt,
  propagateTick,
  settle,
  SETTLE_TICK_LIMIT,
  sourcesOf,
  type CircuitBoard,
  type Component,
} from '../domain/power-graph'

/**
 * Build a straight run: `cells[0]` — `cells[1]` — … Adjacency is undirected.
 */
const line = (cells: ReadonlyArray<readonly [string, Component]>): CircuitBoard => {
  const components = new Map(cells.map(([key, component]) => [key, component]))
  const adjacency = new Map<string, ReadonlyArray<string>>()

  for (const [index, [key]] of cells.entries()) {
    const neighbours: Array<string> = []
    const before = cells[index - 1]
    const after = cells[index + 1]
    if (before !== undefined) {
      neighbours.push(before[0])
    }
    if (after !== undefined) {
      neighbours.push(after[0])
    }
    adjacency.set(key, neighbours)
  }

  return { components, adjacency }
}

const wire = (): Component => ({ kind: 'wire' })

describe('wire propagation', () => {
  it.effect('a lever powers the wire beside it at 15 and each further cell loses one level', () =>
    Effect.sync(() => {
      const board = line([
        ['lever', { kind: 'lever', active: true }],
        ['w0', wire()],
        ['w1', wire()],
        ['w2', wire()],
        ['w3', wire()],
      ])

      const power = propagateTick(board, emptyPowerMap)

      expect(powerAt(power, 'lever')).toBe(MAX_POWER_LEVEL)
      expect(powerAt(power, 'w0')).toBe(14)
      expect(powerAt(power, 'w1')).toBe(13)
      expect(powerAt(power, 'w2')).toBe(12)
      expect(powerAt(power, 'w3')).toBe(11)
    }),
  )

  it.effect('REGRESSION: a wire run longer than 15 goes dark at the end, which is why repeaters exist', () =>
    Effect.sync(() => {
      const cells: Array<readonly [string, Component]> = [
        ['lever', { kind: 'lever', active: true }],
      ]
      for (let index = 0; index < 20; index += 1) {
        cells.push([`w${String(index)}`, wire()])
      }

      const power = propagateTick(line(cells), emptyPowerMap)

      expect(powerAt(power, 'w13')).toBe(1)
      expect(powerAt(power, 'w14')).toBe(0)
      expect(powerAt(power, 'w19')).toBe(0)
    }),
  )

  it.effect('an inactive lever powers nothing at all', () =>
    Effect.sync(() => {
      const board = line([
        ['lever', { kind: 'lever', active: false }],
        ['w0', wire()],
      ])
      expect([...propagateTick(board, emptyPowerMap).keys()]).toStrictEqual([])
    }),
  )

  it.effect('two sources feeding one wire give it the stronger of the two, not the sum', () =>
    Effect.sync(() => {
      const board = line([
        ['leverA', { kind: 'lever', active: true }],
        ['w0', wire()],
        ['w1', wire()],
        ['w2', wire()],
        ['leverB', { kind: 'lever', active: true }],
      ])

      const power = propagateTick(board, emptyPowerMap)
      expect(powerAt(power, 'w0')).toBe(14)
      expect(powerAt(power, 'w1')).toBe(13)
      expect(powerAt(power, 'w2')).toBe(14)
    }),
  )

  it.effect('REGRESSION: a lamp receives power but does not conduct it, so circuits do not join through one', () =>
    Effect.sync(() => {
      const board = line([
        ['lever', { kind: 'lever', active: true }],
        ['w0', wire()],
        ['lamp', { kind: 'lamp' }],
        ['w1', wire()],
        ['w2', wire()],
      ])

      const power = propagateTick(board, emptyPowerMap)

      expect(isLit(board, power, 'lamp')).toBe(true)
      // The wire on the far side of the lamp is dark. Letting a lamp conduct
      // silently welds two independent circuits together.
      expect(powerAt(power, 'w1')).toBe(0)
      expect(powerAt(power, 'w2')).toBe(0)
    }),
  )

  it.effect('isLit is false for a component that is not a lamp, however much power it carries', () =>
    Effect.sync(() => {
      const board = line([
        ['lever', { kind: 'lever', active: true }],
        ['w0', wire()],
      ])
      const power = propagateTick(board, emptyPowerMap)
      expect(powerAt(power, 'w0')).toBeGreaterThan(0)
      expect(isLit(board, power, 'w0')).toBe(false)
    }),
  )
})

describe('torch inversion — the one-tick delay every clock is built from', () => {
  const torchBoard = (leverActive: boolean): CircuitBoard => {
    const board = line([
      ['lever', { kind: 'lever', active: leverActive }],
      ['base', wire()],
      ['torch', { kind: 'torch', invertedBy: 'base' }],
      ['out', wire()],
    ])
    return board
  }

  it.effect('a torch with an unpowered input burns', () =>
    Effect.sync(() => {
      const power = propagateTick(torchBoard(false), emptyPowerMap)
      expect(powerAt(power, 'torch')).toBe(MAX_POWER_LEVEL)
      expect(powerAt(power, 'out')).toBe(14)
    }),
  )

  it.effect('REGRESSION: the torch reads the PREVIOUS tick, so inversion takes one tick rather than being instant', () =>
    Effect.sync(() => {
      const board = torchBoard(true)

      // Tick 1: the torch still sees last tick's (empty) power map, so it is
      // still burning even though its base is now powered.
      const first = propagateTick(board, emptyPowerMap)
      expect(powerAt(first, 'base')).toBe(14)
      expect(powerAt(first, 'torch')).toBe(MAX_POWER_LEVEL)

      // Tick 2: it sees the powered base and goes out.
      const second = propagateTick(board, first)
      expect(powerAt(second, 'torch')).toBe(0)

      // Computing the torch from the CURRENT map would collapse both ticks into
      // one and every clock circuit in the game would stop oscillating.
    }),
  )

  it.effect('a torch with no attachment is a permanent source, which is how a constant is written', () =>
    Effect.sync(() => {
      const board = line([
        ['torch', { kind: 'torch' }],
        ['w0', wire()],
      ])
      const power = settle(board)
      expect(power.oscillating).toBe(false)
      expect(powerAt(power.power, 'w0')).toBe(14)
    }),
  )
})

describe('repeaters', () => {
  it.effect('a repeater restores full power, so a signal can travel further than 15 cells', () =>
    Effect.sync(() => {
      const board = line([
        ['lever', { kind: 'lever', active: true }],
        ['w0', wire()],
        ['w1', wire()],
        ['repeater', { kind: 'repeater', inputFrom: 'w1' }],
        ['w2', wire()],
      ])

      // Tick 1 energises the wire; tick 2 lets the repeater see it.
      const settled = settle(board)
      expect(settled.oscillating).toBe(false)
      expect(powerAt(settled.power, 'repeater')).toBe(MAX_POWER_LEVEL)
      expect(powerAt(settled.power, 'w2')).toBe(14)
    }),
  )

  it.effect('a repeater with an unpowered input outputs nothing', () =>
    Effect.sync(() => {
      const board = line([
        ['w0', wire()],
        ['repeater', { kind: 'repeater', inputFrom: 'w0' }],
        ['w1', wire()],
      ])
      expect(settle(board).power.size).toBe(0)
    }),
  )

  it.effect('a repeater with no input at all is inert, not a source', () =>
    Effect.sync(() => {
      // The state of a repeater the player has just placed and not yet wired.
      // A torch with no attachment burns permanently; a repeater with no input
      // must NOT, or every fresh placement powers the circuit it was dropped
      // into.
      const board = line([
        ['repeater', { kind: 'repeater' }],
        ['w0', wire()],
      ])
      expect(settle(board).power.size).toBe(0)
    }),
  )
})

describe('degenerate boards', () => {
  it.effect('a component with no adjacency row is isolated rather than a crash', () =>
    Effect.sync(() => {
      // A board under construction in the preview — a lever dropped on the grid
      // before any wire is drawn — has components with no entry in `adjacency`.
      const board: CircuitBoard = {
        components: new Map<string, Component>([['lever', { kind: 'lever', active: true }]]),
        adjacency: new Map(),
      }

      const power = propagateTick(board, emptyPowerMap)
      expect(powerAt(power, 'lever')).toBe(MAX_POWER_LEVEL)
      expect(power.size).toBe(1)
    }),
  )

  it.effect('an adjacency edge pointing at a cell with no component is ignored', () =>
    Effect.sync(() => {
      // Left behind when the player deletes a component without redrawing the
      // adjacency. Following the dangling edge would put power at a coordinate
      // that is not on the board.
      const board: CircuitBoard = {
        components: new Map<string, Component>([['lever', { kind: 'lever', active: true }]]),
        adjacency: new Map([['lever', ['deleted']]]),
      }

      const power = propagateTick(board, emptyPowerMap)
      expect(powerAt(power, 'deleted')).toBe(0)
      expect(power.size).toBe(1)
    }),
  )

  it.effect('an empty board settles immediately with no power', () =>
    Effect.sync(() => {
      const result = settle({ components: new Map(), adjacency: new Map() })
      expect(result).toStrictEqual({ power: new Map(), ticks: 1, oscillating: false })
    }),
  )
})

describe('settling and oscillation', () => {
  it.effect('REGRESSION: a torch clock never settles, and `settle` says so instead of hanging', () =>
    Effect.sync(() => {
      // The minimal clock: a torch inverting a wire that it also powers.
      const board: CircuitBoard = {
        components: new Map<string, Component>([
          ['torch', { kind: 'torch', invertedBy: 'torch' }],
        ]),
        adjacency: new Map([['torch', []]]),
      }

      const result = settle(board)
      expect(result.oscillating).toBe(true)
      expect(result.ticks).toBe(SETTLE_TICK_LIMIT)
    }),
  )

  it.effect('an acyclic circuit settles well inside the tick limit', () =>
    Effect.sync(() => {
      const board = line([
        ['lever', { kind: 'lever', active: true }],
        ['w0', wire()],
        ['w1', wire()],
      ])
      const result = settle(board)
      expect(result.oscillating).toBe(false)
      expect(result.ticks).toBeLessThan(SETTLE_TICK_LIMIT)
    }),
  )

  it.effect('settle can resume from a given power map, which is what the preview step button needs', () =>
    Effect.sync(() => {
      const board = line([
        ['lever', { kind: 'lever', active: true }],
        ['w0', wire()],
      ])
      const once = propagateTick(board, emptyPowerMap)
      const resumed = settle(board, { from: once })
      expect(resumed.ticks).toBe(1)
      expect(powerAt(resumed.power, 'w0')).toBe(14)
    }),
  )

  it.effect('a resumed map that disagrees with the board is RECOMPUTED, not trusted', () =>
    Effect.sync(() => {
      // The preview can hand `settle` any map — including one it edited, or one
      // left over from a board that has since changed. `from` is a starting
      // point for the delayed components (torches, repeaters), never a claim
      // about wire levels, so a wrong level must be corrected on the first tick
      // rather than mistaken for a fixpoint.
      const board = line([
        ['lever', { kind: 'lever', active: true }],
        ['w0', wire()],
      ])
      const wrong = new Map([
        ['lever', MAX_POWER_LEVEL],
        ['w0', 99],
      ])

      const result = settle(board, { from: wrong })
      expect(result.oscillating).toBe(false)
      expect(powerAt(result.power, 'w0')).toBe(14)
      // Two ticks: one to correct, one to confirm the fixpoint.
      expect(result.ticks).toBe(2)
    }),
  )
})

describe('sourcesOf', () => {
  it.effect('reports exactly the generating cells, before any wire decay', () =>
    Effect.sync(() => {
      const board = line([
        ['lever', { kind: 'lever', active: true }],
        ['w0', wire()],
        ['button', { kind: 'button', active: true }],
        ['off', { kind: 'button', active: false }],
      ])

      const sources = sourcesOf(board, emptyPowerMap)
      expect([...sources.keys()].sort()).toStrictEqual(['button', 'lever'])
      expect(powerAt(sources, 'lever')).toBe(MAX_POWER_LEVEL)
    }),
  )

  it.effect('a component with no `active` field is not a source, so an unset lever is off', () =>
    Effect.sync(() => {
      const board = line([['lever', { kind: 'lever' }]])
      expect(sourcesOf(board, emptyPowerMap).size).toBe(0)
    }),
  )
})
