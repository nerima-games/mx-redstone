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
import { Effect, Result, Schema } from 'effect'
import type { ItemType } from '@nerima-games/mc-kernel'
import * as fc from 'fast-check'
import {
  DISPENSER_CONTAINER_CAPACITY,
  ItemStackFailureSchema,
  itemStack,
  type Container,
  type ItemStackFailure,
} from '@nerima-games/mc-sim'
import {
  DispenserActionPlanSchema,
  DispenserPlanFailureSchema,
  dispenserEdges,
  planDispenserAction,
  type PowerEdgeMemory,
} from '../src/domain/dispenser'

const powered = (entries: ReadonlyArray<readonly [string, boolean]>): ReadonlyMap<string, boolean> =>
  new Map(entries)

const makeDispenser = (
  entries: ReadonlyArray<readonly [number, ItemType, number?]>,
): Result.Result<Container, ItemStackFailure> => {
  const slots: Array<Container['slots'][number]> = Array.from(
    { length: DISPENSER_CONTAINER_CAPACITY },
    () => null,
  )

  for (const [slot, item, count = 1] of entries) {
    const stack = itemStack(item, count)
    if (Result.isFailure(stack)) return Result.fail(stack.failure)
    slots[slot] = { ...stack.success, durability: null }
  }

  const container: Container = { id: 'test-dispenser', kind: 'dispenser', slots }
  return Result.succeed(container)
}

const PROPERTY_RUN_COUNT = 32
const GENERIC_DISPENSER_ITEMS = ['arrow', 'tnt', 'redstone_dust'] as const satisfies ReadonlyArray<ItemType>

const countContainerItems = (container: Container): number =>
  container.slots.reduce((count, stack) => count + (stack === null ? 0 : stack.count), 0)

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

