/**
 * The comparator's arithmetic, tested EXHAUSTIVELY rather than by fixture.
 *
 * `comparatorOutput` takes three numbers and returns one, and its whole input
 * space is 16 x 16 x 16 x 2 — small enough to enumerate. That matters more here
 * than elsewhere in this repository: an off-by-one in a comparator is not a
 * circuit that fails, it is a circuit that is right for every input a fixture
 * happens to use and wrong at the boundary the player's item sorter sits on.
 * A `>=` written as `>` passes every test in which the sides are unwired.
 *
 * Origin for every expectation below:
 * `packages/entity/domain/redstone/redstone-simulation.ts:319-323` (both modes
 * in one expression) and `:289-291` (the compare rule stated in words).
 */
import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import {
  CONTAINER_SIGNAL_FLOOR,
  CONTAINER_SIGNAL_SPAN,
  comparatorOutput,
  containerSignalStrength,
  type ContainerSlot,
} from '../src/domain/comparator'
import { MAX_POWER_LEVEL } from '../src/domain/signal-level'

const LEVELS = Array.from({ length: MAX_POWER_LEVEL + 1 }, (_, level) => level)

describe('comparator arithmetic', () => {
  it.effect('compare mode passes the rear through exactly when no side beats it', () =>
    Effect.sync(() => {
      // The whole 16 x 16 space, both directions of the comparison, asserted
      // against the rule rather than against a table — a table would be the same
      // off-by-one written twice.
      for (const rear of LEVELS) {
        for (const side of LEVELS) {
          const expected = rear >= side ? rear : 0
          expect(comparatorOutput(rear, [side], 'compare')).toBe(expected)
        }
      }
    }),
  )

  it.effect('REGRESSION: a side EQUAL to the rear passes in compare mode and empties it in subtract mode', () =>
    Effect.sync(() => {
      // The single input at which the two modes are furthest apart, and the one
      // a `>` written for a `>=` gets wrong. Every other equal-signal case in a
      // fixture is a coincidence; this is the boundary.
      for (const level of LEVELS.filter((value) => value > 0)) {
        expect(comparatorOutput(level, [level], 'compare')).toBe(level)
        expect(comparatorOutput(level, [level], 'subtract')).toBe(0)
      }
    }),
  )

  it.effect('subtract mode is rear minus the STRONGEST side, floored at zero', () =>
    Effect.sync(() => {
      for (const rear of LEVELS) {
        for (const side of LEVELS) {
          expect(comparatorOutput(rear, [side], 'subtract')).toBe(Math.max(0, rear - side))
        }
      }
    }),
  )

  it.effect('the sides are reduced by MAXIMUM, not by sum — two weak sides do not add up', () =>
    Effect.sync(() => {
      // A sum would make two sides at 4 subtract 8. In vanilla a comparator sees
      // one side signal, the strongest, however many faces carry one.
      expect(comparatorOutput(10, [4, 4], 'subtract')).toBe(6)
      expect(comparatorOutput(10, [4, 4, 4, 4], 'subtract')).toBe(6)
      expect(comparatorOutput(10, [4, 9], 'subtract')).toBe(1)
      expect(comparatorOutput(10, [9, 4], 'subtract')).toBe(1)
    }),
  )

  it.effect('a comparator with nothing beside it passes the rear through in BOTH modes', () =>
    Effect.sync(() => {
      // `Math.max()` of an empty list is -Infinity, which would make subtract
      // mode return Infinity and put a non-level into the power map. The
      // reduction is written out in `comparatorOutput` for exactly this input.
      for (const rear of LEVELS) {
        expect(comparatorOutput(rear, [], 'compare')).toBe(rear)
        expect(comparatorOutput(rear, [], 'subtract')).toBe(rear)
      }
    }),
  )

  it.effect('the output never leaves the signal range, for any input in it', () =>
    Effect.sync(() => {
      for (const rear of LEVELS) {
        for (const side of LEVELS) {
          for (const mode of ['compare', 'subtract'] as const) {
            const output = comparatorOutput(rear, [side], mode)
            expect(Number.isInteger(output)).toBe(true)
            expect(output).toBeGreaterThanOrEqual(0)
            expect(output).toBeLessThanOrEqual(MAX_POWER_LEVEL)
          }
        }
      }
    }),
  )
})

