/**
 * Every `StageId` this repository writes down, in one file.
 *
 * See `../domain/frame-contract.ts` for why a stage id is a string and what
 * that implies: naming one creates no import and no dependency edge, so an
 * `after` constraint is invisible to `pnpm check:deps`. Collecting them here is
 * what makes them reviewable, and `test/stage-registration.test.ts` fails if one
 * points at a sibling experience module.
 */
import { StageId } from '../domain/frame-contract'

/**
 * Stages owned by mx-redstone.
 *
 * plan.md §4.2 places `redstone` inside the simulation block:
 *
 *     input -> simulation(physics -> interactions -> entities -> fluids ->
 *     redstone -> time/weather) -> camera-mirror -> chunk-sync -> render ->
 *     post-fx -> hud-sync
 *
 * Note that this repository does NOT declare itself to be after `fluids` or
 * before `time/weather`, even though the skeleton says so. Both of those are
 * mx-gameplay's stages, and an `after` edge naming one would couple redstone's
 * frame position to the existence of another experience module. The skeleton is
 * mc-compose's to state (plan.md §2.3-3); mx-redstone states only what its own
 * correctness requires.
 *
 * Two stages rather than one, split at the point where purity ends: `power` is
 * a pure recomputation of the graph, `effects` is where the results become
 * world mutations. That boundary is the reason the whole power graph is
 * testable without a world.
 */
export const REDSTONE_STAGE_IDS = {
  /**
   * Recompute the power map for one redstone tick. Pure; touches nothing
   * outside this module's own state.
   */
  power: StageId('redstone:power'),
  /**
   * Apply the consequences: extend and retract pistons, light lamps, fire
   * dispensers and droppers, move hoppers, trigger observers. Every one of
   * those is a write through mc-sim.
   */
  effects: StageId('redstone:effects'),
} as const

/**
 * Stages owned by OTHER repositories that mx-redstone orders itself against.
 *
 * `sim:physics` only, and deliberately the minimum. A pressure plate reads
 * entity positions, so the power sweep must see this frame's positions rather
 * than last frame's — otherwise a player standing on a plate gets a one-frame
 * flicker every time they move, which is exactly the kind of bug that is
 * invisible in a test and obvious in a preview.
 */
export const UPSTREAM_STAGE_IDS = {
  simPhysics: StageId('sim:physics'),
} as const

/**
 * The `<repo>:` prefixes belonging to the four experience modules (plan.md
 * §2.2). Used by the regression test that enforces §2.3-1's zero-edge rule at
 * the ordering level as well as at the import level.
 */
export const EXPERIENCE_MODULE_STAGE_PREFIXES = ['gameplay:', 'redstone:', 'ui:', 'multiplayer:'] as const

/** This repository's own prefix, excluded when checking for sibling edges. */
export const OWN_STAGE_PREFIX = 'redstone:'