describe('dispenser item action planning', () => {
  const decodeStrictAction = Schema.decodeUnknownResult(DispenserActionPlanSchema, {
    onExcessProperty: 'error',
  })

  it.effect('accepts each of the nine selected slots and returns one item', () =>
    Effect.sync(() => {
      const entries: Array<readonly [number, ItemType]> = []
      for (let slot = 0; slot < DISPENSER_CONTAINER_CAPACITY; slot += 1) {
        entries.push([slot, 'arrow'])
      }

      const inventory = makeDispenser(entries)
      expect(Result.isSuccess(inventory)).toBe(true)
      if (Result.isFailure(inventory)) {
        expect(Result.isSuccess(inventory)).toBe(true)
        return
      }

      for (let slot = 0; slot < DISPENSER_CONTAINER_CAPACITY; slot += 1) {
        const action = planDispenserAction(inventory.success, slot)
        expect(Result.isSuccess(action)).toBe(true)
        if (Result.isFailure(action)) {
          expect(Result.isSuccess(action)).toBe(true)
          return
        }

        expect(action.success).toStrictEqual({
          _tag: 'SpawnArrow',
          slot,
          item: 'arrow',
          count: 1,
        })
      }
    }),
  )

  it.effect('plans arrow, primed TNT, and generic ejection from the selected slot', () =>
    Effect.sync(() => {
      for (const item of ['arrow', 'tnt', 'redstone_dust'] satisfies ReadonlyArray<ItemType>) {
        const inventory = makeDispenser([[4, item]])
        expect(Result.isSuccess(inventory)).toBe(true)
        if (Result.isFailure(inventory)) {
          expect(Result.isSuccess(inventory)).toBe(true)
          return
        }

        const containerBefore: Container = {
          ...inventory.success,
          slots: inventory.success.slots.map((stack) => (stack === null ? null : { ...stack })),
        }
        const itemCountBefore = countContainerItems(inventory.success)
        const action = planDispenserAction(inventory.success, 4)
        expect(Result.isSuccess(action)).toBe(true)
        if (Result.isFailure(action)) {
          expect(Result.isSuccess(action)).toBe(true)
          return
        }

        expect(inventory.success).toStrictEqual(containerBefore)
        expect(countContainerItems(inventory.success)).toBe(itemCountBefore)
        const expectedTag = item === 'arrow' ? 'SpawnArrow' : item === 'tnt' ? 'PrimeTnt' : 'EjectItem'
        expect(action.success._tag).toBe(expectedTag)
        expect(action.success.slot).toBe(4)
        expect(action.success.item).toBe(item)
        expect(action.success.count).toBe(1)

        const decoded = decodeStrictAction(action.success)
        expect(Result.isSuccess(decoded)).toBe(true)
        for (const field of ['_tag', 'slot', 'item', 'count']) {
          const missing: Record<string, unknown> = { ...action.success }
          delete missing[field]
          expect(Result.isFailure(decodeStrictAction(missing))).toBe(true)
        }
        expect(
          Result.isFailure(decodeStrictAction({ ...action.success, unexpected: true })),
        ).toBe(true)
      }
    }),
  )

  it.effect('returns typed failures for invalid inventory, slot, and empty-slot inputs', () =>
    Effect.sync(() => {
      expect(planDispenserAction(null, 0)).toStrictEqual(Result.fail({ _tag: 'InvalidContainer' }))
      expect(
        planDispenserAction({ id: 'wrong-size', kind: 'dispenser', slots: [] }, 0),
      ).toStrictEqual(Result.fail({ _tag: 'InvalidContainer' }))
      expect(
        planDispenserAction(
          { id: 'test-hopper', kind: 'hopper', slots: Array.from({ length: 5 }, () => null) },
          0,
        ),
      ).toStrictEqual(Result.fail({ _tag: 'NotDispenser' }))

      const inventory = makeDispenser([])
      expect(Result.isSuccess(inventory)).toBe(true)
      if (Result.isFailure(inventory)) {
        expect(Result.isSuccess(inventory)).toBe(true)
        return
      }

      expect(
        planDispenserAction({ ...inventory.success, unexpected: true }, 0),
      ).toStrictEqual(Result.fail({ _tag: 'InvalidContainer' }))

      for (const invalidSlot of [-1, 9, 1.5, NaN, Infinity, -Infinity, '0', null]) {
        expect(planDispenserAction(inventory.success, invalidSlot)).toStrictEqual(
          Result.fail({ _tag: 'InvalidSlot' }),
        )
      }

      const emptySlot = planDispenserAction(inventory.success, 8)
      expect(Result.isFailure(emptySlot)).toBe(true)
      if (Result.isSuccess(emptySlot)) {
        expect(Result.isFailure(emptySlot)).toBe(true)
        return
      }
      expect(emptySlot.failure).toStrictEqual({ _tag: 'EmptySlot', slot: 8 })
      expect(
        Result.isSuccess(Schema.decodeUnknownResult(DispenserPlanFailureSchema)(emptySlot.failure)),
      ).toBe(true)
      expect(
        Result.isFailure(
          Schema.decodeUnknownResult(DispenserPlanFailureSchema)({ _tag: 'EmptySlot' }),
        ),
      ).toBe(true)
    }),
  )

  it.effect('returns typed failures or schema-valid finite action plans for arbitrary inputs', () =>
    Effect.sync(() => {
      fc.assert(
        fc.property(
          fc.tuple(fc.anything({ maxDepth: 3 }), fc.anything({ maxDepth: 2 })),
          ([container, slot]) => {
            const outcome = planDispenserAction(container, slot)
            if (Result.isSuccess(outcome)) {
              expect(Result.isSuccess(decodeStrictAction(outcome.success))).toBe(true)
              return
            }

            const decodedFailure = Schema.decodeUnknownResult(DispenserPlanFailureSchema, {
              onExcessProperty: 'error',
            })(outcome.failure)
            expect(Result.isSuccess(decodedFailure)).toBe(true)
          },
        ),
        { numRuns: PROPERTY_RUN_COUNT },
      )
    }),
  )

  it.effect('covers item-count boundaries and adjacent invalid counts', () =>
    Effect.sync(() => {
      for (const count of [1, 64]) {
        const inventory = makeDispenser([[0, 'arrow', count]])
        expect(Result.isSuccess(inventory)).toBe(true)
        if (Result.isFailure(inventory)) return

        const itemCountBefore = countContainerItems(inventory.success)
        expect(itemCountBefore).toBe(count)
        const outcome = planDispenserAction(inventory.success, 0)
        expect(Result.isSuccess(outcome)).toBe(true)
        if (Result.isFailure(outcome)) return

        expect(Result.isSuccess(decodeStrictAction(outcome.success))).toBe(true)
        expect(countContainerItems(inventory.success)).toBe(itemCountBefore)
      }

      for (const invalidCount of [0, 65]) {
        const inventory = makeDispenser([[0, 'arrow', invalidCount]])
        expect(Result.isFailure(inventory)).toBe(true)
        if (Result.isFailure(inventory)) {
          const decodedFailure = Schema.decodeUnknownResult(
            ItemStackFailureSchema,
            { onExcessProperty: 'error' },
          )(inventory.failure)
          expect(Result.isSuccess(decodedFailure)).toBe(true)
        }
      }
    }),
  )

  it.effect('conserves the item total while planning a selected dispenser action', () =>
    Effect.sync(() => {
      const inventoryArbitrary = fc.array(
        fc.record({
          count: fc.integer({ min: 1, max: 64 }),
          item: fc.constantFrom(...GENERIC_DISPENSER_ITEMS),
        }),
        { maxLength: DISPENSER_CONTAINER_CAPACITY, minLength: 1 },
      )
      fc.assert(
        fc.property(inventoryArbitrary, (items) => {
          const entries = items.map(({ count, item }, slot) => [slot, item, count] as const)
          const inventory = makeDispenser(entries)
          expect(Result.isSuccess(inventory)).toBe(true)
          if (Result.isFailure(inventory)) return

          const itemCountBefore = countContainerItems(inventory.success)
          const outcome = planDispenserAction(inventory.success, 0)
          expect(Result.isSuccess(outcome)).toBe(true)
          if (Result.isFailure(outcome)) return

          const decoded = decodeStrictAction(outcome.success)
          expect(Result.isSuccess(decoded)).toBe(true)
          expect(countContainerItems(inventory.success)).toBe(itemCountBefore)
        }),
        { numRuns: PROPERTY_RUN_COUNT },
      )
    }),
  )
})
