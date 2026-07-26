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
import type { Effect } from 'effect'
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
 * oxlint.json. Keeping the spec and the code character-identical is worth more
 * than local style consistency.
 */
export interface StageRegistration {
  readonly id: StageId
  readonly after?: ReadonlyArray<StageId>
  readonly run: (dt: DeltaTimeSecs) => Effect.Effect<void, never, FrameServices>
}
