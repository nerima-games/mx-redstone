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
 * Redstone power runs 0-15; a wire loses one level per cell.
 *
 * A signal therefore crosses FOURTEEN wire cells, not fifteen. A source occupies
 * a cell of the power map like everything else, and every conducting step loses
 * one, so the first wire beside a lever is already at 14 and the fourteenth is
 * at 1. Fifteen was written in several places here and is wrong in all of them:
 * it counts the source's own cell as wire.
 *
 * This is a DIVERGENCE from vanilla, where the dust touching a lever is at 15
 * and a run reaches fifteen cells, and it is recorded rather than fixed. Closing
 * it means a source not decaying into its first neighbour, which changes every
 * level in every circuit and is a behaviour decision, not a typo. What is fixed
 * is the arithmetic claim; `test/power-graph.test.ts` pins the 14 so that the
 * day somebody does close the gap, it is a failing test rather than a quiet
 * renumbering of the whole board.
 *
 * The divergence is CHEAP for a lever, which loses one cell of reach, and
 * EXPENSIVE for a comparator, whose output level is a number the next component
 * does arithmetic on. `docs/design-notes.md` DN-RS-13 measures what it costs
 * there; this comment is the place the cost comes from.
 */
export const MAX_POWER_LEVEL = 15
