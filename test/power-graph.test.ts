/**
 * Circuit scenario tests: fixture circuit in, expected power out.
 *
 * This is the verification shape plan.md §3.12 asks for
 * (「回路シナリオテスト(fixture回路→期待状態)」). Each fixture is a literal, which
 * is only possible because `domain/power-graph.ts` takes adjacency as data
 * rather than deriving it from world geometry.
 *
 * ---------------------------------------------------------------------------
 * What the circuit-board preview taught this file
 * ---------------------------------------------------------------------------
 *
 * `pnpm preview --stats` found seven defects that twenty-one tests here did not.
 * The reason is worth writing down, because it is a property of how these tests
 * were written rather than of how many there were: **a test that asserts a final
 * state cannot see a circuit that is right for the wrong reason.** A repeater
 * that feeds itself settles ON, and ON is what the assertion expected; what was
 * wrong was the state after the lever went OFF, and nothing asked for it. The
 * same goes for the cell on the repeater's flank (nobody looked there), the
 * second lamp in a row (nobody placed one) and the tick a chain of sixteen
 * elements needs (nobody built one that long).
 *
 * So the sections below are deliberately shaped against that: switch the source
 * OFF and keep ticking, place a cell where nothing should reach, and assert a
 * settle bound as a PROPERTY of the board rather than as the number this board
 * happens to produce. A `--stats` line is not a pin — the report measures at run
 * time and records no expectation, so a fix makes the finding vanish silently.
 * These assertions are the pin.
 */
import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import {
  drivenPowerAt,
  emptyPowerMap,
  isLit,
  isPowered,
  MAX_POWER_LEVEL,
  powerAt,
  propagateTick,
  settle,
  settleTickLimitFor,
  sourcesOf,
  type CircuitBoard,
  type Component,
} from '../src/domain/power-graph'

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

/**
 * A board with an explicit, undirected edge list.
 *
 * `line` covers a straight run; anything with a branch — which is what a
 * repeater's flank IS — needs the edges named. Both directions are inserted from
 * one entry, because `CircuitBoard.adjacency` is undirected and a fixture that
 * accidentally wrote only one direction would test the wrong graph.
 */
const graph = (
  cells: ReadonlyArray<readonly [string, Component]>,
  edges: ReadonlyArray<readonly [string, string]>,
): CircuitBoard => {
  const adjacency = new Map<string, Array<string>>(cells.map(([key]) => [key, []]))
  for (const [from, to] of edges) {
    adjacency.get(from)?.push(to)
    adjacency.get(to)?.push(from)
  }
  return { components: new Map(cells), adjacency }
}

const wire = (): Component => ({ kind: 'wire' })

