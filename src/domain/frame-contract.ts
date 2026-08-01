/**
 * The frame / module composition contract (plan.md §4.1), restated locally.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AND WHEN IT DIES
 * ---------------------------------------------------------------------------
 *
 * These declarations belong to `@nerima-games/mc-kernel` (`domain/frame.ts`,
 * `domain/identifiers.ts`, `domain/quantities.ts`). This repository does not
 * import them, because the roll-out is bottom-up publish-then-pin: nothing is on
 * GitHub Packages yet, so there is no version of kernel to depend on. Declaring
 * a dependency we cannot install would leave a skeleton that does not build.
 *
 * So the contract is restated here, deliberately character-identical to kernel's
 * copy in the parts that matter (`StageRegistration`, the brands' predicates and
 * error messages), and this file is DELETED the moment mc-kernel is published:
 *
 *     import type { StageRegistration } from '@nerima-games/mc-kernel'
 *
 * The one intentional divergence is `FrameServices`; see its note below.
 *
 * Nothing else in this repository may restate a kernel type. A second local copy
 * of, say, `BlockType` would be a fork of the vocabulary rather than a stand-in
 * for it, and the whole point of kernel (plan.md §3.1) is that the vocabulary has
 * exactly one home.
 */
import type { Effect, Layer } from 'effect'
import { Brand } from 'effect'

/**
 * Identifies a frame stage. Stage ids are the vertices of the per-frame ordering
 * graph and are STRINGS ON PURPOSE: `after: [StageId('sim:physics')]` expresses
 * "run me after mc-sim's physics" without importing anything from mc-sim's stage
 * module, and `after: [StageId('redstone:tick')]` would express an ordering
 * relative to a sibling experience module without creating a dependency edge to
 * it (plan.md §2.3-1, §2.3-3).
 *
 * Convention: `<owning-repo-suffix>:<stage>`. Everything this repository owns is
 * prefixed `redstone:`.
 */
export type StageId = string & Brand.Brand<'StageId'>

export const StageId = Brand.refined<StageId>(
  (value) => value.trim().length > 0,
  (value) => Brand.error(`StageId must be a non-blank string, received ${JSON.stringify(value)}`),
)

/**
 * Elapsed simulation time for one frame, in seconds.
 *
 * Non-negative and finite. A zero delta is legal and must be handled by stages
 * rather than rejected. Redstone barely uses it: the power graph advances in
 * REDSTONE TICKS, a fixed-rate counter, not in wall time. A repeater delay
 * measured against a variable dt would make circuits behave differently on a
 * fast machine, which is exactly the class of bug a deterministic scenario test
 * is meant to make impossible.
 */
export type DeltaTimeSecs = number & Brand.Brand<'DeltaTimeSecs'>

export const DeltaTimeSecs = Brand.refined<DeltaTimeSecs>(
  (value) => Number.isFinite(value) && value >= 0,
  (value) => Brand.error(`DeltaTimeSecs must be a finite, non-negative number of seconds, received ${value}`),
)

/**
 * The context every frame stage may assume is present.
 *
 * kernel aliases this to `ClockPort`; here it is `never`, and that is a
 * deliberate divergence rather than an oversight. Restating `ClockPort` locally
 * would mean constructing a second `Context.Tag` with the same textual
 * identifier as kernel's — two tags that look identical and are not, which is a
 * far worse failure than a narrower type.
 *
 * `never` is forward-compatible in the direction that matters: an
 * `Effect<void, never, never>` is assignable wherever `Effect<void, never,
 * ClockPort>` is wanted, so every stage written against this file keeps
 * typechecking when the alias is replaced by the kernel import. Widening
 * `FrameServices` is a breaking change for whoever BUILDS the runtime, never for
 * stage authors — see kernel's note on the same alias.
 */
export type FrameServices = never

/**
 * One unit of per-frame work, contributed by a repository.
 *
 * `after` declares ORDERING EDGES ONLY. It is not a dependency on the named
 * stage existing, and it is not a request for a position in the sequence: the
 * total order over all stages from all modules is resolved solely by mc-compose
 * (plan.md §2.3-3, §4.2). A module that tried to declare its own absolute
 * position would be making a decision it cannot make correctly, because it
 * cannot see the other modules.
 *
 * Reproduced verbatim from plan.md §4.1, `interface` and all — hence the
 * `@typescript-eslint/consistent-type-definitions` exemption noted in
 * .oxlintrc.json. Keeping the spec and the code character-identical is worth more
 * than local style consistency.
 */
export interface StageRegistration {
  readonly id: StageId
  readonly after?: ReadonlyArray<StageId>
  readonly run: (dt: DeltaTimeSecs) => Effect.Effect<void, never, FrameServices>
}

/**
 * A repository's contribution to a running game.
 *
 * `ROut`      — services this module provides.
 * `E`         — errors that can occur while *building* those services.
 * `RIn`       — services this module needs to be given in order to build.
 * `RRegister` — services this module needs in order to REGISTER its stages.
 *
 * ---------------------------------------------------------------------------
 * `frameStages` is an Effect, and this repository is part of why
 * ---------------------------------------------------------------------------
 *
 * kernel declared it `ReadonlyArray<StageRegistration>` — a VALUE — until the
 * vertical-slice spike. A value has no context, so a module had no moment at
 * which it could acquire a service in order to BUILD a stage, and the only
 * remaining channel was `run` — which forced every service any stage touched
 * into `FrameServices`, and that in turn forced kernel to name mc-sim's and
 * mc-render's services. The tier model (plan.md §2.2) forbids that outright.
 *
 * `stages/registration.ts` in this repository had already run into it: it
 * exported an `Effect.Effect<ReadonlyArray<StageRegistration>>` with a comment
 * saying it "is NOT yet a `GameModule`" because the service set could not be
 * named. It was the right shape all along, and the contract has caught up.
 *
 * `RRegister` is separate from `RIn` because the two are genuinely different
 * sets — mc-render acquires `InputService` to register its input stage, and
 * `InputService` is a service mc-render PROVIDES rather than one it needs to be
 * given. It defaults to `never` so the common module still reads as three
 * parameters, which is exactly how this repository writes its own.
 *
 * The error channel of `frameStages` stays `never`, unlike the Layer's: a
 * module that can fail to come up says so in `E`, where a host already has to
 * handle it.
 */
export interface GameModule<ROut, E, RIn, RRegister = never> {
  readonly layers: Layer.Layer<ROut, E, RIn>
  readonly frameStages: Effect.Effect<ReadonlyArray<StageRegistration>, never, RRegister>
}
