/**
 * The comparator: the only component whose output is a NUMBER.
 *
 * Everything else in this repository answers a yes/no question and emits
 * `MAX_POWER_LEVEL` when the answer is yes. A lever is on or off; a torch burns
 * or does not; a repeater restores FULL power precisely so that the level it
 * received stops mattering. The comparator is the one component that reads a
 * level, computes with it, and emits the result — which is why it is the one
 * that finds out whether the signal model can carry a number at all.
 *
 * It can, and DN-RS-13 records the one place where the number arrives wrong.
 *
 * ---------------------------------------------------------------------------
 * The two modes
 * ---------------------------------------------------------------------------
 *
 * A comparator reads three cells: the one behind it (the REAR, its input) and
 * the two beside it (the SIDES). What it does with them depends on a mode the
 * player toggles by right-clicking it:
 *
 *   - `compare`  — pass the rear through when it is at least as strong as every side.
 *   - `subtract` — pass rear minus the strongest side, floored at zero.
 *
 * Reference: `packages/entity/domain/redstone/redstone-simulation.ts:319-323`
 * carries both in one expression, and `:289-291` states the compare rule in
 * words ("output = rear signal when rear >= max(side signals), else 0").
 *
 * ---------------------------------------------------------------------------
 * This file imports nothing but the signal range, and that is the point
 * ---------------------------------------------------------------------------
 *
 * `comparatorOutput` takes three numbers and returns one. It does not take a
 * board, a power map, a position or a facing: WHICH cells are the rear and the
 * sides is a property of how the component was placed, and placement is
 * `domain/power-graph.ts`'s business (the same split `conductsInto` makes for a
 * repeater — see DN-RS-12). Keeping the arithmetic separable is what lets it be
 * tested exhaustively over the whole 16x16x16 input space instead of through
 * fixtures, which matters because the failure mode of an off-by-one here is a
 * circuit that is right for most inputs.
 */
import { Brand, Schema } from 'effect'
import { MAX_POWER_LEVEL, type PowerLevel } from './signal-level.js'
import { MAX_STACK_COUNT, MaxStackSize, type MaxStackSize as MaxStackSizeValue } from '@nerima-games/mc-kernel'

export type ComparatorMode = 'compare' | 'subtract'

/**
 * What a comparator emits, given what it can see.
 *
 * `sides` is a list rather than a single maximum so that the caller is not
 * asked to pre-reduce it; a comparator with one side wired and one bare has one
 * entry, and a comparator with nothing beside it has none. `Math.max()` of an
 * empty list is `-Infinity`, which would make `subtract` return `Infinity`, so
 * the reduction is written out rather than delegated.
 *
 * COMPARE is not "rear minus zero". The distinction only shows up when a side
 * equals the rear: `compare` passes (rear >= side), `subtract` emits 0. A single
 * expression that got this backwards would still pass every test in which the
 * sides are unwired, which is most of them.
 */
/** The floor every redstone signal level sits at; nothing here reads negative. */
const MIN_POWER_LEVEL: PowerLevel = 0

export const comparatorOutput = (
  rear: PowerLevel,
  sides: ReadonlyArray<PowerLevel>,
  mode: ComparatorMode,
): PowerLevel => {
  let strongestSide = 0
  for (const side of sides) {
    if (side > strongestSide) {
      strongestSide = side
    }
  }

  if (mode === 'subtract') {
    return Math.max(MIN_POWER_LEVEL, rear - strongestSide)
  }

  // An if rather than a ternary chain, and no `default`: see DN-RS-11 on why a
  // Closed union is branched over with an if-chain in this repository.
  if (rear >= strongestSide) {
    return rear
  }
  return MIN_POWER_LEVEL
}

/**
 * One slot of a container, as much of it as the comparator rule needs.
 *
 * `maxStack` is per-slot rather than a module constant because vanilla's
 * fullness is measured in STACKS, not items: a chest holding one bucket (which
 * stacks to 1) is as full, per slot, as one holding sixty-four cobblestone.
 * Modelling it with a single global would make a chest of buckets read 0.
 *
 * ---------------------------------------------------------------------------
 * CONTRACT: the caller supplies these slots
 * ---------------------------------------------------------------------------
 *
 * Filling this array needs the container contents and each stack's capacity.
 * These values must come from the world owner; this rule must not invent either
 * inventory contents or item metadata (docs/responsibility.md §2):
 *
 *   - the contents of the container behind the comparator. mc-sim 0.6 exposes
 *     `ContainerServiceApi.containerSnapshotAt` and
 *     `InventoryServiceApi.containerSnapshotAt`, plus extraction and move
 *     operations. This package does not yet connect those reads to
 *     `RedstoneHostLookup.readContainerSlots`.
 *   - each stack's capacity. mc-kernel 0.11 exposes `maxStackCountForItem` and
 *     `maxStackCountForStack`; the host must use the actual stack's limit instead
 *     of treating the schema-wide `MAX_STACK_COUNT` ceiling as its capacity.
 *
 * The comparator rule below is complete once the host supplies these values.
 * The remaining work is to connect the published container and item contracts;
 * it does not require a new upstream API.
 */
