/**
 * The mx-redstone module's contribution to the frame (plan.md §4.1).
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
import type { DeltaTimeSecs, GameModule, StageRegistration } from '@nerima-games/mc-kernel'
import { Effect, Option, Ref } from 'effect'
import { REDSTONE_STAGE_IDS, UPSTREAM_STAGE_IDS } from './stage-ids'
import {
  RedstoneWorldRuntime,
  RedstoneWorldRuntimeLayer,
  type RedstoneWorldState,
  collectHopperTransferEvents,
  collectLampTransitions,
  collectPistonTransitions,
  collectPoweredComponentTransitions,
  collectTriggerEvents,
  makeRedstoneWorldState,
  redstoneWorldStateFor,
} from '../application/world-runtime'
import { type TimedCircuitState, advanceTimedCircuit } from '../domain/timed-power-graph'
import type { CircuitBoard } from '../domain/power-graph'
import type { PositionKey } from '../domain/position-key'

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
  adjacency: new Map(),
  components: new Map(),
}

export type RedstoneFrameState = RedstoneWorldState

/**
 * An Effect rather than a constant, so a test, a preview and the game can each
 * hold their own. plan.md §3.8 records app-scope singletons as among the
 * reference's worst bug sources: a second world load inherited the first
 * world's refs and deadlocked.
 */
export const makeRedstoneFrameState: Effect.Effect<RedstoneFrameState> = makeRedstoneWorldState

/** How many ticks a frame contributes when `tickSecs` is misconfigured, or when nothing is due yet. */
const NO_TICKS = 0

/** A tick duration at or below this is misconfigured; treat the frame as advancing no ticks at all. */
const NON_POSITIVE_TICK_SECS = 0

/** `dt` never runs backwards: floor it here rather than trust that upstream's clamp always ran. */
const MIN_DELTA_SECS = 0

/** What the leftover time becomes when the per-frame tick cap bites: discarded, not banked. */
const DISCARDED_REMAINDER_SECS = 0

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
  if (tickSecs <= NON_POSITIVE_TICK_SECS) {
    return { remainderSecs: accumulatedSecs, ticks: NO_TICKS }
  }

  const available = accumulatedSecs + Math.max(MIN_DELTA_SECS, dt)
  const wanted = Math.floor(available / tickSecs)
  const ticks = Math.min(wanted, maxTicks)

  // When the cap bites, the un-run time is DISCARDED rather than banked.
  // Banking it guarantees the next frame is also over budget, which is the
  // Spiral of death.
  const remainderAfterCap = (): number => {
    if (wanted > maxTicks) {
      return DISCARDED_REMAINDER_SECS
    }
    return available - ticks * tickSecs
  }
  const remainderSecs = remainderAfterCap()

  return { remainderSecs, ticks }
}

/** The first tick a frame runs; only this one gets the frame's pressed buttons. */
const FIRST_TICK_INDEX = 0

/** How much the tick counter advances per loop iteration. */
const TICK_STEP = 1

/**
 * Runs `board` forward `ticks` redstone ticks from `seed.timed`, feeding the
 * frame's pressed buttons into only the first one — the rest see none, since
 * a button press is a one-tick edge and not a held condition.
 *
 * Pure and separate from the effectful stage below so that stage's statement
 * count stays under the threshold; the loop itself is unchanged. `timed` and
 * `pressedButtons` travel together in `seed` so the parameter count stays
 * under its own threshold.
 */
const advancePower = (
  board: CircuitBoard,
  ticks: number,
  seed: { readonly timed: TimedCircuitState; readonly pressedButtons: ReadonlySet<PositionKey> },
): TimedCircuitState => {
  const buttonsForTick = (tick: number): ReadonlySet<PositionKey> => {
    if (tick === FIRST_TICK_INDEX) {
      return seed.pressedButtons
    }
    return new Set()
  }

  let next = seed.timed
  for (let tick = FIRST_TICK_INDEX; tick < ticks; tick += TICK_STEP) {
    next = advanceTimedCircuit(board, next, buttonsForTick(tick))
  }
  return next
}

/**
 * Writes one tick's outcome back into `state` and drains the hopper cadence.
 * Split out of the power stage's `run` for the same statement-count reason
 * `advancePower` is; the writes and their order are unchanged.
 */
const commitPowerTick = (state: RedstoneFrameState, next: TimedCircuitState, ticks: number) =>
  Effect.gen(function* commitPowerTickEffect() {
    yield* Ref.set(state.timedCircuit, next)
    yield* Ref.set(state.power, next.power)
    yield* collectHopperTransferEvents(state, ticks)
    yield* Ref.update(state.tickCount, (count) => count + ticks)
  })

/**
 * The two stages mx-redstone registers.
 *
 * Neither one resolves an order. Each carries `after` constraints; mc-compose
 * topologically sorts the union of every module's registrations (plan.md
 * §2.3-3). The array order here is for human reading only.
 */
export const redstoneStages = (state: RedstoneFrameState): ReadonlyArray<StageRegistration> => [
  {
    after: [UPSTREAM_STAGE_IDS.simPhysics],
    id: REDSTONE_STAGE_IDS.power,
    run: (dt: DeltaTimeSecs) =>
      Effect.gen(function* advancePowerStage() {
        const accumulated = yield* Ref.get(state.tickAccumulatorSecs)
        const { ticks, remainderSecs } = ticksForFrame(accumulated, dt)
        yield* Ref.set(state.tickAccumulatorSecs, remainderSecs)

        if (ticks === NO_TICKS) {
          return
        }

        const board = yield* Ref.get(state.board)
        // Each tick reads the PREVIOUS map: that one-tick lag is what makes a
        // Torch invert and therefore what makes every clock circuit work. See
        // `domain/power-graph.ts`.
        const pressedButtons = yield* Ref.getAndSet(state.pendingButtonPresses, new Set())
        const timed = yield* Ref.get(state.timedCircuit)
        const next = advancePower(board, ticks, { pressedButtons, timed })
        yield* commitPowerTick(state, next, ticks)
      }),
  },
  {
    after: [REDSTONE_STAGE_IDS.power],
    id: REDSTONE_STAGE_IDS.effects,
    // Observable state transitions are recorded after power settles. The host
    // Drains these records and applies world changes; this runtime never mutates
    // World blocks directly, which keeps the graph a pure function.
    //
    // The DECISIONS those effects need are now all written and tested:
    // `domain/observer.ts` says which observers fired, `domain/dispenser.ts`
    // Which dispensers saw a rising edge, `domain/hopper.ts` which hoppers are
    // Locked and when they are due, `domain/pressure-plate.ts` how many
    // Occupants are worth how much signal, and `domain/comparator.ts` what a
    // Container reading means. Every one of them is a pure function whose
    // Memory is a VALUE — deliberately, because the reference held the
    // Observer's and the dispenser's in module-level `Map`s with reset
    // Functions beside them, and this stage is built from per-call `Ref`s for
    // The reason DN-RS-8 gives.
    //
    // Hopper cadence is recorded in the power stage. The host drains it through
    // The runtime and applies inventory changes via its own typed boundary.
    run: () => Effect.all([
      collectLampTransitions(state),
      collectPistonTransitions(state),
      collectTriggerEvents(state),
      collectPoweredComponentTransitions(state),
    ], { discard: true }),
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
 * The mx-redstone module as a `GameModule` (plan.md §4.1).
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
  frameStages: makeRuntimeRedstoneStages,
  layers: RedstoneWorldRuntimeLayer,
}
