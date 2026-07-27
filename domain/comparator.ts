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
 *   - `compare`  — pass the rear through, but only while it beats every side.
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
import { MAX_POWER_LEVEL, type PowerLevel } from './signal-level'

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
    return Math.max(0, rear - strongestSide)
  }

  // An if rather than a ternary chain, and no `default`: see DN-RS-11 on why a
  // closed union is branched over with an if-chain in this repository.
  return rear >= strongestSide ? rear : 0
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
 * BOUNDARY: nothing in this repository can produce one of these
 * ---------------------------------------------------------------------------
 *
 * Filling this array needs two things mx-redstone does not have and must not
 * invent (docs/responsibility.md §2 puts both elsewhere):
 *
 *   - the contents of the container behind the comparator. mc-sim's
 *     `InventoryServiceApi` (`application/inventory-service.ts:17-53`) addresses
 *     exactly ONE inventory — the player's — through `add` / `remove` /
 *     `countOf` / `snapshot`, none of which takes a position. There is no
 *     `inventoryAt(position)`, and `Inventory` itself
 *     (`mc-sim/domain/inventory.ts:112`) is a flat `ReadonlyArray<Slot>` with no
 *     identity, so there is nothing to ask for one WITH.
 *   - a per-item stack size. mc-kernel publishes `MAX_STACK_COUNT = 64` as a
 *     single global (`domain/quantities.ts:20`) and `ItemType` carries no
 *     capability table at all — the eleven flags in
 *     `domain/block-capabilities.ts:97-179` are `passable`, `pistonImmovable`,
 *     `suffocates` and eight more like them, every one about a BLOCK's physics
 *     and not one about an item's stacking.
 *
 * So the rule below is complete and the data for it does not exist yet. That is
 * the honest state, and it is written here rather than as a TODO because the two
 * missing things are nameable: `InventoryServiceApi.inventoryAt(BlockPosition)`
 * and an item-side `maxStackSize` capability.
 */
export type ContainerSlot = {
  /** How many items the slot holds. */
  readonly count: number
  /** How many of THAT item fit in one slot. */
  readonly maxStack: number
}

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
export const containerSignalStrength = (slots: ReadonlyArray<ContainerSlot>): PowerLevel => {
  if (slots.length === 0) {
    return 0
  }

  let fullness = 0
  let held = 0
  for (const slot of slots) {
    if (!Number.isFinite(slot.count) || !Number.isFinite(slot.maxStack) || slot.maxStack <= 0) {
      continue
    }
    const count = Math.min(Math.max(0, slot.count), slot.maxStack)
    if (count > 0) {
      held += count
      fullness += count / slot.maxStack
    }
  }

  if (held === 0) {
    return 0
  }

  return Math.min(
    MAX_POWER_LEVEL,
    Math.floor(CONTAINER_SIGNAL_FLOOR + (fullness / slots.length) * CONTAINER_SIGNAL_SPAN),
  )
}