describe('container fullness — the reading a comparator takes from a chest', () => {
  const slots = (counts: ReadonlyArray<number>, maxStack = 64): ReadonlyArray<ContainerSlot> =>
    counts.map((count) => ({ count, maxStack }))

  it.effect('the floor and the span add up to the top of the signal range', () =>
    Effect.sync(() => {
      // Asserted rather than derived. `domain/comparator.ts` deliberately writes
      // 1 and 14 as vanilla's own numbers instead of computing them from
      // MAX_POWER_LEVEL, so this is the line that would fail if the two ever
      // stopped agreeing — a full chest reading 14 or 16 is a silent break of
      // every design that compares a comparator against a redstone block.
      expect(CONTAINER_SIGNAL_FLOOR + CONTAINER_SIGNAL_SPAN).toBe(MAX_POWER_LEVEL)
    }),
  )

  it.effect('REGRESSION: one item in a big chest reads 1, not 0 — empty and nearly-empty must differ', () =>
    Effect.sync(() => {
      // The property every item sorter in the game is built on. A formula
      // without the floor gives floor(0.0005 * 14) = 0 here and the sorter never
      // fires.
      const chest = slots([1, ...Array.from({ length: 26 }, () => 0)])
      expect(containerSignalStrength(chest)).toBe(CONTAINER_SIGNAL_FLOOR)
    }),
  )

  it.effect('an empty container reads 0, and a container with no slots reads 0', () =>
    Effect.sync(() => {
      expect(containerSignalStrength(slots([0, 0, 0]))).toBe(0)
      expect(containerSignalStrength([])).toBe(0)
    }),
  )

  it.effect('a completely full container reads exactly MAX_POWER_LEVEL', () =>
    Effect.sync(() => {
      for (const slotCount of [1, 5, 27, 54]) {
        expect(containerSignalStrength(slots(Array.from({ length: slotCount }, () => 64)))).toBe(
          MAX_POWER_LEVEL,
        )
      }
    }),
  )

  it.effect('fullness is measured in STACKS, so one bucket fills a slot as much as 64 cobblestone', () =>
    Effect.sync(() => {
      // The reason `ContainerSlot.maxStack` is per-slot rather than mc-kernel's
      // single MAX_STACK_COUNT = 64. A chest of buckets is full; a rule that
      // divided by 64 would call it 1/64 full and report 1.
      const buckets: ReadonlyArray<ContainerSlot> = Array.from({ length: 27 }, () => ({
        count: 1,
        maxStack: 1,
      }))
      expect(containerSignalStrength(buckets)).toBe(MAX_POWER_LEVEL)
    }),
  )

  it.effect('the reading rises monotonically as the container fills, and never leaves the range', () =>
    Effect.sync(() => {
      const CAPACITY = 27 * 64
      let previous = 0
      for (let filled = 0; filled <= CAPACITY; filled += 37) {
        const counts = Array.from({ length: 27 }, (_, index) =>
          Math.min(64, Math.max(0, filled - index * 64)),
        )
        const reading = containerSignalStrength(slots(counts))
        expect(reading).toBeGreaterThanOrEqual(previous)
        expect(reading).toBeLessThanOrEqual(MAX_POWER_LEVEL)
        previous = reading
      }

      // The step is 37 items, which does not divide the capacity, so the loop
      // above stops just short of full. The top of the curve is asserted here
      // rather than by choosing a step that lands on it — a step chosen to make
      // the last iteration full would hide a formula that only reaches 15 at
      // exactly one input.
      expect(previous).toBeGreaterThan(0)
      expect(containerSignalStrength(slots(Array.from({ length: 27 }, () => 64)))).toBe(
        MAX_POWER_LEVEL,
      )
    }),
  )

  it.effect('REGRESSION: a corrupt slot contributes nothing rather than poisoning every comparator on the board', () =>
    Effect.sync(() => {
      // The precedent is mc-sim's `heldCount` (domain/inventory.ts), which
      // exists because arithmetic on NaN is contagious. Here one bad slot would
      // make the reading NaN, `NaN > 0` is false, and the symptom would be a
      // sorter that stopped working — not an error anybody could find.
      const poisoned: ReadonlyArray<ContainerSlot> = [
        { count: Number.NaN, maxStack: 64 },
        { count: 64, maxStack: 0 },
        { count: 5, maxStack: Number.POSITIVE_INFINITY },
        { count: 64, maxStack: 64 },
      ]
      const reading = containerSignalStrength(poisoned)
      expect(Number.isInteger(reading)).toBe(true)
      expect(reading).toBeGreaterThan(0)
      expect(reading).toBeLessThanOrEqual(MAX_POWER_LEVEL)

      // A slot holding more than it can is clamped, not counted twice over.
      expect(containerSignalStrength([{ count: 6400, maxStack: 64 }])).toBe(MAX_POWER_LEVEL)
    }),
  )
})
