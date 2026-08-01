/**
 * mx-redstone's contribution to the frame (plan.md §4.1).
 *
 * This module is the ENTIRE public surface of the repository. plan.md §3.12
 * spells it out: 「主要な公開API: stage登録のみ(電力グラフは内部実装)」. Nothing
 * else here is a contract — `domain/power-graph.ts` and `domain/piston.ts` are
 * exported so that this repository's own tests and its circuit-board preview can
 * drive them, not so that another repository can. See docs/public-api.md.
 *
 * ---------------------------------------------------------------------------
 * Redstone ticks versus frames
 * ---------------------------------------------------------------------------
 *
 * Vanilla runs redstone at a fixed rate (10 Hz, "redstone ticks"), independent
 * of frame rate. Advancing the power graph once per FRAME would make a repeater
 * chain propagate faster on a fast machine, which breaks every timing circuit a
 * player has built and is not detectable by a unit test.
 *
 * `REDSTONE_TICK_SECS` and `RedstoneFrameState.tickAccumulatorSecs` exist for
 * exactly that. The accumulator carries the remainder across frames, so the
 * long-run tick rate is exact rather than losing up to one tick's worth of time
 * every frame. `dt` is clamped upstream by mc-sim
 * (plan.md §3.4: `min(max(0.001, raw), 0.05)`), so a debugger pause cannot
 * deliver a ten-second dt here and fire a hundred ticks at once — but the loop
 * below is bounded anyway, because relying on somebody else's clamp is how you
 * discover it was removed.
 */
import { Effect, Option, Ref } from 'effect'
import {
  collectLampTransitions,
  makeRedstoneWorldState,
  RedstoneWorldRuntime,
  RedstoneWorldRuntimeLayer,
  redstoneWorldStateFor,
  type RedstoneWorldState,
} from '../application/world-runtime'
import type { DeltaTimeSecs, GameModule, StageRegistration } from '../domain/frame-contract'
import { propagateTick, type CircuitBoard } from '../domain/power-graph'
import { REDSTONE_STAGE_IDS, UPSTREAM_STAGE_IDS } from './stage-ids'

/** Vanilla redstone runs at 10 Hz: one tick every two game ticks. */
export const REDSTONE_TICK_SECS = 0.1

/**
 * Upper bound on redstone ticks executed in a single frame.
 *
 * A catch-up loop with no bound turns one long frame into a longer one, which
 * produces the next long frame — the classic spiral of death. Dropping the
 * excess makes redstone run slow for one frame, which a player will not see;
 * the alternative is a freeze, which they will.
 */
export const MAX_TICKS_PER_FRAME = 4

/**
 * The empty board.
 *
 * A real board is assembled by reading redstone components out of mc-worldgen's
 * chunks; the first cut holds it in a `Ref` so that the circuit-board preview
 * and the scenario tests can install a fixture directly.
 */
export const emptyCircuitBoard: CircuitBoard = {
  components: new Map(),
  adjacency: new Map(),
}

export type RedstoneFrameState = RedstoneWorldState

/**
 * An Effect rather than a constant, so a test, a preview and the game can each
 * hold their own. plan.md §3.8 records app-scope singletons as among the
 * reference's worst bug sources: a second world load inherited the first
 * world's refs and deadlocked.
 */
export const makeRedstoneFrameState: Effect.Effect<RedstoneFrameState> = makeRedstoneWorldState

/**
 * How many redstone ticks a frame of `dt` seconds is worth, and what is left
 * over.
 *
 * Pure and exported so the fixed-rate behaviour is testable without running a
 * frame. Returning the remainder rather than resetting it to zero is the whole
 * point: at 60 fps a frame is 1.67 redstone ticks, and discarding the 0.67
 * would make redstone run at 6 Hz instead of 10.
 */
export const ticksForFrame = (
  accumulatedSecs: number,
  dt: number,
  options: { readonly tickSecs?: number; readonly maxTicks?: number } = {},
): { readonly ticks: number; readonly remainderSecs: number } => {
  const tickSecs = options.tickSecs ?? REDSTONE_TICK_SECS
  const maxTicks = options.maxTicks ?? MAX_TICKS_PER_FRAME
  if (tickSecs <= 0) {
    return { ticks: 0, remainderSecs: accumulatedSecs }
  }

  const available = accumulatedSecs + Math.max(0, dt)
  const wanted = Math.floor(available / tickSecs)
  const ticks = Math.min(wanted, maxTicks)

  // When the cap bites, the un-run time is DISCARDED rather than banked.
  // Banking it guarantees the next frame is also over budget, which is the
  // spiral of death.
  const remainderSecs = wanted > maxTicks ? 0 : available - ticks * tickSecs

  return { ticks, remainderSecs }
}

