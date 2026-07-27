/**
 * Piston pushing — and the one design correction plan.md §3.12 asks for.
 *
 * ---------------------------------------------------------------------------
 * THE CORRECTION: `pistonImmovable` is a kernel capability flag, not a local set
 * ---------------------------------------------------------------------------
 *
 * plan.md §3.12: 「ピストンの不可動ブロック集合は能力フラグ(`pistonImmovable`)で
 * kernel に定義(参照実装はローカル定数だった)」.
 *
 * The reference's version of this file opened with a 22-entry literal:
 *
 *     // packages/app/application/frame/stages/redstone-piston-world-effects.ts:12
 *     const PISTON_IMMOVABLE_BLOCKS: ReadonlySet<BlockType> = new Set([
 *       'AIR', 'BEDROCK', 'WATER', 'LAVA', 'FIRE', 'NETHER_PORTAL', 'END_PORTAL',
 *       'END_PORTAL_FRAME', 'END_PORTAL_FRAME_FILLED', 'END_GATEWAY', 'DRAGON_EGG',
 *       'END_CRYSTAL', 'PISTON', 'PISTON_HEAD', 'CHEST', 'FURNACE', 'SHULKER_BOX',
 *       'ANVIL', 'CAULDRON', 'WATER_CAULDRON',
 *     ])
 *
 * Every one of those names is a behaviour decision about a block, written down
 * in the file that happens to consume it. That is the exact pattern plan.md
 * §3.1 was written to eliminate — 「挙動判定が blockTypeToIndex('SAND') 式の名指し
 * で51ファイル229箇所に散らばり、エンジンとコンテンツの分離を不可能にした」 — and
 * its practical cost is that adding a block means finding and editing every such
 * list. Miss one and the new block is pushable by a piston into the void.
 *
 * So this file contains NO block names at all. It asks. The authoritative flag
 * source is `mc-kernel/docs/capability-flag-audit.md`, which has already been
 * written and records `pistonImmovable` as a boolean with 5 measured occurrence
 * sites in the reference. When kernel is published, `BlockCapabilityLookup`
 * below is deleted and replaced by kernel's capability accessor.
 *
 * `test/piston.test.ts` asserts the absence structurally: a block name this
 * repository has never heard of behaves exactly as the injected lookup says.
 * If somebody reintroduces a local set, that test fails.
 *
 * ---------------------------------------------------------------------------
 * Sticky pistons and pulling are not here yet
 * ---------------------------------------------------------------------------
 *
 * Deliberate scope limit for the first cut. Pulling has its own rules (a sticky
 * piston pulls exactly one block, and slime blocks drag their neighbours in
 * three dimensions) and needs a capability flag the audit has not yet settled.
 * Guessing it now would put a wrong flag into fourteen repositories at once.
 */

/**
 * `BlockRef` is `domain/block-ref.ts`'s, and is re-exported here.
 *
 * It was declared in this file while pistons were the only rule that had to name
 * a block. `domain/observer.ts` is the second, and one placeholder invented
 * twice is the `ItemId` story mc-sim's `domain/inventory.ts` opens with. The
 * re-export is so that moving it changed no import anywhere else.
 */
export type { BlockRef } from './block-ref'

import type { BlockRef } from './block-ref'

/**
 * The subset of mc-kernel's capability table that piston logic needs.
 *
 * Injected as a parameter rather than imported as a table, which is what keeps
 * the block list out of this repository. Narrow on purpose: a wider interface
 * would tempt the next rule to reach for a flag it should have asked for
 * explicitly.
 */
export type BlockCapabilityLookup = {
  /** kernel's `pistonImmovable` flag (capability-flag-audit.md §3). */
  readonly pistonImmovable: (block: BlockRef) => boolean
}

/**
 * Vanilla's limit on how many blocks one piston can shove.
 *
 * A rule, not a capability, so it lives with the rule — this repository owns
 * "how a piston behaves", kernel owns "what a block is".
 */
export const PISTON_PUSH_LIMIT = 12

export type PushPlan = {
  /**
   * The blocks that move, in the order they occupy the column starting at the
   * piston head. Empty means the piston extends into free space.
   */
  readonly moved: ReadonlyArray<BlockRef>
  /** How far along the column the push reaches. */
  readonly length: number
}

export type PushRefusal = {
  readonly reason: 'immovable' | 'too-long'
  /** Index into the column at which the push was refused. */
  readonly at: number
}

export type PushOutcome =
  | { readonly kind: 'push'; readonly plan: PushPlan }
  | { readonly kind: 'refused'; readonly refusal: PushRefusal }

/**
 * Decide what a piston extending into `column` does.
 *
 * `column` is the run of blocks in front of the piston head, nearest first,
 * already read out of the world by the caller. Passing the blocks in rather than
 * a world handle keeps this a pure function, which is what makes a circuit
 * fixture test possible at all.
 *
 * An empty cell terminates the run: everything before it is pushed into it. The
 * caller decides what "empty" means (air, and in vanilla also replaceable
 * blocks like tall grass) by simply not including those cells — this function
 * is told about solid blocks only.
 *
 * The two refusals are distinguished because they mean different things to a
 * player: `immovable` is "you cannot push obsidian", `too-long` is "your
 * contraption is one block too big". Collapsing them into `undefined` — which is
 * what the reference's boolean predicate effectively did — loses the ability to
 * explain either.
 */
export const planPush = (
  column: ReadonlyArray<BlockRef>,
  capabilities: BlockCapabilityLookup,
): PushOutcome => {
  for (const [index, block] of column.entries()) {
    if (capabilities.pistonImmovable(block)) {
      return { kind: 'refused', refusal: { reason: 'immovable', at: index } }
    }
    if (index >= PISTON_PUSH_LIMIT) {
      return { kind: 'refused', refusal: { reason: 'too-long', at: index } }
    }
  }

  return { kind: 'push', plan: { moved: [...column], length: column.length } }
}

/**
 * `!pistonImmovable`, named.
 *
 * Trivial, and worth having: it gives the call sites a positive word to use, so
 * a reader is never parsing a double negative in the middle of a rule. The
 * reference had the same helper (`isPistonMovableBlock`) — the difference is
 * only that it closed over a local constant and this one does not.
 */
export const isPistonMovable = (
  capabilities: BlockCapabilityLookup,
  block: BlockRef,
): boolean => !capabilities.pistonImmovable(block)
