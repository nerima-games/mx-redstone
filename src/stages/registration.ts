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
 * Redstone ticks versus simulation ticks
 * ---------------------------------------------------------------------------
 *
 * mc-sim invokes this registration once for every fixed 50 ms game tick. A
 * redstone tick is two game ticks, so the power stage advances on every second
 * invocation and ignores the frame delta.
 */
import {
  type DeltaTimeSecs,
  type GameModule,
  NonNegativeTickCount,
  type StageRegistration,
} from '@nerima-games/mc-kernel'
import { Effect, Option, Ref, Schema } from 'effect'
import { REDSTONE_STAGE_IDS, UPSTREAM_STAGE_IDS } from './stage-ids.js'
import {
  type RedstoneObservationTickContext,
  type RedstonePowerTickContextBundle,
  RedstoneWorldRuntime,
  RedstoneWorldRuntimeLayer,
  type RedstoneWorldRuntimeStateError,
  type RedstoneWorldState,
  captureObservedTick,
  collectHopperTransferEvents,
  collectLampTransitions,
  collectPistonTransitions,
  collectPoweredComponentTransitions,
  collectTriggerEvents,
  makeRedstoneWorldState,
  redstonePowerTickContextFactoryFor,
  redstoneWorldStateFor,
} from '../application/world-runtime.js'
import {
  type TimedCircuitState,
  type TimedCircuitWithBlockPower,
  advanceTimedCircuit,
  advanceTimedCircuitWithContext,
  advanceTimedCircuitWithProvenanceContext,
} from '../domain/power-timing.js'

type CircuitBoard = import('../domain/power-graph.js').CircuitBoard
type PowerTickWithProvenance = import('../domain/power-graph.js').PowerTickWithProvenance
type PositionKey = import('../domain/position-key.js').PositionKey

const ZERO_TICK_COUNT = 0
const nonNegativeTickCountSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(ZERO_TICK_COUNT))
  .pipe(Schema.fromBrand('NonNegativeTickCount', NonNegativeTickCount))
const nonNegativeTickCountFromNumber = Schema.decodeUnknownSync(nonNegativeTickCountSchema)
const ONE_REDSTONE_TICK_COUNT = 1


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


/** One completed redstone tick advances world timers once. */
const ONE_TICK = nonNegativeTickCountFromNumber(ONE_REDSTONE_TICK_COUNT)

/** One redstone-tick advance and its matching host-event snapshot. */
type AdvancedPowerTick =
  | {
      readonly timedCircuit: TimedCircuitState
      readonly blockPower: TimedCircuitWithBlockPower['blockPower']
      readonly context: RedstoneObservationTickContext
      readonly observation: PowerTickWithProvenance
    }
  | {
      readonly timedCircuit: TimedCircuitState
      readonly blockPower: TimedCircuitWithBlockPower['blockPower']
      readonly context: Extract<RedstonePowerTickContextBundle, { readonly captureProvenance: false }>
      readonly observation?: never
    }

type AdvancedPowerTickResult =
  | { readonly mode: 'timed-only'; readonly timedCircuit: TimedCircuitState }
  | { readonly mode: 'block-power'; readonly tick: AdvancedPowerTick }

const timedCircuitWithoutBlockPower = (timedCircuit: TimedCircuitWithBlockPower): TimedCircuitState => ({
  buttons: timedCircuit.buttons,
  observerSeen: timedCircuit.observerSeen,
  observers: timedCircuit.observers,
  power: timedCircuit.power,
  repeaters: timedCircuit.repeaters,
  torches: timedCircuit.torches,
})

const advancePowerTick = (input: Readonly<{
  state: RedstoneFrameState
  board: CircuitBoard
  timedCircuit: TimedCircuitState
  pressedButtons: ReadonlySet<PositionKey>
}>, context: RedstonePowerTickContextBundle): AdvancedPowerTick => {
  if (context.captureProvenance) {
    const advanced = advanceTimedCircuitWithProvenanceContext({
      board: input.board,
      context: context.context,
      pressedButtons: input.pressedButtons,
      previous: input.timedCircuit,
    })
    return {
      blockPower: advanced.blockPower,
      context,
      observation: advanced,
      timedCircuit: timedCircuitWithoutBlockPower(advanced),
    }
  }
  const advanced = advanceTimedCircuitWithContext({
    board: input.board,
    context: context.context,
    pressedButtons: input.pressedButtons,
    previous: input.timedCircuit,
  })
  return {
    blockPower: advanced.blockPower,
    context,
    timedCircuit: timedCircuitWithoutBlockPower(advanced),
  }
}

const NO_BLOCK_POWER_ENTRIES = 0

