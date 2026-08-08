/**
 * The observer: the only component whose trigger is not a signal.
 *
 * Every other source in this repository is driven by the power map or by the
 * player's hand. An observer watches the CELL IN FRONT OF IT and pulses when the
 * block there changes — a different kind of thing entirely, because "changed"
 * is not a property of a state, it is a relation between two states, and the
 * power graph holds exactly one tick of history for power and none at all for
 * blocks.
 *
 * So the memory is explicit. `observeChanges` takes what was seen last tick,
 * returns what was seen this tick, and names the observers that fire in between.
 *
 * ---------------------------------------------------------------------------
 * The memory is a VALUE, and the reference's was a module-level Map
 * ---------------------------------------------------------------------------
 *
 * `redstone-observer-world-effects.ts:34` in the reference:
 *
 *     const lastSeenBlocks = new Map<string, BlockType>()
 *
 * with, six lines later, an exported `resetObserverWatchState()` whose comment
 * reads "Exposed for tests: reset the change-detection memory between
 * scenarios". The escape hatch is the diagnosis. Module-level mutable state is
 * exactly what plan.md §3.8 records as the reference's worst bug source and what
 * DN-RS-8 makes this repository allocate per-call: two worlds share one map, so
 * loading a second world makes every observer in it fire once from the first
 * world's sightings, and two circuit-board previews on one page cannot both be
 * right. The reference's own comment concedes it — "a stale entry after a world
 * switch costs at most one spurious pulse" — and one spurious pulse from an
 * observer is one TNT block detonated.
 *
 * Threading the map through as a value costs one parameter and one field, and
 * removes the reset function along with the class of bug it existed for.
 *
 * ---------------------------------------------------------------------------
 * BOUNDARY: there is no block-change EVENT, and asking for one is wrong
 * ---------------------------------------------------------------------------
 *
 * The obvious question is whether the caller can be told which blocks changed
 * instead of resampling. mc-worldgen does publish a change feed —
 * `ChunkStoreApi.subscribeDirty` (`application/chunk-store.ts:174`) — and it is
 * the wrong granularity on purpose: it yields
 *
 *     ChunkDirtyBatch = { changed: ReadonlyArray<ChunkCoord>; removed: ... }
 *
 * (`mc-worldgen/domain/chunk-store-state.ts:208-211`), and the header above it
 * (`:180-198`) explains that the de-duplication into a SET is the whole design —
 * a falling sand column dirties one chunk up to 32 times a tick and the
 * subscriber must remesh it once. A batch of block POSITIONS would undo that,
 * and it would be mx-redstone asking mc-worldgen to become slower for every
 * subscriber so that one of them can skip a lookup.
 *
 * What the caller does instead is SAMPLE: one `getBlock` per observer per
 * redstone tick. That is O(observers placed), not O(chunks x blocks) — it is not
 * the per-tick full scan plan.md §3.11 calls a disaster, because the scan is
 * bounded by what the player built and not by how much world is loaded. It can
 * be narrowed further at no cost to anyone: `subscribeDirty` is a sound GATE, so
 * a caller may skip every observer whose watched cell lies in a chunk that did
 * not change, and sample only the rest. The dirty batch cannot say which block
 * moved, but it can say for certain which ones did not.
 *
 * The one thing this file therefore does NOT do is decide which cell an observer
 * watches. `Component` carries no `watching` field, for the same reason it
 * carries no `delayTicks` (DN-RS-12): the graph cannot read a block, so a field
 * naming one would be received, stored and never read — worse than absent. The
 * mapping from observer to watched cell belongs to whoever owns the world, next
 * to the `active` flag it produces.
 */
import type { BlockRef } from './block-ref'
import type { PositionKey } from './position-key'

/**
 * How long an observer holds its output up, in redstone ticks.
 *
 * Two, matching the reference (`redstone-observer-world-effects.ts:17`,
 * `OBSERVER_PULSE_TICKS`). A RULE, not a capability, so it lives with the rule —
 * the same placement argument `PISTON_PUSH_LIMIT` gets in `domain/piston.ts`.
 *
 * Counting it down is NOT this file's job, and that is the same decision the
 * button's pulse got (`sourcesOf` in `domain/power-graph.ts` carries the full
 * argument): remaining time is state, the power map has no cell for it, and the
 * thing that knows redstone time is passing is `stages/registration.ts`. This
 * constant is the LENGTH; the clock is the caller's.
 */
export const OBSERVER_PULSE_TICKS = 2

/**
 * What each observer's watched cell holds — keyed by the OBSERVER's position,
 * not the watched one.
 *
 * Keyed by the observer because two observers may watch the same cell and must
 * arm independently: one placed before a change and one placed after it disagree
 * about whether that change was a change, and they are both right.
 */
export type Sightings = ReadonlyMap<PositionKey, BlockRef>

export type ObserverSweep = {
  /** Observers whose watched cell changed this tick, in key order. */
  readonly fired: ReadonlyArray<PositionKey>
  /** What to pass as `previous` next tick. Entries for departed observers are gone. */
  readonly seen: Sightings
}

/**
 * Which observers fire, given what they can see now and what they saw before.
 *
 * Three rules, and the first is the one that is easy to get wrong:
 *
 *   - A FIRST sighting arms the detector and fires nothing. Placing an observer
 *     against an existing block is not a change to that block, and an observer
 *     that fired on placement would make every chunk load a barrage of pulses.
 *     The reference has the same rule and says why in the same words
 *     (`redstone-observer-world-effects.ts:42-43`).
 *   - An unchanged sighting fires nothing.
 *   - Anything else fires. Note that this includes changing BACK: a block
 *     replaced and restored between two ticks is seen as one change, not two,
 *     because sampling only ever compares consecutive ticks. That is a genuine
 *     divergence from vanilla, where the observer is driven by the block update
 *     itself and would see both.
 *
 * Observers that are no longer present are dropped from `seen`. Retaining them
 * would leak one entry per mined observer for the lifetime of the world, and
 * would make a NEW observer placed at the same coordinate inherit the old one's
 * memory — arming it against a sighting nobody took.
 *
 * `fired` is sorted so that two runs over the same inputs produce the same order
 * whatever order the caller assembled its `Map` in. The circuit tests depend on
 * determinism (docs/testing.md §5) and `Map` iteration order is insertion order,
 * which is a property of the caller's loop rather than of the board.
 */
export const observeChanges = (current: Sightings, previous: Sightings): ObserverSweep => {
  const fired: Array<PositionKey> = []
  const seen = new Map<PositionKey, BlockRef>()

  for (const [key, block] of current) {
    seen.set(key, block)
    const before = previous.get(key)
    if (previous.has(key) && before !== block) {
      fired.push(key)
    }
  }

  return { fired: fired.sort(), seen }
}
