/**
 * The pressure plate: a lever thrown by whoever is standing on it.
 *
 * In the power graph a plate is a source exactly as a lever is, and `active` is
 * a statement by whoever owns the world — the same field, the same meaning, the
 * same owner. What is different is who flips it, and the plate is the first
 * component in this repository whose input is neither the power map nor the
 * player's hand but a set of ENTITY POSITIONS.
 *
 * Two rules follow from that and one of them is not implementable here. This
 * file has the one that is.
 *
 * ---------------------------------------------------------------------------
 * What is here: how many occupants become how much signal
 * ---------------------------------------------------------------------------
 *
 * Vanilla has three plates and they answer different questions. A stone or
 * wooden plate is a switch: anything on it, full power. A weighted plate is a
 * MEASUREMENT — the gold one saturates at fifteen entities and the iron one at a
 * hundred and fifty, and both are used to count things rather than to detect
 * them. `plateSignal` is that mapping, and it is a rule about redstone: the
 * numbers below decide what a player's item counter reads.
 *
 * The reference has only the switch (`redstone-simulation.ts:40`, a plate is a
 * source when `state.active`), so the weighted arithmetic here is ported from
 * vanilla rather than from the reference. It is written as a saturating ceiling
 * rather than a rounding so that ONE entity on a hundred-and-fifty-capacity
 * plate reads 1 and not 0 — a heavy plate that reports nothing until the
 * eleventh entity arrives is a plate that looks broken.
 *
 * ---------------------------------------------------------------------------
 * BOUNDARY: what counts as standing on it
 * ---------------------------------------------------------------------------
 *
 * `occupants` is a NUMBER, supplied. Computing it needs three things that are
 * not here and, in two cases, do not exist anywhere yet:
 *
 *   - geometry. `domain/power-graph.ts` opens with 「There is NO geometry here」
 *     and `domain/position-key.ts` is an opaque string precisely so this
 *     repository cannot navigate. The reference's test is an axis-aligned box
 *     overlap against the plate's cell
 *     (`entity-update-stage.pressure-plate.ts:19-54`), which needs kernel's
 *     `Position` and cannot be written over a key.
 *   - an entity's SIZE. mc-sim's `EntityState` (`domain/entity.ts:229-260`) has
 *     `feetPosition`, `healthPoints` and an opaque `behaviour`, and no extent of
 *     any kind. The reference reaches into `MOB_HALF_WIDTH` / `MOB_HALF_HEIGHT`
 *     from a mob spawner config, which is the rules tier's constant; no
 *     equivalent is published.
 *   - a spatial query. `EntityManagerApi` offers `entities`, `find`, `count`,
 *     `countOfKind` and `sweep` (`mc-sim/application/entity-manager.ts:100-140`)
 *     — every one of them over the WHOLE roster. Counting occupants per plate
 *     from those is O(plates x entities) every redstone tick, and the missing
 *     query is `entitiesWithin(bounds)`, which `EntityManagerApi` does not
 *     expose. `entities` is documented there as "THE HOT PATH", so adding a
 *     per-plate scan on top of it is the thing that comment exists to prevent.
 *
 * Which entities COUNT is a fourth question and it belongs to the rules tier
 * rather than here: a stone plate ignores dropped items and a wooden one does
 * not, and "is this entity an item" is a judgement about `EntityKind`, which
 * mc-sim publishes as an opaque branded string with no taxonomy
 * (`mc-sim/domain/entity.ts:157`). The caller filters; this file counts.
 *
 * ---------------------------------------------------------------------------
 * What is deliberately NOT here: the release delay
 * ---------------------------------------------------------------------------
 *
 * Vanilla keeps a plate powered for a moment after the last entity steps off.
 * That is REMAINING TIME, which is state, and this repository has now given the
 * same answer four times — the button's pulse, the repeater's delay, the
 * observer's pulse and this. The power map has no cell for it and the board is
 * an input. It goes with the tick counter in `stages/registration.ts`.
 */
import { MAX_POWER_LEVEL, type PowerLevel } from './signal-level'

/**
 * How a plate turns a count into a level.
 *
 * A union rather than an enum plus an optional capacity, because a binary plate
 * has no capacity and an optional field that is meaningless for one variant is
 * the shape that lets a caller set it and wonder why nothing happened.
 */
export type PlateWeighing =
  | { readonly kind: 'binary' }
  | { readonly kind: 'weighted'; readonly capacity: number }

/** Vanilla's gold plate: saturates at fifteen entities, so it counts them one for one. */
export const LIGHT_PLATE_CAPACITY = 15

/** Vanilla's iron plate: saturates at a hundred and fifty, so it counts them in tens. */
export const HEAVY_PLATE_CAPACITY = 150

/**
 * What a plate emits with `occupants` things on it.
 *
 * Saturating, and floored at 1 for any non-zero count: the whole use of a
 * weighted plate is telling "none" apart from "some", and a formula that
 * rounded would report 0 for the first five entities on a heavy plate.
 *
 * A non-positive or non-finite `capacity` yields full power for any occupant
 * rather than `Infinity` or `NaN`. A `NaN` level would propagate through the
 * whole board — `NaN > 0` is false, so every cell downstream would read as
 * unpowered and the plate would look like it had failed rather than like it had
 * been mis-configured. Degrading to the binary answer is the reading that keeps
 * a plate a plate.
 */
export const plateSignal = (occupants: number, weighing: PlateWeighing): PowerLevel => {
  if (!Number.isFinite(occupants) || occupants <= 0) {
    return 0
  }

  if (weighing.kind === 'binary') {
    return MAX_POWER_LEVEL
  }

  const { capacity } = weighing
  if (!Number.isFinite(capacity) || capacity <= 0) {
    return MAX_POWER_LEVEL
  }

  return Math.min(MAX_POWER_LEVEL, Math.ceil((occupants / capacity) * MAX_POWER_LEVEL))
}
