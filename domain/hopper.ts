/**
 * The hopper: the one component that power SWITCHES OFF.
 *
 * Every other component in this repository does something when power arrives. A
 * hopper does something all the time and STOPS when power arrives — a powered
 * hopper is locked, and vanilla item filters are built out of exactly that
 * inversion. It is the only place in the redstone rules where `powered` reads as
 * "no", and a reader who assumes the usual direction writes a filter that is
 * open when it should be shut.
 *
 * That inversion, and the cadence below, are what this repository owns about a
 * hopper. Moving the items is somebody else's, and the boundary is precise
 * rather than pending — see the bottom of this file.
 *
 * ---------------------------------------------------------------------------
 * The cadence is a rule; the counter is the caller's
 * ---------------------------------------------------------------------------
 *
 * A hopper moves one item every eight game ticks, which is four redstone ticks
 * at the 10 Hz rate `stages/registration.ts` runs (`REDSTONE_TICK_SECS = 0.1`).
 * The PERIOD is a rule and lives here. The count of ticks since the last
 * transfer is REMAINING TIME, which is state, and this repository has said three
 * times now where that goes: not in the power map, which has no cell for it, and
 * not in the board, which is an input this module may not rewrite. The button's
 * pulse (`sourcesOf` in `domain/power-graph.ts`) and the observer's
 * (`OBSERVER_PULSE_TICKS`) got the same answer. `hopperTransferDue` therefore
 * takes the count and returns a verdict.
 *
 * The reference models neither. `redstone-hopper-world-effects.ts:11-14` opens
 * with 「Vanilla hoppers keep an internal buffer; this model transfers directly」
 * and moves everything within reach on every frame — no lock, no period, and no
 * mention of either. A hopper that ignores its lock is not a slow hopper, it is
 * a hopper that cannot be used as a filter, and every sorting machine in the
 * game is a filter.
 */

/**
 * Redstone ticks between one transfer and the next.
 *
 * Vanilla's hopper cooldown is eight GAME ticks (20 Hz) and redstone runs at
 * half that rate, so four. Written as the redstone-tick count rather than as
 * eight-game-ticks-divided-by-two because this repository counts in redstone
 * ticks everywhere and a division in a constant is a place for the two clocks to
 * be confused (`domain/power-graph.ts`: 「There is NO clock」 — delays are counted
 * in invocations of `propagateTick`, never in seconds).
 */
export const HOPPER_TRANSFER_PERIOD_TICKS = 4

/** How many items move per transfer. One, in vanilla, and it matters: see below. */
export const HOPPER_TRANSFER_ITEMS = 1

/**
 * A powered hopper is LOCKED.
 *
 * A one-line function for a one-line rule, and it earns the line by being the
 * only place the inversion is written down. The alternative is `if (!powered)`
 * scattered across the effects stage, where the missing `!` is invisible to a
 * reader who knows how every other component behaves.
 */
export const isHopperLocked = (powered: boolean): boolean => powered

/**
 * Whether a hopper moves an item this tick.
 *
 * A locked hopper transfers nothing AND — the part that is easy to get wrong —
 * its cooldown does not advance meaningfully while it is locked, because the
 * caller stops resetting it. Unlocking one that has been powered for a minute
 * therefore transfers immediately rather than after a further four ticks, which
 * is what vanilla does and what makes a redstone-clocked filter emit one item
 * per pulse instead of one item per pulse that happens to land on the cadence.
 *
 * `ticksSinceTransfer` is compared with `>=` rather than `===` on purpose. A
 * caller that skipped ticks — `stages/registration.ts` runs up to
 * `MAX_TICKS_PER_FRAME` of them in a loop and DISCARDS the excess after a long
 * frame (DN-RS-3) — must not end up with a hopper that has stepped over its own
 * deadline and waits forever for a number it will never see again.
 */
export const hopperTransferDue = (options: {
  readonly powered: boolean
  readonly ticksSinceTransfer: number
}): boolean =>
  !isHopperLocked(options.powered) &&
  options.ticksSinceTransfer >= HOPPER_TRANSFER_PERIOD_TICKS

/*
 * ---------------------------------------------------------------------------
 * BOUNDARY: the transfer itself
 * ---------------------------------------------------------------------------
 *
 * `hopperTransferDue` says WHEN. Moving an item needs two things this repository
 * does not have, and inventing either would fork a vocabulary
 * (docs/responsibility.md §2 puts both in mc-sim):
 *
 *   - a container at a position. mc-sim's `InventoryServiceApi`
 *     (`application/inventory-service.ts:17-53`) is the PLAYER's inventory and
 *     nothing else: `add`, `remove`, `countOf` and `snapshot` take an item and a
 *     count, never a position. `Inventory` (`mc-sim/domain/inventory.ts:112`) is
 *     a bare `ReadonlyArray<Slot>` with no identity attached. The missing query
 *     is `inventoryAt(BlockPosition)` — the same one `domain/comparator.ts`
 *     needs, which is worth noticing: a comparator reading a chest and a hopper
 *     draining one are blocked on ONE addition, not two.
 *   - the item vocabulary. `ItemType` is mc-kernel's closed union
 *     (`domain/item-type.ts:128`), mirrored by mc-sim in
 *     `domain/kernel-vocabulary.ts`. This repository declares no
 *     `@nerima-games/*` dependency yet (docs/responsibility.md §3, 現状), and
 *     `domain/block-ref.ts` explains why a local stand-in is acceptable for a
 *     token that is only ever compared and not acceptable for one that would be
 *     enumerated.
 *
 * `HOPPER_TRANSFER_ITEMS` is here rather than at the call site for the reason
 * `PISTON_PUSH_LIMIT` is: it is a RULE about how a hopper behaves, not a fact
 * about what an item is, and the split between the two is what keeps the block
 * and item rosters out of this repository entirely.
 */
