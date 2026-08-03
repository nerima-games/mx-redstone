/**
 * @nerima-games/mx-redstone — the redstone mechanism.
 *
 * PRE-IMPLEMENTATION FIRST CUT (叩き台). See README.md 現状.
 *
 * mx-redstone is an EXPERIENCE MODULE: a verb (plan.md §2.3-1). It owns the rule
 * "power flows like this" — wire propagation, torches, levers, buttons,
 * repeaters, piston pushing — and owns only derived runtime state. The blocks
 * it reads and the entities it shoves belong to mc-worldgen and mc-sim.
 *
 * ---------------------------------------------------------------------------
 * The public API is stage registration. Everything else is visible, not public.
 * ---------------------------------------------------------------------------
 *
 * plan.md §3.12: 「主要な公開API: stage登録のみ(電力グラフは内部実装)」.
 *
 * `domain/power-graph.ts` and `domain/piston.ts` are re-exported below because
 * this repository's tests and its circuit-board preview import them by name, and
 * a package that lies about its own entry point is worse than one that exports
 * too much. But no other repository may depend on them: the power graph's shape
 * is expected to change as circuits get faster, and it must be able to change
 * without a coordinated release. docs/public-api.md is the authority on which
 * of these names is a contract.
 *
 * It knows nothing of mx-gameplay, mx-ui or mx-multiplayer. A piston that shoves
 * a player is a write to mc-sim's entity state, observed later by whichever rule
 * cares — never a call into a sibling.
 */

export {
  RedstoneWorldRuntime,
  RedstoneWorldRuntimeLayer,
} from './application/world-runtime'
export type {
  LampTransition,
  HopperTransferEvent,
  PoweredComponentKind,
  PoweredComponentTransition,
  PoweredPistonTransition,
  RedstoneComponentSnapshot,
  RedstonePosition,
  RedstoneTriggerEvent,
  RedstoneWorldRuntimeService,
  RedstoneWorldSnapshot,
  TriggeredComponentKind,
} from './application/world-runtime'

export * from './domain/comparator'
export * from './domain/dispenser'
export * from './domain/hopper'
export * from './domain/observer'
export * from './domain/piston'
export * from './domain/power-graph'
export * from './domain/timed-power-graph'
export * from './domain/pressure-plate'
export * from './domain/target-block'
export * from './stages/registration'
export * from './stages/stage-ids'

// --- Provisional ---------------------------------------------------------------
// `domain/frame-contract.ts` and `domain/position-key.ts` are temporary local
// stand-ins for @nerima-games/mc-kernel and are NOT re-exported. Both carry a
// deletion date — see the "WHY THIS FILE EXISTS AND WHEN IT DIES" header on the
// first — and re-exporting them would make `StageId`, `DeltaTimeSecs` and
// `StageRegistration` published API of a package that does not own them, so
// deleting the stand-in would become a breaking change for every consumer.
// Consumers take that vocabulary from kernel; the types are structurally
// identical, so a consumer importing them from kernel typechecks against the
// signatures below. Same call, and the same reason, as mc-sim's and
// mc-render's barrels.