describe('wire propagation', () => {
  it.effect('a lever applies 15 to adjacent dust, which loses one per further cell', () =>
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
      expect(powerAt(power, 'w0')).toBe(15)
      expect(powerAt(power, 'w1')).toBe(14)
      expect(powerAt(power, 'w2')).toBe(13)
      expect(powerAt(power, 'w3')).toBe(12)
    }),
  )

  it.effect('REGRESSION: a signal crosses FIFTEEN wire cells and stops before the sixteenth', () =>
    Effect.sync(() => {
      // A source applies its full level to adjacent dust. Each dust cell then
      // loses one level while forwarding, so the fifteenth dust cell carries 1
      // and cannot power the sixteenth.
      const cells: Array<readonly [string, Component]> = [
        ['lever', { kind: 'lever', active: true }],
      ]
      for (let index = 0; index < 20; index += 1) {
        cells.push([`w${String(index)}`, wire()])
      }

      const board = line(cells)
      const power = propagateTick(board, emptyPowerMap)

      const carrying = Array.from({ length: 20 }, (_, index) =>
        powerAt(power, `w${String(index)}`),
      ).filter((level) => level > 0)
      expect(carrying).toHaveLength(MAX_POWER_LEVEL)

      // …and it is a contiguous run ending at 1, not fifteen cells with a hole.
      expect(powerAt(power, 'w0')).toBe(MAX_POWER_LEVEL)
      expect(powerAt(power, 'w14')).toBe(1)
      expect(powerAt(power, 'w15')).toBe(0)
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
      expect(powerAt(power, 'w0')).toBe(15)
      expect(powerAt(power, 'w1')).toBe(14)
      expect(powerAt(power, 'w2')).toBe(15)
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

  it.effect('REGRESSION: a lit lamp does not light the lamp behind it — litness stops where power stops', () =>
    Effect.sync(() => {
      // `propagateTick` was never wrong here: a lamp is not in CONDUCTS_POWER,
      // so lamps 1 and 2 hold 0. `isLit` asked whether any NEIGHBOUR carried
      // power, and a lit lamp carries its own decayed level, so litness reached
      // exactly one lamp further than power did — the two-lamps-both-light bug.
      // Three lamps rather than two: with two, "the second is dark" is also what
      // a rule that lights nothing at all would say.
      const board = line([
        ['lever', { kind: 'lever', active: true }],
        ['w0', wire()],
        ['lampA', { kind: 'lamp' }],
        ['lampB', { kind: 'lamp' }],
        ['lampC', { kind: 'lamp' }],
      ])

      const power = propagateTick(board, emptyPowerMap)

      expect(isLit(board, power, 'lampA')).toBe(true)
      expect(powerAt(power, 'lampA')).toBeGreaterThan(0)

      expect(isLit(board, power, 'lampB')).toBe(false)
      expect(isLit(board, power, 'lampC')).toBe(false)
    }),
  )

  it.effect('a lamp beside the LAST wire of a run is lit, though its own power entry is 0', () =>
    Effect.sync(() => {
      // Why `isLit` is not simply "my own level > 0", which would be shorter and
      // would pass the test above. A wire at level 1 has nothing left to hand on
      // (`outgoing` is 0), so the lamp's own entry stays 0 — and in vanilla that
      // lamp is lit. The rule is "a cell that DRIVES me carries power", and the
      // driving cell here carries 1.
      const cells: Array<readonly [string, Component]> = [
        ['lever', { kind: 'lever', active: true }],
      ]
      for (let index = 0; index < 15; index += 1) {
        cells.push([`w${String(index)}`, wire()])
      }
      cells.push(['lamp', { kind: 'lamp' }])

      const board = line(cells)
      const power = propagateTick(board, emptyPowerMap)

      expect(powerAt(power, 'w14')).toBe(1)
      expect(powerAt(power, 'lamp')).toBe(0)
      expect(isLit(board, power, 'lamp')).toBe(true)
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
      expect(powerAt(power, 'out')).toBe(15)
    }),
  )

  it.effect('REGRESSION: the torch reads the PREVIOUS tick, so inversion takes one tick rather than being instant', () =>
    Effect.sync(() => {
      const board = torchBoard(true)

      // Tick 1: the torch still sees last tick's (empty) power map, so it is
      // still burning even though its base is now powered.
      const first = propagateTick(board, emptyPowerMap)
      expect(powerAt(first, 'base')).toBe(15)
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
      expect(powerAt(power.power, 'w0')).toBe(15)
    }),
  )

  it.effect('REGRESSION: a torch does not power the cell it inverts, so an inverter is steady rather than a 2-tick blinker', () =>
    Effect.sync(() => {
      // The repeater's defect, in the other component that reads a cell, and it
      // was in the preview's own `torch-inverter` scenario the whole time:
      // "the lamp is LIT with the lever off — that is the inversion, and it is
      // correct" was false from tick 2 onward. With the lever off the torch
      // burns, drove its own support wire to 14, saw a powered input on the next
      // tick and went out, then came back — a NOT gate that blinked at 5 Hz.
      //
      // docs/testing.md §7 lists 「トーチは支持セルを電源にしない」 among the rules
      // the reference implementation already settled, so this is not a new
      // opinion; it is one that had not been written into the graph.
      const board = line([
        ['lever', { kind: 'lever', active: false }],
        ['base', wire()],
        ['torch', { kind: 'torch', invertedBy: 'base' }],
        ['out', wire()],
      ])

      let power = emptyPowerMap
      for (let tick = 0; tick < 20; tick += 1) {
        power = propagateTick(board, power)
        expect(powerAt(power, 'torch')).toBe(MAX_POWER_LEVEL)
        expect(powerAt(power, 'out')).toBe(15)
        // The support cell is the lever's business, and the lever is off.
        expect(powerAt(power, 'base')).toBe(0)
      }

      expect(settle(board).oscillating).toBe(false)
    }),
  )
})

describe('repeaters — a diode, which means both ends are named', () => {
  /**
   * lever — w0 — w1 — repeater — out0 — out1, plus a stub on the repeater's side.
   *
   * The stub touches the repeater and nothing else. In vanilla it stays dark
   * whatever the repeater does, and it is here in every fixture below because
   * "the output is right" and "only the output is right" are different claims.
   */
  const diodeBoard = (leverActive: boolean): CircuitBoard =>
    graph(
      [
        ['lever', { kind: 'lever', active: leverActive }],
        ['w0', wire()],
        ['w1', wire()],
        ['repeater', { kind: 'repeater', inputFrom: 'w1', outputTo: 'out0' }],
        ['out0', wire()],
        ['out1', wire()],
        ['flank', wire()],
      ],
      [
        ['lever', 'w0'],
        ['w0', 'w1'],
        ['w1', 'repeater'],
        ['repeater', 'out0'],
        ['out0', 'out1'],
        ['repeater', 'flank'],
      ],
    )

  it.effect('a repeater restores full power, so a signal travels further than one wire run reaches', () =>
    Effect.sync(() => {
      const board = line([
        ['lever', { kind: 'lever', active: true }],
        ['w0', wire()],
        ['w1', wire()],
        ['repeater', { kind: 'repeater', inputFrom: 'w1', outputTo: 'w2' }],
        ['w2', wire()],
      ])

      // Tick 1 energises the wire; tick 2 lets the repeater see it.
      const settled = settle(board)
      expect(settled.oscillating).toBe(false)
      expect(powerAt(settled.power, 'repeater')).toBe(MAX_POWER_LEVEL)
      expect(powerAt(settled.power, 'w2')).toBe(15)
    }),
  )

  it.effect('a repeater with an unpowered input outputs nothing', () =>
    Effect.sync(() => {
      const board = line([
        ['w0', wire()],
        ['repeater', { kind: 'repeater', inputFrom: 'w0', outputTo: 'w1' }],
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
        ['repeater', { kind: 'repeater', outputTo: 'w0' }],
        ['w0', wire()],
      ])
      expect(settle(board).power.size).toBe(0)
    }),
  )

  it.effect('REGRESSION: switch the lever OFF and a repeater lets go — it does not latch itself on forever', () =>
    Effect.sync(() => {
      // The defect this replaces: `propagateTick` pushed a source's power to
      // EVERY neighbour, so the repeater lifted `w1` — the cell it reads as its
      // input — with its own output, and `sourcesOf` re-fired it from itself on
      // the next tick. ANY circuit containing a repeater could never be switched
      // off. Twenty-one tests did not see it, because all of them asserted a
      // state with the source still ON, and that state was correct.
      const on = diodeBoard(true)
      let power = emptyPowerMap
      for (let tick = 0; tick < 4; tick += 1) {
        power = propagateTick(on, power)
      }
      expect(powerAt(power, 'repeater')).toBe(MAX_POWER_LEVEL)
      expect(powerAt(power, 'out0')).toBe(15)

      // Now the player throws the lever back. Nothing on the board generates.
      const off = diodeBoard(false)
      power = propagateTick(off, power)
      power = propagateTick(off, power)
      expect(powerAt(power, 'out0')).toBe(0)

      // …and it stays gone. Twenty more ticks, the whole map empty.
      for (let tick = 0; tick < 20; tick += 1) {
        power = propagateTick(off, power)
      }
      expect(power.size).toBe(0)
    }),
  )

  it.effect('REGRESSION: a repeater does not power its own input cell — the wire behind it stays the lever’s level', () =>
    Effect.sync(() => {
      // The mechanism of the latch above, asserted directly so that the two
      // cannot be fixed apart. `w1` is two conducting steps from the lever, so
      // it is 14. A repeater must not feed its own full output back through the
      // input, which would lift the cell above what the lever can deliver there.
      let power = emptyPowerMap
      const board = diodeBoard(true)
      for (let tick = 0; tick < 4; tick += 1) {
        power = propagateTick(board, power)
      }

      expect(powerAt(power, 'repeater')).toBe(MAX_POWER_LEVEL)
      expect(powerAt(power, 'w1')).toBe(14)
    }),
  )

  it.effect('REGRESSION: a repeater powers nothing on its flanks, so it cannot weld two circuits together', () =>
    Effect.sync(() => {
      // A repeater is the component players place specifically to ISOLATE two
      // circuits, so this is the failure the `CONDUCTS_POWER` comment warns
      // about occurring in the one component chosen to prevent it. The stub sits
      // at 14 under a rule that pushes to all four neighbours.
      let power = emptyPowerMap
      const board = diodeBoard(true)
      for (let tick = 0; tick < 4; tick += 1) {
        power = propagateTick(board, power)
      }

      expect(powerAt(power, 'repeater')).toBe(MAX_POWER_LEVEL)
      expect(powerAt(power, 'out0')).toBe(15)
      expect(powerAt(power, 'flank')).toBe(0)

      // A lamp on the flank is dark too: `isLit` and the sweep read the same
      // rule, so the accessor cannot leak what the sweep refused.
      const withLamp = graph(
        [
          ['lever', { kind: 'lever', active: true }],
          ['w0', wire()],
          ['repeater', { kind: 'repeater', inputFrom: 'w0', outputTo: 'out' }],
          ['out', wire()],
          ['sideLamp', { kind: 'lamp' }],
        ],
        [
          ['lever', 'w0'],
          ['w0', 'repeater'],
          ['repeater', 'out'],
          ['repeater', 'sideLamp'],
        ],
      )
      expect(isLit(withLamp, settle(withLamp).power, 'sideLamp')).toBe(false)
    }),
  )

  it.effect('a repeater with no output named drives nothing — an unwired repeater is inert in both directions', () =>
    Effect.sync(() => {
      // The chosen default for the new field, and the reason it was chosen: a
      // repeater the player has just dropped in front of empty space does
      // nothing, rather than powering everything it touches. The failure it
      // prevents (two circuits silently welded) is invisible; the failure it
      // causes (a repeater that does nothing) is on screen at the next tick.
      const board = line([
        ['lever', { kind: 'lever', active: true }],
        ['w0', wire()],
        ['repeater', { kind: 'repeater', inputFrom: 'w0' }],
        ['w1', wire()],
      ])

      const settled = settle(board)
      expect(powerAt(settled.power, 'repeater')).toBe(MAX_POWER_LEVEL)
      expect(powerAt(settled.power, 'w1')).toBe(0)
    }),
  )

  it.effect('a named output that is not a declared edge drives nothing — adjacency is still the graph', () =>
    Effect.sync(() => {
      // `outputTo` SELECTS one of this component's edges; it does not create
      // one. Otherwise a caller could teleport power across the board by naming
      // a distant cell, and a repeater whose output was deleted would keep
      // powering a coordinate that is no longer there.
      const board = graph(
        [
          ['lever', { kind: 'lever', active: true }],
          ['w0', wire()],
          ['repeater', { kind: 'repeater', inputFrom: 'w0', outputTo: 'faraway' }],
          ['out', wire()],
          ['faraway', wire()],
        ],
        [
          ['lever', 'w0'],
          ['w0', 'repeater'],
          ['repeater', 'out'],
        ],
      )

      const settled = settle(board)
      expect(powerAt(settled.power, 'repeater')).toBe(MAX_POWER_LEVEL)
      expect(powerAt(settled.power, 'out')).toBe(0)
      expect(powerAt(settled.power, 'faraway')).toBe(0)
    }),
  )

  it.effect('REGRESSION: `Component` carries no delay field, and every repeater costs exactly one tick', () =>
    Effect.sync(() => {
      // `delayTicks?: number` used to sit on `Component`. It was accepted,
      // stored and never read: a repeater set to 1, 2, 3 or 4 delivered on the
      // same tick, because `sourcesOf` only asks whether the input carries
      // power. It is absent now rather than silently doing nothing.
      //
      // Honouring it needs the input from N ticks ago, and `propagateTick` is by
      // design a pure function of (board, previous power map) — one tick of
      // history. That is a change to the tick's STATE SHAPE, not to this record,
      // so the field returns with the mechanism and not before.
      //
      // The compile-time half of the pin: the excess-property check rejects the
      // literal today, and if `delayTicks` ever comes back the `@ts-expect-error`
      // goes unused and `pnpm typecheck` fails.
      // @ts-expect-error `delayTicks` is deliberately not part of `Component`.
      const unmodelled: Component = { kind: 'repeater', delayTicks: 4 }
      expect(unmodelled.kind).toBe('repeater')

      // The behavioural half: N repeaters in series cost exactly N ticks, and
      // there is no way to ask any of them for more.
      const chain = (length: number): CircuitBoard =>
        line([
          ['lever', { kind: 'lever', active: true }],
          ...Array.from(
            { length },
            (_, index) =>
              [
                `r${String(index)}`,
                {
                  kind: 'repeater',
                  inputFrom: index === 0 ? 'lever' : `r${String(index - 1)}`,
                  outputTo: index === length - 1 ? 'out' : `r${String(index + 1)}`,
                },
              ] as const,
          ),
          ['out', wire()],
        ])

      for (const length of [1, 2, 5]) {
        expect(settle(chain(length))).toMatchObject({
          oscillating: false,
          ticks: length + 2,
        })
      }
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
      expect(result.ticks).toBe(settleTickLimitFor(board))
    }),
  )

  it.effect('REGRESSION: the settle bound counts DELAY ELEMENTS, not wire cells, so no acyclic circuit is called a clock', () =>
    Effect.sync(() => {
      // The bound used to be the constant `MAX_POWER_LEVEL + 2 = 17`, justified
      // as "two more than the longest possible wire run is enough for every
      // acyclic circuit". That sentence bounds the wrong quantity: a whole wire
      // run resolves inside ONE `propagateTick`, and what costs a tick is
      // reading `previous` — which only a torch and a repeater do. From sixteen
      // sequential elements up, `settle` reported `oscillating: true` for
      // perfectly stable circuits (20 elements -> 22 ticks, 24 -> 26).
      //
      // Asserted as the PROPERTY rather than as the number, because the number
      // is what went stale: the point is not that the limit is 18 for sixteen
      // repeaters, it is that an acyclic circuit is never called oscillating and
      // the bound tracks the quantity that actually bounds it.
      const chain = (length: number): CircuitBoard =>
        line([
          ['lever', { kind: 'lever', active: true }],
          ...Array.from(
            { length },
            (_, index) =>
              [
                `r${String(index)}`,
                {
                  kind: 'repeater',
                  inputFrom: index === 0 ? 'lever' : `r${String(index - 1)}`,
                  outputTo: index === length - 1 ? 'out' : `r${String(index + 1)}`,
                },
              ] as const,
          ),
          ['out', wire()],
        ])

      // 16 is where the old constant broke; 24 is well past it; 2 is a length
      // where it never broke, so a bound that only grew for long boards would
      // still be caught.
      for (const length of [2, 15, 16, 24]) {
        const board = chain(length)
        const bounded = settle(board)
        const generous = settle(board, { limit: 4096 })

        expect(bounded.oscillating).toBe(false)
        // The default answer and a limit nothing can reach must agree. When they
        // disagree, the bound is too small — that disagreement IS the defect.
        expect(bounded.ticks).toBe(generous.ticks)
        expect(bounded.ticks).toBeLessThanOrEqual(settleTickLimitFor(board))
      }
    }),
  )

  it.effect('the bound is one tick per delay element plus two, and wire length does not enter it', () =>
    Effect.sync(() => {
      // The two halves of "settling is bounded by sequential delay, not by
      // decay distance", each asserted where the other cannot reach.
      const wires = (length: number): CircuitBoard =>
        line([
          ['lever', { kind: 'lever', active: true }],
          ...Array.from({ length }, (_, index) => [`w${String(index)}`, wire()] as const),
        ])

      // Forty wire cells — nearly three times the reach of a run — and the bound
      // is still 2, because the sweep is a BFS over the whole board.
      expect(settleTickLimitFor(wires(40))).toBe(2)
      expect(settle(wires(40))).toMatchObject({ oscillating: false, ticks: 2 })

      // A torch counts exactly as much as a repeater: both read `previous`.
      const mixed = line([
        ['torch', { kind: 'torch' }],
        ['w0', wire()],
        ['repeater', { kind: 'repeater', inputFrom: 'w0', outputTo: 'w1' }],
        ['w1', wire()],
      ])
      expect(settleTickLimitFor(mixed)).toBe(4)

      // A lamp is not a delay element, and neither is a lever.
      const undelayed = line([
        ['lever', { kind: 'lever', active: true }],
        ['w0', wire()],
        ['lamp', { kind: 'lamp' }],
      ])
      expect(settleTickLimitFor(undelayed)).toBe(2)
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
      expect(powerAt(resumed.power, 'w0')).toBe(15)
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
      expect(powerAt(result.power, 'w0')).toBe(15)
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

describe('buttons — the pulse is the caller’s, and this names the current behaviour', () => {
  it.effect('a pressed button is a source for as long as the board says it is pressed, and the graph never releases it', () =>
    Effect.sync(() => {
      // NOT A FIX — a recorded decision, written as a test so that fixing it
      // elsewhere is visible here rather than silent.
      //
      // In vanilla a stone button pops out after 10 redstone ticks and a wooden
      // one after 15; that pulse is what separates a button from a small lever,
      // and every monostable circuit depends on it. Sixty ticks later this one
      // is still down.
      //
      // Release does not belong in this file. A pulse is REMAINING TIME, which
      // is state: the power map has no cell for it, and the board is an input
      // this module may not rewrite (「There is NO world mutation」, the header).
      // Counting it here means inventing a second state shape — the same one
      // repeater delay needs. And `active` is a statement by whoever owns the
      // world (the preview's grid today, mc-worldgen's chunks later) about the
      // world right now: a lever's is cleared by the player, a button's by TIME,
      // and the thing that knows redstone time is passing is
      // `stages/registration.ts`, which converts dt into ticks and already holds
      // the board `Ref`. Release goes there, beside the tick counter.
      //
      // When it does, this test fails and is rewritten to assert the pulse
      // length. That is the intended outcome; what is not intended is the pulse
      // quietly appearing with nothing recording that it used to be absent.
      const board = line([
        ['button', { kind: 'button', active: true }],
        ['w0', wire()],
      ])

      let power = emptyPowerMap
      for (let tick = 0; tick < 60; tick += 1) {
        power = propagateTick(board, power)
      }

      expect(powerAt(power, 'button')).toBe(MAX_POWER_LEVEL)
      expect(powerAt(power, 'w0')).toBe(15)
      expect(settle(board).oscillating).toBe(false)
    }),
  )

  it.effect('a released button stops being a source on the very next tick, with no tail', () =>
    Effect.sync(() => {
      // The other half of the decision: the graph adds no latency of its own, so
      // whoever implements release only has to flip `active` and the power is
      // gone one tick later. That is what makes the caller the right place.
      const pressed = line([
        ['button', { kind: 'button', active: true }],
        ['w0', wire()],
      ])
      const released = line([
        ['button', { kind: 'button', active: false }],
        ['w0', wire()],
      ])

      const held = propagateTick(pressed, emptyPowerMap)
      expect(powerAt(held, 'w0')).toBe(15)

      expect(propagateTick(released, held).size).toBe(0)
    }),
  )
})

describe('comparators — the only component whose output is a NUMBER', () => {
  /**
   * lever - w0 - comparator - out, with two stubs on the comparator's sides.
   *
   * The sides are wires so that a scenario can energise them; `sideInputs` names
   * them so the comparator reads them. The flank stubs double as the check that
   * a comparator drives nothing sideways, which is the same claim the repeater
   * fixture above makes and a worse failure here — see the latch test below.
   */
  const comparatorBoard = (options: {
    readonly mode?: 'compare' | 'subtract'
    readonly sideSources?: ReadonlyArray<readonly [string, Component]>
    readonly containerSignal?: number
  } = {}): CircuitBoard =>
    graph(
      [
        ['lever', { kind: 'lever', active: true }],
        ['w0', wire()],
        [
          'comparator',
          {
            kind: 'comparator',
            inputFrom: 'w0',
            outputTo: 'out',
            sideInputs: ['sideA', 'sideB'],
            ...(options.mode === undefined ? {} : { mode: options.mode }),
            ...(options.containerSignal === undefined
              ? {}
              : { containerSignal: options.containerSignal }),
          },
        ],
        ['out', wire()],
        ['sideA', wire()],
        ['sideB', wire()],
        ...(options.sideSources ?? []),
      ],
      [
        ['lever', 'w0'],
        ['w0', 'comparator'],
        ['comparator', 'out'],
        ['comparator', 'sideA'],
        ['comparator', 'sideB'],
        ...(options.sideSources ?? []).map(([key]) => ['sideA', key] as const),
      ],
    )

  it.effect('a comparator emits the LEVEL it read, not full power — the first variable-strength source', () =>
    Effect.sync(() => {
      // Every other source in the model emits MAX_POWER_LEVEL. This is the one
      // that does arithmetic, and `sourcesOf` had to learn to seed a source at
      // something other than 15 for it.
      const settled = settle(comparatorBoard({ containerSignal: 7 }))

      expect(settled.oscillating).toBe(false)
      expect(powerAt(settled.power, 'w0')).toBe(15)
      expect(powerAt(settled.power, 'comparator')).toBe(7)
      expect(powerAt(settled.power, 'comparator')).not.toBe(MAX_POWER_LEVEL)
    }),
  )

  it.effect('compare mode holds the rear back while a side matches or beats it', () =>
    Effect.sync(() => {
      // The side is fed by its own lever two steps away, so it carries 13 — one
      // less than the rear's 14 — and the comparator passes. Raise the side to
      // touch the lever directly and it wins.
      const passing = settle(
        comparatorBoard({ sideSources: [['sideLever', { kind: 'lever', active: true }]] }),
      )
      expect(powerAt(passing.power, 'sideA')).toBe(15)
      // 14 against 14: compare mode passes on equality.
      expect(powerAt(passing.power, 'comparator')).toBe(15)

      const blocked = settle(
        graph(
          [
            ['lever', { kind: 'lever', active: true }],
            ['w0', wire()],
            ['w1', wire()],
            ['comparator', { kind: 'comparator', inputFrom: 'w1', outputTo: 'out', sideInputs: ['sideA'] }],
            ['out', wire()],
            ['sideA', wire()],
            ['sideLever', { kind: 'lever', active: true }],
          ],
          [
            ['lever', 'w0'],
            ['w0', 'w1'],
            ['w1', 'comparator'],
            ['comparator', 'out'],
            ['comparator', 'sideA'],
            ['sideA', 'sideLever'],
          ],
        ),
      )
      // Rear is 14 (two dust cells from the lever); the side is 15. Compare refuses.
      expect(powerAt(blocked.power, 'w1')).toBe(14)
      expect(powerAt(blocked.power, 'sideA')).toBe(15)
      expect(powerAt(blocked.power, 'comparator')).toBe(0)
      expect(powerAt(blocked.power, 'out')).toBe(0)
    }),
  )

  it.effect('subtract mode takes the side off the rear', () =>
    Effect.sync(() => {
      const board = graph(
        [
          ['lever', { kind: 'lever', active: true }],
          ['w0', wire()],
          ['comparator', { kind: 'comparator', mode: 'subtract', inputFrom: 'w0', outputTo: 'out', sideInputs: ['s3'] }],
          ['out', wire()],
          // A four-cell run off a second lever, so the side arrives at 11.
          ['sideLever', { kind: 'lever', active: true }],
          ['s0', wire()],
          ['s1', wire()],
          ['s2', wire()],
          ['s3', wire()],
        ],
        [
          ['lever', 'w0'],
          ['w0', 'comparator'],
          ['comparator', 'out'],
          ['sideLever', 's0'],
          ['s0', 's1'],
          ['s1', 's2'],
          ['s2', 's3'],
          ['s3', 'comparator'],
        ],
      )

      const settled = settle(board)
      expect(powerAt(settled.power, 'w0')).toBe(15)
      // Four dust cells from the side lever, so 12.
      expect(powerAt(settled.power, 's3')).toBe(12)
      expect(powerAt(settled.power, 'comparator')).toBe(15 - 12)
      expect(powerAt(settled.power, 'out')).toBe(3)
    }),
  )

  it.effect('REGRESSION: a comparator drives only `outputTo` — it does not power its own rear or its sides', () =>
    Effect.sync(() => {
      // The repeater's latch (DN-RS-12) in the component where it would be
      // worse. A comparator that drove its own sides would read its own output
      // as a side signal, and in compare mode side-equals-rear emits 0 — so it
      // would switch itself off, then on, then off: a two-tick blinker built out
      // of the component players place to hold a value STILL.
      const board = comparatorBoard()
      let power = emptyPowerMap
      for (let tick = 0; tick < 6; tick += 1) {
        power = propagateTick(board, power)
      }

      expect(powerAt(power, 'comparator')).toBe(15)
      expect(powerAt(power, 'out')).toBe(15)
      // The rear stays the lever's level, not lifted by the comparator's output.
      expect(powerAt(power, 'w0')).toBe(15)
      expect(powerAt(power, 'sideA')).toBe(0)
      expect(powerAt(power, 'sideB')).toBe(0)

      // …and it lets go. Nothing on the board generates once the lever is off.
      const off = graph(
        [
          ['lever', { kind: 'lever', active: false }],
          ['w0', wire()],
          ['comparator', { kind: 'comparator', inputFrom: 'w0', outputTo: 'out', sideInputs: ['sideA'] }],
          ['out', wire()],
          ['sideA', wire()],
        ],
        [
          ['lever', 'w0'],
          ['w0', 'comparator'],
          ['comparator', 'out'],
          ['comparator', 'sideA'],
        ],
      )
      for (let tick = 0; tick < 20; tick += 1) {
        power = propagateTick(off, power)
      }
      expect(power.size).toBe(0)
    }),
  )

  it.effect('a comparator with no output named drives nothing, exactly as a repeater does', () =>
    Effect.sync(() => {
      const board = line([
        ['lever', { kind: 'lever', active: true }],
        ['w0', wire()],
        ['comparator', { kind: 'comparator', inputFrom: 'w0' }],
        ['w1', wire()],
      ])

      const settled = settle(board)
      expect(powerAt(settled.power, 'comparator')).toBe(15)
      expect(powerAt(settled.power, 'w1')).toBe(0)
    }),
  )

  it.effect('a comparator with NEITHER a container reading NOR `inputFrom` reads a rear of 0 — an edge is not a rear', () =>
    Effect.sync(() => {
      // The mirror of the `sideInputs` claim below: a NAMED side is read
      // without an edge, and an UNNAMED rear is not read even with one. Both
      // follow from the same rule — `adjacency` bounds where power FLOWS, and
      // what a comparator LOOKS AT is named on the component.
      //
      // It matters because it is the state a comparator is in the instant a
      // player places it, before anything has been attached behind it. If
      // touching a live wire were enough to feed the rear, every comparator
      // dropped beside a powered line would fire on placement, and the
      // `containerSignal` contract above — the reading REPLACES the rear —
      // would have nothing to replace.
      const board = line([
        ['lever', { kind: 'lever', active: true }],
        ['w0', wire()],
        ['comparator', { kind: 'comparator', outputTo: 'out' }],
        ['out', wire()],
      ])

      const settled = settle(board)
      // The wire behind it is live, so the board really does have power to
      // offer; the comparator simply is not asking for it.
      expect(powerAt(settled.power, 'w0')).toBe(15)
      expect(powerAt(settled.power, 'comparator')).toBe(0)
      expect(powerAt(settled.power, 'out')).toBe(0)
    }),
  )

  it.effect('REGRESSION: `containerSignal` REPLACES the rear reading rather than adding to it', () =>
    Effect.sync(() => {
      // In the world the cell behind a comparator holds either a container or a
      // wire, never both, and a rule that took the maximum would let a player
      // wire past an empty chest and read a full one.
      const empty = settle(comparatorBoard({ containerSignal: 0 }))
      expect(powerAt(empty.power, 'w0')).toBe(15)
      expect(powerAt(empty.power, 'comparator')).toBe(0)

      const stocked = settle(comparatorBoard({ containerSignal: 7 }))
      expect(powerAt(stocked.power, 'comparator')).toBe(7)
      expect(powerAt(stocked.power, 'out')).toBe(7)
    }),
  )

  it.effect('the sides are READ without an edge, the same way `inputFrom` and `invertedBy` are', () =>
    Effect.sync(() => {
      // `adjacency` bounds where power FLOWS. What a component may look at has
      // never been bounded by it — `sourcesOf` reads `previous` at `invertedBy`
      // directly and always has. A side named but not adjacent still gates the
      // comparator, which is what lets a caller model a placement this
      // geometry-free graph cannot otherwise express.
      const board = graph(
        [
          ['lever', { kind: 'lever', active: true }],
          ['w0', wire()],
          ['comparator', { kind: 'comparator', inputFrom: 'w0', outputTo: 'out', sideInputs: ['detached'] }],
          ['out', wire()],
          ['detachedLever', { kind: 'lever', active: true }],
          ['detached', wire()],
        ],
        [
          ['lever', 'w0'],
          ['w0', 'comparator'],
          ['comparator', 'out'],
          ['detachedLever', 'detached'],
        ],
      )

      const settled = settle(board)
      expect(powerAt(settled.power, 'detached')).toBe(15)
      // Rear 14 against side 14: compare passes on equality, so the comparator
      // is on — and the point is that the side was read at all.
      expect(powerAt(settled.power, 'comparator')).toBe(15)

      const stronger = settle(
        graph(
          [
            ['lever', { kind: 'lever', active: true }],
            ['w0', wire()],
            ['w1', wire()],
            ['comparator', { kind: 'comparator', inputFrom: 'w1', outputTo: 'out', sideInputs: ['detachedLever'] }],
            ['out', wire()],
            ['detachedLever', { kind: 'lever', active: true }],
          ],
          [
            ['lever', 'w0'],
            ['w0', 'w1'],
            ['w1', 'comparator'],
            ['comparator', 'out'],
          ],
        ),
      )
      // Side is a lever at 15 and the rear is 13: refused, with no edge between
      // the comparator and the lever at all.
      expect(powerAt(stronger.power, 'comparator')).toBe(0)
    }),
  )

  it.effect('REGRESSION: a comparator is a DELAY ELEMENT, and the settle bound counts it', () =>
    Effect.sync(() => {
      // DN-RS-4 made the bound tight rather than generous so that adding a third
      // delayed component and forgetting `DELAYED_KINDS` would show up. This is
      // that day: a comparator reads `previous` at its rear and both sides, so a
      // chain costs one tick each, and a bound that had not learned about them
      // would call a perfectly stable comparator chain a clock.
      const chain = (length: number): CircuitBoard =>
        line([
          ['lever', { kind: 'lever', active: true }],
          ...Array.from(
            { length },
            (_, index) =>
              [
                `c${String(index)}`,
                {
                  kind: 'comparator',
                  inputFrom: index === 0 ? 'lever' : `c${String(index - 1)}`,
                  outputTo: index === length - 1 ? 'out' : `c${String(index + 1)}`,
                },
              ] as const,
          ),
          ['out', wire()],
        ])

      for (const length of [1, 2, 5, 16]) {
        const board = chain(length)
        expect(settleTickLimitFor(board)).toBe(length + 2)

        const bounded = settle(board)
        const generous = settle(board, { limit: 4096 })
        expect(bounded.oscillating).toBe(false)
        // The property, not the number: the default answer and a limit nothing
        // can reach must agree, exactly as the repeater-chain regression above
        // asserts it.
        expect(bounded.ticks).toBe(generous.ticks)
      }
    }),
  )

  it.effect('REGRESSION: comparator stages preserve the level they emit into adjacent dust', () =>
    Effect.sync(() => {
      // A comparator passes a numeric value rather than restoring full power.
      // Applying that value unchanged to its adjacent dust prevents equal
      // readings from changing merely because they crossed more comparators.
      const stages = (count: number): CircuitBoard =>
        line([
          ['lever', { kind: 'lever', active: true }],
          ...Array.from({ length: count }, (_, index) => [
            [`c${String(index)}`, {
              kind: 'comparator',
              inputFrom: index === 0 ? 'lever' : `d${String(index - 1)}`,
              outputTo: `d${String(index)}`,
            }] as const,
            [`d${String(index)}`, wire()] as const,
          ]).flat(),
        ])

      // The lever holds 15. Each stage is comparator + one dust: the comparator
      // reads the previous stage's dust and emits that level unchanged into the
      // dust immediately in front.
      const readings = [1, 2, 3, 4].map((count) => {
        const settled = settle(stages(count))
        expect(settled.oscillating).toBe(false)
        return powerAt(settled.power, `c${String(count - 1)}`)
      })

      expect(readings).toStrictEqual([15, 15, 15, 15])
      // In vanilla every entry above is 15.
    }),
  )
})

describe('observers — a source whose trigger is not a signal', () => {
  const observerBoard = (active: boolean): CircuitBoard =>
    graph(
      [
        ['observer', { kind: 'observer', active, outputTo: 'out' }],
        ['out', wire()],
        ['watched', wire()],
        ['flank', wire()],
      ],
      [
        ['observer', 'out'],
        ['observer', 'watched'],
        ['observer', 'flank'],
      ],
    )

  it.effect('a firing observer is a full-strength source, and a quiet one is nothing', () =>
    Effect.sync(() => {
      expect(powerAt(propagateTick(observerBoard(true), emptyPowerMap), 'observer')).toBe(
        MAX_POWER_LEVEL,
      )
      expect(propagateTick(observerBoard(false), emptyPowerMap).size).toBe(0)
    }),
  )

  it.effect('REGRESSION: an observer drives only `outputTo`, so it cannot pulse into the cell it watches', () =>
    Effect.sync(() => {
      // Vanilla's observer emits from its back face and watches forwards. An
      // omnidirectional one would pulse into the very block whose change it is
      // waiting for — the torch's support-cell failure (DN-RS-12) in a component
      // whose whole job is to notice that a cell changed.
      const power = settle(observerBoard(true)).power

      expect(powerAt(power, 'out')).toBe(15)
      expect(powerAt(power, 'watched')).toBe(0)
      expect(powerAt(power, 'flank')).toBe(0)
    }),
  )

  it.effect('an observer is NOT a delay element — its tick is spent outside the graph', () =>
    Effect.sync(() => {
      // A torch and a repeater cost a tick because they read `previous`. An
      // observer's memory is `domain/observer.ts`'s, held by the caller, so from
      // the graph's side it is exactly as instantaneous as a lever.
      const board = observerBoard(true)
      expect(settleTickLimitFor(board)).toBe(2)
      expect(settle(board)).toMatchObject({ oscillating: false, ticks: 2 })
    }),
  )

  it.effect('`Component` carries no `watching` field — the graph cannot read a block', () =>
    Effect.sync(() => {
      // The same pin `delayTicks` gets, for the same reason: a field the graph
      // stores and never reads is worse than an absent one. Which cell an
      // observer watches belongs beside the `active` flag it produces, in
      // whoever owns the world.
      // @ts-expect-error `watching` is deliberately not part of `Component`.
      const unmodelled: Component = { kind: 'observer', watching: 'somewhere' }
      expect(unmodelled.kind).toBe('observer')
    }),
  )
})

describe('pressure plates — a lever thrown by whoever stands on it', () => {
  it.effect('a pressed plate is a source exactly as a lever is', () =>
    Effect.sync(() => {
      const board = line([
        ['plate', { kind: 'pressure-plate', active: true }],
        ['w0', wire()],
      ])
      const power = propagateTick(board, emptyPowerMap)
      expect(powerAt(power, 'plate')).toBe(MAX_POWER_LEVEL)
      expect(powerAt(power, 'w0')).toBe(15)
    }),
  )

  it.effect('a plate drives every neighbour — it is a switch, not a diode', () =>
    Effect.sync(() => {
      const board = graph(
        [
          ['plate', { kind: 'pressure-plate', active: true }],
          ['north', wire()],
          ['south', wire()],
        ],
        [
          ['plate', 'north'],
          ['plate', 'south'],
        ],
      )
      const power = propagateTick(board, emptyPowerMap)
      expect(powerAt(power, 'north')).toBe(15)
      expect(powerAt(power, 'south')).toBe(15)
    }),
  )

  it.effect('REGRESSION: `emits` lets a weighted plate report a COUNT, and omitting it means full power', () =>
    Effect.sync(() => {
      // The field exists for exactly one component, and it is read for every
      // source uniformly — so there is no component for which setting it
      // silently does nothing, which is the shape `delayTicks` had.
      const weighed = line([
        ['plate', { kind: 'pressure-plate', active: true, emits: 4 }],
        ['w0', wire()],
        ['w1', wire()],
        ['w2', wire()],
        ['w3', wire()],
      ])
      const power = propagateTick(weighed, emptyPowerMap)
      expect(powerAt(power, 'plate')).toBe(4)
      expect(powerAt(power, 'w0')).toBe(4)
      expect(powerAt(power, 'w1')).toBe(3)
      expect(powerAt(power, 'w2')).toBe(2)
      expect(powerAt(power, 'w3')).toBe(1)

      const cutoff = line([
        ['plate', { kind: 'pressure-plate', active: true, emits: 4 }],
        ['w0', wire()],
        ['w1', wire()],
        ['w2', wire()],
        ['w3', wire()],
        ['w4', wire()],
      ])
      expect(powerAt(propagateTick(cutoff, emptyPowerMap), 'w4')).toBe(0)

      const plain = line([['plate', { kind: 'pressure-plate', active: true }], ['w0', wire()]])
      expect(powerAt(propagateTick(plain, emptyPowerMap), 'plate')).toBe(MAX_POWER_LEVEL)
    }),
  )

  it.effect('a plate reporting zero occupants is not a source at all', () =>
    Effect.sync(() => {
      // `emits: 0` and `active: false` mean the same thing to the board, which
      // is what lets a caller compute the level with `plateSignal` and set
      // `active` from the same number without a second rule about zero.
      const board = line([
        ['plate', { kind: 'pressure-plate', active: true, emits: 0 }],
        ['w0', wire()],
      ])
      expect(powerAt(propagateTick(board, emptyPowerMap), 'w0')).toBe(0)
    }),
  )
})

describe('hoppers and dispensers — actuators, which conduct nothing', () => {
  it.effect('REGRESSION: power stops dead at a hopper, so a filter cannot weld the line feeding it to the line beyond', () =>
    Effect.sync(() => {
      // The lamp's failure (DN-RS-5) in a component players deliberately put IN
      // a circuit. A hopper is in neither `RECEIVES_POWER` nor `CONDUCTS_POWER`,
      // which makes it exactly as transparent to power as an empty cell.
      for (const kind of ['hopper', 'dispenser'] as const) {
        const board = line([
          ['lever', { kind: 'lever', active: true }],
          ['w0', wire()],
          ['actuator', { kind }],
          ['w1', wire()],
          ['w2', wire()],
        ])

        const power = propagateTick(board, emptyPowerMap)
        expect(powerAt(power, 'w0')).toBe(15)
        expect(powerAt(power, 'actuator')).toBe(0)
        expect(powerAt(power, 'w1')).toBe(0)
        expect(powerAt(power, 'w2')).toBe(0)
      }
    }),
  )

  it.effect('REGRESSION: `isPowered` still says yes, though the actuator’s own entry is 0', () =>
    Effect.sync(() => {
      // The reason an actuator does not need to be in `RECEIVES_POWER` at all.
      // "Is power arriving here" is answered by asking which neighbours DRIVE
      // this cell — the same question, through the same `conductsInto`, that
      // `isLit` asks — rather than by reading a map entry that would be a
      // decayed level and, per DN-RS-5 §5-1, would leak one cell too far.
      const board = line([
        ['lever', { kind: 'lever', active: true }],
        ['w0', wire()],
        ['hopper', { kind: 'hopper' }],
        ['w1', wire()],
      ])

      const power = propagateTick(board, emptyPowerMap)
      expect(powerAt(power, 'hopper')).toBe(0)
      expect(isPowered(board, power, 'hopper')).toBe(true)
      expect(drivenPowerAt(board, power, 'hopper')).toBe(15)

      // The wire beyond it is driven by nothing, so it is not powered either.
      expect(isPowered(board, power, 'w1')).toBe(false)
    }),
  )

  it.effect('an actuator on a repeater’s flank is unpowered, because the repeater drives only its output', () =>
    Effect.sync(() => {
      // `drivenPowerAt` and the sweep share `conductsInto`, so the accessor
      // cannot leak what the sweep refused — the property DN-RS-5 §5-1 was
      // fixed to get, now carrying a second consumer.
      const board = graph(
        [
          ['lever', { kind: 'lever', active: true }],
          ['w0', wire()],
          ['repeater', { kind: 'repeater', inputFrom: 'w0', outputTo: 'out' }],
          ['out', wire()],
          ['sideDispenser', { kind: 'dispenser' }],
        ],
        [
          ['lever', 'w0'],
          ['w0', 'repeater'],
          ['repeater', 'out'],
          ['repeater', 'sideDispenser'],
        ],
      )

      const power = settle(board).power
      expect(powerAt(power, 'out')).toBe(15)
      expect(isPowered(board, power, 'sideDispenser')).toBe(false)
    }),
  )

  it.effect('`drivenPowerAt` is not `isLit`: a powered WIRE is driven but is not lit', () =>
    Effect.sync(() => {
      // The kind check in `isLit` is not redundant with the accessor. A caller
      // who dropped it would light every cell on the board.
      const board = line([
        ['lever', { kind: 'lever', active: true }],
        ['w0', wire()],
        ['w1', wire()],
      ])
      const power = propagateTick(board, emptyPowerMap)

      expect(drivenPowerAt(board, power, 'w1')).toBe(15)
      expect(isLit(board, power, 'w1')).toBe(false)
    }),
  )
})

/**
 * Oracles transcribed from the reference implementation (`takeokunn/ts-minecraft`).
 *
 * docs/porting.md §3 is the ledger of what was taken and what was declined, with
 * the reason for each. Every test below carries the reference's `path:line` so a
 * future reader can check the transcription rather than guess at it — the rule
 * docs/testing.md §3-2 states for anything that pins a design premise.
 *
 * These four are the claims the reference makes that this file did not already
 * make. They are NOT the reference's whole redstone suite: most of it is either
 * already pinned here in a different vocabulary, or is about geometry, inventory
 * and entities, which this repository does not have (DN-RS-17). The declines are
 * the interesting half and they are written down, per file, in porting.md §3-1.
 */
describe('ported oracles — claims taken from the reference implementation', () => {
  it.effect('REGRESSION: a lamp is not lit by power at its OWN cell, only by a cell that drives it', () =>
    Effect.sync(() => {
      // Ported from `packages/app/application/frame/stages/
      // redstone-lamp-world-effects.test.ts:75-87`, which is the reference's own
      // REGRESSION: "does NOT light from power at the lamp's own cell". Its fix
      // note reads 「Before the fix this read getPowerAt(lampPos)=15 and lit the
      // lamp」.
      //
      // This repository can reach the same state by a different route and so has
      // to make the same promise. A lamp IS in `RECEIVES_POWER`, so it holds a
      // decayed level of its own, and `isLit` is handed a power map by the
      // caller — the preview's step button passes one back in, and
      // `settle({ from })` accepts one wholesale. A map carrying an entry for a
      // lamp that nothing drives is therefore representable, and the accessor
      // must read the BOARD, not the entry.
      //
      // Distinct from the two lamp tests above: `a lit lamp does not light the
      // lamp behind it` fixes the leak between lamps (DN-RS-5 §5-1), and `a lamp
      // beside the LAST wire` fixes the opposite direction (own entry 0, still
      // lit). Neither one ever hands `isLit` an entry for an undriven lamp, so
      // neither sees an `|| powerAt(power, key) > 0` added to it.
      const board = line([
        ['w0', wire()],
        ['lamp', { kind: 'lamp' }],
      ])

      // Nothing on this board generates: the wire is dark and the lamp is dark.
      expect(propagateTick(board, emptyPowerMap).size).toBe(0)

      // Now assert against a map that says the lamp itself carries full power.
      const stale: ReadonlyMap<string, number> = new Map([['lamp', MAX_POWER_LEVEL]])
      expect(powerAt(stale, 'lamp')).toBe(MAX_POWER_LEVEL)
      expect(drivenPowerAt(board, stale, 'lamp')).toBe(0)
      expect(isLit(board, stale, 'lamp')).toBe(false)
      expect(isPowered(board, stale, 'lamp')).toBe(false)
    }),
  )

  it.effect('REGRESSION: a repeater is not turned on by power at its OUTPUT cell — a diode does not conduct backwards', () =>
    Effect.sync(() => {
      // Ported from `packages/entity/test/redstone/redstone-simulation.test.ts:
      // 423-433` — "does not activate from power at its own or front cell". The
      // reference powers both the repeater's cell and the cell it faces and
      // asserts `changed` is false.
      //
      // The forward half of the diode is pinned above (`a repeater does not
      // power its own input cell`, `powers nothing on its flanks`). This is the
      // BACKWARD half, and it is a different rule in a different function:
      // `conductsInto` decides where a repeater PUSHES, and `sourcesOf` decides
      // what it READS. A repeater that read its output would be turned on by the
      // circuit it was placed to isolate — power arriving at the front would
      // appear behind, which is the one thing a player uses a repeater to
      // prevent.
      //
      // Steady state, not a transient: the lever here is independent of the
      // repeater, so the front cell stays powered for as long as the test runs
      // and the repeater has to keep refusing it.
      const board = graph(
        [
          ['rear', wire()],
          ['repeater', { kind: 'repeater', inputFrom: 'rear', outputTo: 'front' }],
          ['front', wire()],
          ['lever', { kind: 'lever', active: true }],
        ],
        [
          ['rear', 'repeater'],
          ['repeater', 'front'],
          ['front', 'lever'],
        ],
      )

      const settled = settle(board)
      expect(settled.oscillating).toBe(false)
      expect(powerAt(settled.power, 'front')).toBe(15)
      expect(powerAt(settled.power, 'repeater')).toBe(0)
      expect(powerAt(settled.power, 'rear')).toBe(0)

      // The repeater never becomes a source, however long the front stays live.
      let power = emptyPowerMap
      for (let tick = 0; tick < 20; tick += 1) {
        power = propagateTick(board, power)
        expect(sourcesOf(board, power).has('repeater')).toBe(false)
        expect(powerAt(power, 'rear')).toBe(0)
      }
    }),
  )

  it.effect('REGRESSION: an adjacency row is DIRECTED — naming a cell does not let power arrive from it', () =>
    Effect.sync(() => {
      // The reference's `neighborsOf` is computed from the six faces of a voxel
      // and it proves its own symmetry: `packages/entity/test/redstone/
      // redstone-simulation.test.ts:99-107` — "is symmetric: if B is a neighbor
      // of A, A is a neighbor of B".
      //
      // This repository cannot make that claim and must not pretend to.
      // `adjacency` is supplied by the caller (`domain/power-graph.ts:23-27`:
      // the real adjacency belongs to mc-kernel's coordinate types), so symmetry
      // is the CALLER's invariant. Porting the claim means porting what happens
      // when it does not hold, because the answer is not obvious and every
      // fixture in this file is symmetric — `line` and `graph` both insert both
      // directions, so nothing here would notice a `neighboursOf` that quietly
      // symmetrised the map on the way past.
      //
      // The answer: power flows out of `adjacency[A]`, so an edge listed only in
      // A's row carries A to B and nothing back. Listing it only in B's row
      // carries nothing at all. A caller that draws its edge list once, in one
      // direction, gets a one-way board rather than a crash — which is the
      // failure mode worth naming, because a half-wired board looks wired.
      const forwards: CircuitBoard = {
        components: new Map<string, Component>([
          ['lever', { kind: 'lever', active: true }],
          ['w0', wire()],
        ]),
        adjacency: new Map([
          ['lever', ['w0']],
          ['w0', []],
        ]),
      }
      expect(powerAt(propagateTick(forwards, emptyPowerMap), 'w0')).toBe(15)

      // The same two cells, the same one edge, written from the other end.
      const backwards: CircuitBoard = {
        components: new Map<string, Component>([
          ['lever', { kind: 'lever', active: true }],
          ['w0', wire()],
        ]),
        adjacency: new Map([
          ['lever', []],
          ['w0', ['lever']],
        ]),
      }
      const power = propagateTick(backwards, emptyPowerMap)
      expect(powerAt(power, 'lever')).toBe(MAX_POWER_LEVEL)
      expect(powerAt(power, 'w0')).toBe(0)
    }),
  )

  it.effect('REGRESSION: a cell takes the STRONGEST level offered, not the one the sweep reached first', () =>
    Effect.sync(() => {
      // Ported from `packages/entity/test/redstone/redstone-simulation.test.ts:
      // 171-188` — "a wire reachable from two sources takes the MAX power". Its
      // comment states the claim exactly: 「not whichever BFS path reaches it
      // first — this exercises the `power <= currentKnown` max-guard, the core
      // of correct multi-source propagation」.
      //
      // The reference's own fixture is two LEVERS at opposite ends of a run, and
      // transcribing that fixture would carry the words and not the claim: with
      // two equal sources the sweep is level-synchronised, so first-writer-wins
      // and take-the-max agree at every cell and the guard is never asked a
      // question. `two sources feeding one wire give it the stronger of the two`
      // above is that fixture, and it passes with the guard deleted.
      //
      // Making the claim falsifiable needs sources of UNEQUAL strength at
      // UNEQUAL distance, which this repository can build and the reference
      // could not: `emits` (the weighted pressure plate, DN-RS-17) is the only
      // way to place a source at something other than 15, and the reference has
      // no weighted plate. So the port is the claim in this repository's own
      // vocabulary rather than the reference's fixture.
      //
      // The plate is NEAR and WEAK, the lever is FAR and STRONG. A sweep that
      // kept the first level written would hand `w3` the plate's 4 and lock the
      // lever's 11 out — a wire run that goes dark in the middle because
      // somebody stood on a plate at the far end.
      const cells: ReadonlyArray<readonly [string, Component]> = [
        ['lever', { kind: 'lever', active: true }],
        ['w0', wire()],
        ['w1', wire()],
        ['w2', wire()],
        ['w3', wire()],
        ['plate', { kind: 'pressure-plate', active: true, emits: 5 }],
      ]
      const edges: ReadonlyArray<readonly [string, string]> = [
        ['lever', 'w0'],
        ['w0', 'w1'],
        ['w1', 'w2'],
        ['w2', 'w3'],
        ['w3', 'plate'],
      ]

      const power = propagateTick(graph(cells, edges), emptyPowerMap)

      expect(powerAt(power, 'plate')).toBe(5)
      expect(powerAt(power, 'w0')).toBe(15)
      expect(powerAt(power, 'w1')).toBe(14)
      expect(powerAt(power, 'w2')).toBe(13)
      // The contested cell. The plate offers 4 and reaches it in one step; the
      // lever offers 11 and reaches it in five.
      expect(powerAt(power, 'w3')).toBe(12)

      // …and none of it depends on the order the caller built its Maps.
      //
      // The second half of the port, from the same file at :318-337 ("multiple
      // entries → deterministically sorted by numeric key", whose fixture
      // inserts in reverse 「Intentionally … to test sorting」) and from
      // `redstone-service.test.ts:149-164`. The reference buys determinism by
      // SORTING its readout; this repository has no readout to sort, so the
      // claim is made about the values. docs/testing.md §5 rests the scenario
      // tests on determinism and names three reasons it holds — fixed rate, no
      // wall clock, no seed — none of which is iteration order, and iteration
      // order is the one an mc-worldgen chunk walk will actually vary.
      const backwards = propagateTick(
        graph([...cells].reverse(), [...edges].reverse()),
        emptyPowerMap,
      )
      for (const [key] of cells) {
        expect(powerAt(backwards, key)).toBe(powerAt(power, key))
      }
      expect(backwards.size).toBe(power.size)
    }),
  )
})