/**
 * The two stages mx-redstone registers.
 *
 * Neither one resolves an order. Each carries `after` constraints; mc-compose
 * topologically sorts the union of every module's registrations (plan.md
 * §2.3-3). The array order here is for human reading only.
 */
export const redstoneStages = (state: RedstoneFrameState): ReadonlyArray<StageRegistration> => [
  {
    id: REDSTONE_STAGE_IDS.power,
    after: [UPSTREAM_STAGE_IDS.simPhysics],
    run: (dt: DeltaTimeSecs) =>
      Effect.gen(function* () {
        const accumulated = yield* Ref.get(state.tickAccumulatorSecs)
        const { ticks, remainderSecs } = ticksForFrame(accumulated, dt)
        yield* Ref.set(state.tickAccumulatorSecs, remainderSecs)

        if (ticks === 0) {
          return
        }

        const board = yield* Ref.get(state.board)
        // Each tick reads the PREVIOUS map: that one-tick lag is what makes a
        // torch invert and therefore what makes every clock circuit work. See
        // domain/power-graph.ts.
        yield* Ref.update(state.power, (previous) => {
          let power = previous
          for (let tick = 0; tick < ticks; tick += 1) {
            power = propagateTick(board, power)
          }
          return power
        })
        yield* Ref.update(state.tickCount, (count) => count + ticks)
      }),
  },
  {
    id: REDSTONE_STAGE_IDS.effects,
    after: [REDSTONE_STAGE_IDS.power],
    // Lamp transitions are recorded here after power settles for the frame.
    // Piston extension/retraction (domain/piston.ts), dispensers, droppers,
    // hoppers and observers will also be applied here through their host ports.
    // Keeping effects separate leaves the graph a pure function.
    //
    // The DECISIONS those effects need are now all written and tested:
    // `domain/observer.ts` says which observers fired, `domain/dispenser.ts`
    // which dispensers saw a rising edge, `domain/hopper.ts` which hoppers are
    // locked and when they are due, `domain/pressure-plate.ts` how many
    // occupants are worth how much signal, and `domain/comparator.ts` what a
    // container reading means. Every one of them is a pure function whose
    // memory is a VALUE — deliberately, because the reference held the
    // observer's and the dispenser's in module-level `Map`s with reset
    // functions beside them, and this stage is built from per-call `Ref`s for
    // the reason DN-RS-8 gives.
    //
    // What is missing is not effort, it is six named things that do not exist:
    // `InventoryServiceApi.inventoryAt(position)`, a per-item `maxStackSize`,
    // `EntityManagerApi.entitiesWithin(bounds)`, an entity extent, kernel's
    // `Position`, and an owner for the dropped-item `behaviour` payload that is
    // not a sibling experience module. docs/design-notes.md DN-RS-17 has the
    // table, with the file and line where each one is absent.
    //
    // Three of the six are ONE addition: a comparator reading a chest, a hopper
    // draining one and a dispenser drawing from one are all blocked on
    // `inventoryAt`. When this stage acquires mc-sim's services in
    // `frameStages`, that is the first thing to ask for.
    run: () => collectLampTransitions(state),
  },
]

/**
 * Build the module's state and its stages together.
 *
 * This is exactly `GameModule.frameStages` — see `redstoneModule` below.
 */
export const makeRedstoneStages: Effect.Effect<ReadonlyArray<StageRegistration>> = Effect.map(
  makeRedstoneFrameState,
  redstoneStages,
)

/** Registers stages over the same service instance that the host syncs and drains. */
export const makeRuntimeRedstoneStages: Effect.Effect<
  ReadonlyArray<StageRegistration>
> = Effect.flatMap(
  Effect.serviceOption(RedstoneWorldRuntime),
  Option.match({
    onNone: () => makeRedstoneStages,
    onSome: (runtime) => Effect.succeed(redstoneStages(redstoneWorldStateFor(runtime))),
  }),
)

/**
 * mx-redstone as a `GameModule` (plan.md §4.1).
 *
 * Its Layer provides the runtime port used by a host to replace dimension
 * snapshots and drain lamp transitions. Registration uses that same service
 * when the host supplies it. `serviceOption` retains a state-private fallback
 * for older hosts that still evaluate `frameStages` before composing layers;
 * those hosts keep booting but cannot use the new synchronization port until
 * they wire the Layer into registration.
 */
export const redstoneModule: GameModule<
  RedstoneWorldRuntime,
  never,
  never,
  never
> = {
  layers: RedstoneWorldRuntimeLayer,
  frameStages: makeRuntimeRedstoneStages,
}
