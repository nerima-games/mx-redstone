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
 * The public API is stage registration, the world runtime and host ports, and
 * the piston planning operations used by the W5 host. Other names re-exported
 * from domain modules are visible for this package's tests and preview, not
 * stable contracts.
 * ---------------------------------------------------------------------------
 *
 * `domain/power-graph.ts` and `domain/piston.ts` are re-exported below because
 * this repository's tests and circuit-board preview import their symbols by name.
 * W5 also uses selected piston operations from the root entry point. The exact
 * contract names are listed in docs/public-api.md; remaining domain exports stay
 * visible for internal use.
 *
 * It knows nothing of mx-gameplay, mx-ui or mx-multiplayer. A piston that shoves
 * a player is a write to mc-sim's entity state, observed later by whichever rule
 * cares — never a call into a sibling.
 */

export {
  RedstoneWorldRuntime,
  RedstoneWorldRuntimeLayer,
} from './application/world-runtime.js'
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
} from './application/world-runtime.js'
export {
  applyRedstoneHostEvents,
  componentForBlock,
  kernelPistonCapabilities,
  redstoneSnapshotFromRealm,
} from './application/redstone-host-port.js'
export type {
  RedstoneHostBlock,
  RedstoneHostLookup,
  RedstoneHostRealm,
  RedstoneHostWritePort,
} from './application/redstone-host-port.js'

export * from './domain/comparator.js'
export * from './domain/dispenser.js'
export * from './domain/hopper.js'
export * from './domain/observer.js'
export * from './domain/piston.js'
export * from './domain/power-graph.js'
export * from './domain/power-timing.js'
export * from './domain/pressure-plate.js'
export * from './domain/target-block.js'
export * from './stages/registration.js'
export * from './stages/stage-ids.js'

// --- Provisional ---------------------------------------------------------------
// Frame-stage vocabulary is imported from @nerima-games/mc-kernel and is NOT
// Re-exported here. `StageId`, `DeltaTimeSecs` and `StageRegistration` belong to
// The kernel package; keeping them out of this barrel prevents this package from
// Becoming a second owner of that public contract. `domain/position-key.ts`
// Remains a separate local provisional implementation.