const isTimedOnlyContext = (
  context: RedstonePowerTickContextBundle,
  previousBlockPower: TimedCircuitWithBlockPower['blockPower'],
): boolean => !context.captureProvenance &&
  typeof context.context.isRedstoneConductiveAt !== 'function' &&
  previousBlockPower.size === NO_BLOCK_POWER_ENTRIES

const advancePower = (input: Readonly<{
  state: RedstoneFrameState
  board: CircuitBoard
  seed: Readonly<{ timed: TimedCircuitState; pressedButtons: ReadonlySet<PositionKey> }>
}>): Effect.Effect<AdvancedPowerTickResult> => Effect.gen(function* advancePowerGenerator() {
  const previousBlockPower = yield* Ref.get(input.state.blockPower)
  const contextForTick = yield* redstonePowerTickContextFactoryFor(input.state)
  const context = contextForTick(previousBlockPower)
  if (isTimedOnlyContext(context, previousBlockPower)) {
    return {
      mode: 'timed-only',
      timedCircuit: advanceTimedCircuit(input.board, input.seed.timed, input.seed.pressedButtons),
    }
  }
  return {
    mode: 'block-power',
    tick: advancePowerTick({
      board: input.board,
      pressedButtons: input.seed.pressedButtons,
      state: input.state,
      timedCircuit: input.seed.timed,
    }, context),
  }
})

/** Commits the completed redstone tick and records its matching hopper power. */
const commitPowerTick = (state: RedstoneFrameState, next: AdvancedPowerTick) =>
  Effect.gen(function* commitPowerTicksEffect() {
    yield* Ref.set(state.timedCircuit, next.timedCircuit)
    yield* Ref.set(state.power, next.timedCircuit.power)
    yield* Ref.set(state.blockPower, next.blockPower)
    if (next.observation) {
      yield* captureObservedTick(state, next.context, next.observation)
    }
    yield* collectHopperTransferEvents(state, ONE_TICK)
    yield* Ref.update(state.tickCount, (count) => nonNegativeTickCountFromNumber(count + ONE_TICK))
  })

const commitTimedCircuitTick = (state: RedstoneFrameState, next: TimedCircuitState) =>
  Effect.gen(function* commitTimedCircuitTicksEffect() {
    yield* Ref.set(state.timedCircuit, next)
    yield* Ref.set(state.power, next.power)
    yield* collectHopperTransferEvents(state, ONE_TICK)
    yield* Ref.update(state.tickCount, (count) => nonNegativeTickCountFromNumber(count + ONE_TICK))
  })

const commitAdvancedPowerTick = (state: RedstoneFrameState, tick: AdvancedPowerTickResult) => {
  if (tick.mode === 'timed-only') {
    return commitTimedCircuitTick(state, tick.timedCircuit)
  }
  return commitPowerTick(state, tick.tick)
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
    after: [UPSTREAM_STAGE_IDS.simPhysics],
    id: REDSTONE_STAGE_IDS.power,
    run: (_dt: DeltaTimeSecs) =>
      Effect.gen(function* advancePowerStage() {
        const advanceOnThisTick = yield* Ref.modify(state.firstGameTickSeen, (firstGameTickSeen) => [
          firstGameTickSeen,
          !firstGameTickSeen,
        ])
        if (!advanceOnThisTick) {
          return
        }

        const board = yield* Ref.get(state.board)
        // Each tick reads the PREVIOUS map: that one-tick lag is what makes a
        // Torch invert and therefore what makes every clock circuit work. See
        // `domain/power-graph.ts`.
        const pressedButtons = yield* Ref.getAndSet(state.pendingButtonPresses, new Set())
        const timed = yield* Ref.get(state.timedCircuit)
        const advanced = yield* advancePower({ board, seed: { pressedButtons, timed }, state })
        yield* commitAdvancedPowerTick(state, advanced)
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
    run: () =>
      Effect.gen(function* advanceEffectsStage() {
        if (yield* Ref.get(state.firstGameTickSeen)) {
          return
        }
        yield* Effect.all([
          collectLampTransitions(state),
          collectPistonTransitions(state),
          collectTriggerEvents(state),
          collectPoweredComponentTransitions(state),
        ], { discard: true })
      }),
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
  ReadonlyArray<StageRegistration>,
  RedstoneWorldRuntimeStateError
> = Effect.flatMap(
  Effect.serviceOption(RedstoneWorldRuntime),
  Option.match({
    onNone: () => makeRedstoneStages,
    onSome: (runtime) => Effect.map(redstoneWorldStateFor(runtime), redstoneStages),
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
  frameStages: makeRuntimeRedstoneStages.pipe(Effect.orDie),
  layers: RedstoneWorldRuntimeLayer,
}