export type ContainerItemCount = number & Brand.Brand<'ContainerItemCount'>

export const ContainerItemCountSchema: Schema.Codec<ContainerItemCount, number> = Schema.Int
  .check(Schema.isBetween({ maximum: MAX_STACK_COUNT, minimum: 0 }))
  .pipe(Schema.brand('ContainerItemCount'))

export const MaxStackSizeSchema: Schema.Codec<MaxStackSizeValue, number> = Schema.Int.pipe(
  Schema.fromBrand('MaxStackSize', MaxStackSize),
)

export type ContainerSlot = {
  /** How many items the slot holds. */
  readonly count: ContainerItemCount
  /** How many of THAT item fit in one slot. */
  readonly maxStack: MaxStackSizeValue
}

const structSchema = Schema.Struct

export const ContainerSlotSchema: Schema.Codec<ContainerSlot, unknown> = structSchema({
  count: ContainerItemCountSchema,
  maxStack: MaxStackSizeSchema,
})

/**
 * The floor of a non-empty container's reading.
 *
 * A container with a single item in it reads 1, not 0: the comparator has to
 * distinguish "empty" from "nearly empty", and every item-sorter design in the
 * game is built on that step. Vanilla's formula is written to guarantee it.
 */
export const CONTAINER_SIGNAL_FLOOR = 1

/**
 * How far above the floor a full container reads.
 *
 * `CONTAINER_SIGNAL_FLOOR + CONTAINER_SIGNAL_SPAN` is `MAX_POWER_LEVEL`, and
 * `test/comparator.test.ts` asserts that rather than trusting it: this file
 * deliberately does not derive the span from the maximum, because the 1 and the
 * 14 are vanilla's numbers and their sum happening to be the top of the signal
 * range is a coincidence of design, not a definition.
 */
export const CONTAINER_SIGNAL_SPAN = 14

/**
 * What a comparator reads from the container behind it.
 *
 * Vanilla: `0` when empty, otherwise `floor(1 + fullness * 14)` where fullness
 * is the mean fraction-of-a-stack across every slot, INCLUDING the empty ones.
 * Two consequences that look like bugs and are not:
 *
 *   - a single item in a 27-slot chest reads 1, and so does a whole stack; the
 *     first ~2 stacks of cobblestone are all worth one level.
 *   - a container that is completely full reads 15 exactly, because the floor
 *     and the span were chosen to make it land there.
 *
 * Slots with a non-positive or non-finite `maxStack` contribute nothing rather
 * than `Infinity` or `NaN`. The precedent is mc-sim's `heldCount`
 * (`domain/inventory.ts`), which exists because `Math.min(NaN, x)` is `NaN` and
 * one poisoned slot silently zeroes a whole computation. Here the same slot
 * would make every comparator on the board read `NaN`, and `NaN > 0` is false,
 * so the symptom would be a sorter that stopped working rather than an error.
 */
/** A slot list of this length holds no slots to read at all. */
const NO_SLOTS = 0

/** A clamped slot count at or below this holds nothing. */
const MIN_SLOT_COUNT = 0

/** A `maxStack` at or below this cannot be divided into and is unusable data. */
const NON_POSITIVE_MAX_STACK = 0

/** A fullness accumulator at this value means no slot contributed anything. */
const NO_ITEMS_HELD = 0

/** Whether a slot's data is safe to fold into the fullness total. */
const isUsableSlot = (slot: ContainerSlot): boolean =>
  Number.isFinite(slot.count) && Number.isFinite(slot.maxStack) && slot.maxStack > NON_POSITIVE_MAX_STACK

/** A slot's count, clamped to the range it can actually hold. */
const clampedSlotCount = (slot: ContainerSlot): number =>
  Math.min(Math.max(MIN_SLOT_COUNT, slot.count), slot.maxStack)

type ContainerFullness = {
  readonly held: number
  readonly fullness: number
}

/**
 * Sums how much every usable slot holds and how full it is. Split out of
 * `containerSignalStrength` so that function stays under the statement-count
 * threshold; the accumulation rule itself is unchanged.
 */
const accumulateFullness = (slots: ReadonlyArray<ContainerSlot>): ContainerFullness => {
  let fullness = 0
  let held = 0
  for (const slot of slots) {
    if (isUsableSlot(slot)) {
      const count = clampedSlotCount(slot)
      if (count > MIN_SLOT_COUNT) {
        held += count
        fullness += count / slot.maxStack
      }
    }
  }
  return { fullness, held }
}

export const containerSignalStrength = (slots: ReadonlyArray<ContainerSlot>): PowerLevel => {
  if (slots.length === NO_SLOTS) {
    return MIN_POWER_LEVEL
  }

  const { held, fullness } = accumulateFullness(slots)
  if (held === NO_ITEMS_HELD) {
    return MIN_POWER_LEVEL
  }

  return Math.min(
    MAX_POWER_LEVEL,
    Math.floor(CONTAINER_SIGNAL_FLOOR + (fullness / slots.length) * CONTAINER_SIGNAL_SPAN),
  )
}
