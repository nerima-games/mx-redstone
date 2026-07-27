/**
 * The dispenser fires on the EDGE, and the asymmetry with the observer.
 *
 * Both components remember one tick of the past and both are implemented in the
 * reference with a module-level `Map` plus a reset function
 * (`redstone-dispenser-world-effects.ts:36-41`). They differ in what an ABSENT
 * memory entry means, and the difference is not an implementation detail — it is
 * what the player sees, twice, in opposite directions.
 */
import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { dispenserEdges, type PowerEdgeMemory } from '../domain/dispenser'

const powered = (entries: ReadonlyArray<readonly [string, boolean]>): ReadonlyMap<string, boolean> =>
  new Map(entries)

describe('dispenser rising edges', () => {
  it.effect('REGRESSION: a dispenser held powered fires ONCE, not once per tick', () =>
    Effect.sync(() => {
      // The failure this prevents is not subtle. A dispenser wired to a lever a
      // player leaves ON empties a double chest in a few seconds if the rule
      // reads the level instead of the edge.
      let memory: PowerEdgeMemory = new Map()
      const firings: Array<number> = []

      for (let tick = 0; tick < 30; tick += 1) {
        const sweep = dispenserEdges(powered([['d', true]]), memory)
        if (sweep.fired.length > 0) {
          firings.push(tick)
        }
        memory = sweep.powered
      }

      expect(firings).toStrictEqual([0])
    }),
  )

  it.effect('it fires again after the power goes away and comes back', () =>
    Effect.sync(() => {
      let memory: PowerEdgeMemory = new Map()
      const firings: Array<number> = []
      // ON ON OFF OFF ON ON — two rising edges, at ticks 0 and 4.
      const schedule = [true, true, false, false, true, true]

      for (const [tick, live] of schedule.entries()) {
        const sweep = dispenserEdges(powered([['d', live]]), memory)
        if (sweep.fired.length > 0) {
          firings.push(tick)
        }
        memory = sweep.powered
      }

      expect(firings).toStrictEqual([0, 4])
    }),
  )

  it.effect('REGRESSION: an absent memory entry counts as unpowered, so a dispenser placed into a live circuit fires', () =>
    Effect.sync(() => {
      // The OPPOSITE of the observer's first-sighting rule
      // (`test/observer.test.ts`), and both are what vanilla does. A dispenser
      // watches ITSELF and was unpowered a moment ago because it did not exist;
      // an observer watches a block that did not change by being looked at.
      //
      // Pinned in both files so that "make them consistent" is a failing test
      // rather than a tidy-up.
      const sweep = dispenserEdges(powered([['d', true]]), new Map())
      expect(sweep.fired).toStrictEqual(['d'])
    }),
  )

  it.effect('a dispenser that is not powered never fires, however long it waits', () =>
    Effect.sync(() => {
      let memory: PowerEdgeMemory = new Map()
      for (let tick = 0; tick < 20; tick += 1) {
        const sweep = dispenserEdges(powered([['d', false]]), memory)
        expect(sweep.fired).toStrictEqual([])
        memory = sweep.powered
      }
    }),
  )

  it.effect('REGRESSION: the memory is a value, so one board’s edges cannot suppress another’s', () =>
    Effect.sync(() => {
      // With the reference's module-level `Map`, the second board's dispenser
      // would find the first board's `true` and stay silent — a dispenser that
      // never fires because a dispenser at the same coordinate in a DIFFERENT
      // world fired earlier.
      const first = dispenserEdges(powered([['d', true]]), new Map())
      expect(first.fired).toStrictEqual(['d'])

      const second = dispenserEdges(powered([['d', true]]), new Map())
      expect(second.fired).toStrictEqual(['d'])
    }),
  )

  it.effect('a dispenser that is gone is dropped from the memory', () =>
    Effect.sync(() => {
      const armed = dispenserEdges(powered([['d', true]]), new Map())
      const mined = dispenserEdges(new Map(), armed.powered)
      expect(mined.powered.size).toBe(0)

      // …and a dispenser placed at the same cell later is a new dispenser: it
      // sees a rising edge rather than inheriting the old one's `true`.
      expect(dispenserEdges(powered([['d', true]]), mined.powered).fired).toStrictEqual(['d'])
    }),
  )

  it.effect('`fired` is sorted, so the order does not depend on the caller’s Map order', () =>
    Effect.sync(() => {
      const forwards = dispenserEdges(
        powered([
          ['a', true],
          ['b', true],
          ['c', true],
        ]),
        new Map(),
      )
      const backwards = dispenserEdges(
        powered([
          ['c', true],
          ['a', true],
          ['b', true],
        ]),
        new Map(),
      )

      expect(forwards.fired).toStrictEqual(['a', 'b', 'c'])
      expect(backwards.fired).toStrictEqual(forwards.fired)
    }),
  )
})
