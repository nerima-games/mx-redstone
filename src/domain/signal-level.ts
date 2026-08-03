/**
 * The range a redstone signal lives in.
 *
 * ---------------------------------------------------------------------------
 * Why this is its own file
 * ---------------------------------------------------------------------------
 *
 * `MAX_POWER_LEVEL` used to live in `domain/power-graph.ts`, which was right
 * while the only thing that knew about levels was wire decay. It stopped being
 * right when the comparator arrived: a comparator's output is an ARITHMETIC
 * value in this range (`domain/comparator.ts`) and a weighted pressure plate
 * maps a count onto it (`domain/pressure-plate.ts`), so both of those rules need
 * the range — and `power-graph.ts` needs both of those rules. Leaving the
 * constant where it was would have made `power-graph -> comparator ->
 * power-graph` a genuine import cycle.
 *
 * The alternative was for each rule to write its own 15. That is the same defect
 * `domain/piston.ts` opens with, one level down: a number restated in three
 * files is a number that will be changed in two of them.
 *
 * `power-graph.ts` re-exports both names, so the barrel and every consumer are
 * unchanged. This file is a MOVE, not a new surface.
 */

/**
 * A redstone signal strength. 0 means unpowered.
 *
 * Not branded, for the reason `domain/position-key.ts` gives about coordinates:
 * a brand here would make this repository look like the owner of a concept that
 * mc-kernel has not yet published a home for.
 */
export type PowerLevel = number

/**
 * Redstone power runs 0-15. A source applies its level to adjacent dust, then
 * each further dust cell loses one level. Keeping source output and wire decay
 * separate matters for arithmetic sources: a comparator emitting 7 and a
 * weighted plate emitting 4 must not become 6 and 3 merely by entering dust.
 */
export const MAX_POWER_LEVEL = 15
