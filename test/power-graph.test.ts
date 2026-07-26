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
  emptyPowerMap,
  isLit,
  MAX_POWER_LEVEL,
  powerAt,
  propagateTick,
  settle,
  settleTickLimitFor,
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
  it.effect('a lever holds 15 and the wire beside it is already at 14, losing one per further cell', () =>
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

  it.effect('REGRESSION: a signal crosses FOURTEEN wire cells — the source occupies one of the fifteen levels', () =>
    Effect.sync(() => {
      // The number was written as fifteen in four comments, a design note, a
      // preview scenario and two test names, and it is fourteen: a source is a
      // cell of the power map like any other and every conducting step loses
      // one, so the first wire is already decayed.
      //
      // This diverges from vanilla, where the dust touching a lever is at 15 and
      // a run reaches fifteen cells. The divergence is RECORDED here rather than
      // fixed, because closing it means a source not decaying into its first
      // neighbour — a change to every level in every circuit above. This test is
      // what makes that change loud instead of quiet.
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
      expect(carrying).toHaveLength(MAX_POWER_LEVEL - 1)

      // …and it is a contiguous run ending at 1, not fifteen cells with a hole.
      expect(powerAt(power, 'w0')).toBe(MAX_POWER_LEVEL - 1)
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
      for (let index = 0; index < 14; index += 1) {
        cells.push([`w${String(index)}`, wire()])
      }
      cells.push(['lamp', { kind: 'lamp' }])

      const board = line(cells)
      const power = propagateTick(board, emptyPowerMap)

      expect(powerAt(power, 'w13')).toBe(1)
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
        expect(powerAt(power, 'out')).toBe(14)
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
      expect(powerAt(settled.power, 'w2')).toBe(14)
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
      expect(powerAt(power, 'out0')).toBe(14)

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
      // it is 13. It was 14 — the repeater's own 15, decayed once, coming back
      // in through the input — which is precisely one more than the lever can
      // deliver there.
      let power = emptyPowerMap
      const board = diodeBoard(true)
      for (let tick = 0; tick < 4; tick += 1) {
        power = propagateTick(board, power)
      }

      expect(powerAt(power, 'repeater')).toBe(MAX_POWER_LEVEL)
      expect(powerAt(power, 'w1')).toBe(13)
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
      expect(powerAt(power, 'out0')).toBe(14)
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
      expect(powerAt(power, 'w0')).toBe(14)
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
      expect(powerAt(held, 'w0')).toBe(14)

      expect(propagateTick(released, held).size).toBe(0)
    }),
  )
})
