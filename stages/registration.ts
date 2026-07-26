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
import { Effect, Layer, Ref } from 'effect'
import type { DeltaTimeSecs, GameModule, StageRegistration } from '../domain/frame-contract'
import {
  emptyPowerMap,
  propagateTick,
  type CircuitBoard,
  type PowerMap,
} from '../domain/power-graph'
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

export type RedstoneFrameState = {
  readonly board: Ref.Ref<CircuitBoard>
  readonly power: Ref.Ref<PowerMap>
  /** Seconds of unconsumed simulation time. */
  readonly tickAccumulatorSecs: Ref.Ref<number>
  /** Redstone ticks executed since this state was created. Diagnostics only. */
  readonly tickCount: Ref.Ref<number>
}

/**
 * An Effect rather than a constant, so a test, a preview and the game can each
 * hold their own. plan.md §3.8 records app-scope singletons as among the
 * reference's worst bug sources: a second world load inherited the first
 * world's refs and deadlocked.
 */
export const makeRedstoneFrameState: Effect.Effect<RedstoneFrameState> = Effect.gen(function* () {
  const board = yield* Ref.make<CircuitBoard>(emptyCircuitBoard)
  const power = yield* Ref.make<PowerMap>(emptyPowerMap)
  const tickAccumulatorSecs = yield* Ref.make(0)
  const tickCount = yield* Ref.make(0)

  return { board, power, tickAccumulatorSecs, tickCount }
})

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
    // FIRST CUT: piston extension/retraction (domain/piston.ts), lamp lighting,
    // dispensers, droppers, hoppers and observers are applied here, each as a
    // write through mc-sim. They are separated from `power` so that the graph
    // stays a pure function — the reference's six `redstone-*-world-effects.ts`
    // files (618 LOC) are the shape this stage grows into.
    run: () => Effect.void,
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

/**
 * mx-redstone as a `GameModule` (plan.md §4.1).
 *
 * This used to say "not yet a `GameModule`: that type carries a
 * `Layer.Layer<ROut, E, RIn>`, and `RIn` cannot be named until mc-sim's public
 * API exists". The diagnosis was half right, and the half that was wrong is the
 * interesting one.
 *
 * The Layer was never the obstacle. plan.md §3.12 is explicit that this
 * repository's only public API is stage registration — the power graph is
 * internal — so mx-redstone provides no service and its Layer is empty. The
 * obstacle was that `frameStages` was an ARRAY, and these stages are built from
 * `Ref`s allocated in an Effect. Publishing mc-sim would not have changed that;
 * the vertical-slice spike making `frameStages` an Effect did.
 *
 * `RIn` is `never` and stays `never`. When `redstone:effects` starts writing
 * pistons and lamps through mc-sim, it will acquire those services in
 * `frameStages` — the `RRegister` parameter — because this repository does not
 * BUILD anything mc-sim has to supply, it CALLS things mc-sim supplies.
 */
export const redstoneModule: GameModule<never, never, never> = {
  layers: Layer.empty,
  frameStages: makeRedstoneStages,
}
