/**
 * The dispenser: fires on the EDGE, not on the level.
 *
 * A lamp lit by a lever stays lit; a dispenser fed by the same lever fires once
 * and then waits for the lever to go off and on again. That distinction is the
 * whole of what this repository owns about a dispenser, and it is worth its own
 * file because getting it wrong is not a subtle failure: a dispenser wired to a
 * lever that a player leaves ON empties a double chest in three seconds.
 *
 * The reference implements it with a rising-edge check against remembered state
 * (`redstone-dispenser-world-effects.ts:59-63`), and remembers it in a
 * module-level `Map` (`:36`) with a `resetDispenserState()` beside it. Same
 * defect, same fix, and the same reasoning as `domain/observer.ts`: the memory
 * is a value in and a value out, so two worlds cannot share one.
 *
 * ---------------------------------------------------------------------------
 * BOUNDARY: everything past the edge belongs to somebody else
 * ---------------------------------------------------------------------------
 *
 * `dispenserEdges` decides WHETHER a dispenser fires. WHAT comes out of it is
 * three separate things this repository cannot express, and none of them is a
 * matter of effort:
 *
 *   - the item. Drawing one needs a container at a position, and mc-sim's
 *     `InventoryServiceApi` has no per-position inventory at all — see the
 *     boundary note on `ContainerSlot` in `domain/comparator.ts`, which is the
 *     same missing `inventoryAt(BlockPosition)`.
 *   - the DROP. `EntityManagerApi.spawn` exists
 *     (`mc-sim/application/entity-manager.ts:100`) and cannot be called from
 *     here: it takes `SpawnRequest<S>` (`mc-sim/domain/entity.ts:347-352`) whose
 *     `behaviour: S` is, in mc-sim's own words, "whatever the rules tier stores
 *     per entity — for a creeper this is mx-gameplay's `CreeperFuse`". Naming
 *     `S` means importing a sibling experience module, and the edge count
 *     between experience modules is zero (plan.md §2.3-1). A dispenser that
 *     spawns a drop is therefore mx-gameplay's rule reacting to redstone's
 *     event, not redstone's rule reaching into mx-gameplay.
 *   - the PROJECTILE. The reference fires arrows by hitscanning over
 *     `entityManager.getEntities()` and calling `applyDamage`
 *     (`redstone-dispenser-world-effects.ts:90-115`). Damage numbers are
 *     explicitly not mc-sim's either — `mc-sim/domain/entity.ts` says
 *     「剣が何ダメージか」「落下で何ダメージか」 is mx-gameplay's — so an arrow's five
 *     points would be a redstone repository inventing a combat constant.
 *
 * What crosses the boundary is the list below: positions that fired, this tick.
 * That is an EVENT, it names nothing outside this repository, and it is the
 * smallest thing that lets the rule live here and the consequence live there.
 */
import type { PositionKey } from './position-key.js'

/** Whether each dispenser was powered on the tick that just finished. */
export type PowerEdgeMemory = ReadonlyMap<PositionKey, boolean>

export type DispenserSweep = {
  /** Dispensers that fire this tick, in key order. */
  readonly fired: ReadonlyArray<PositionKey>
  /** What to pass as `previous` next tick. Entries for departed dispensers are gone. */
  readonly powered: PowerEdgeMemory
}

/**
 * Which dispensers fire, given who is powered now and who was powered before.
 *
 * An ABSENT previous entry counts as unpowered, which means a dispenser placed
 * into a circuit that is already live fires immediately. That is deliberate and
 * it is the opposite of the observer's first-sighting rule
 * (`domain/observer.ts`), so it is worth being explicit about why the two differ:
 *
 *   - an observer watches a block, and a block that was already there did not
 *     change. Arming without firing is the only reading of "no change".
 *   - a dispenser watches ITSELF, and a dispenser that has just been placed was
 *     unpowered a moment ago because it did not exist. The edge is real, vanilla
 *     fires it, and a player placing a dispenser into a powered circuit expects
 *     it to go off.
 *
 * The asymmetry is not an accident of implementation; both are what the player
 * sees. `test/dispenser.test.ts` pins both halves so that "making them
 * consistent" is a failing test rather than a tidy-up.
 */
export const dispenserEdges = (
  current: ReadonlyMap<PositionKey, boolean>,
  previous: PowerEdgeMemory,
): DispenserSweep => {
  const fired: Array<PositionKey> = []
  const powered = new Map<PositionKey, boolean>()

  for (const [key, isPowered] of current) {
    powered.set(key, isPowered)
    if (isPowered && previous.get(key) !== true) {
      fired.push(key)
    }
  }

  return { fired: fired.sort(), powered }
}
