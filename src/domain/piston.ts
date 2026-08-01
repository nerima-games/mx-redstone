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
 * Movement planning is pure; applying a plan is a single atomic host operation.
 * ---------------------------------------------------------------------------
 *
 * Sticky pistons pull the single block two cells in front of the base into the
 * vacated head cell. Slime/honey neighbour attachment remains a separate block
 * capability concern and is intentionally not inferred here.
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

import { Effect } from 'effect'
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

export type PistonFacing = 'down' | 'east' | 'north' | 'south' | 'up' | 'west'
export type PistonKind = 'normal' | 'sticky'
export type PistonState = 'extended' | 'retracted'

export type PistonPosition = {
  readonly x: number
  readonly y: number
  readonly z: number
}

export type PistonCell =
  | { readonly kind: 'block'; readonly block: BlockRef }
  | { readonly kind: 'empty' }

export type PistonCellRead =
  | PistonCell
  | { readonly kind: 'missing' }
  | { readonly kind: 'out-of-world' }

export type PistonWorldView = {
  readonly read: (position: PistonPosition) => PistonCellRead
}

export type PistonMove = {
  readonly block: BlockRef
  readonly from: PistonPosition
  readonly to: PistonPosition
}

export type PistonMovementPlan = {
  readonly piston: PistonPosition
  readonly facing: PistonFacing
  readonly kind: PistonKind
  readonly fromState: PistonState
  readonly toState: PistonState
  /** Farthest-first for extension, one move for sticky retraction. */
  readonly moves: ReadonlyArray<PistonMove>
}

export type PistonPlanRefusal = {
  readonly reason: 'collision' | 'duplicate' | 'immovable' | 'missing' | 'out-of-world' | 'too-long'
  readonly position: PistonPosition
}

export type PistonMovementOutcome =
  | { readonly kind: 'move'; readonly plan: PistonMovementPlan }
  | { readonly kind: 'noop'; readonly state: PistonState }
  | { readonly kind: 'refused'; readonly refusal: PistonPlanRefusal }

export type PistonTransitionRequest = {
  readonly piston: PistonPosition
  readonly facing: PistonFacing
  readonly kind: PistonKind
  readonly state: PistonState
  readonly powered: boolean
}

const OFFSETS: Readonly<Record<PistonFacing, PistonPosition>> = {
  down: { x: 0, y: -1, z: 0 },
  east: { x: 1, y: 0, z: 0 },
  north: { x: 0, y: 0, z: -1 },
  south: { x: 0, y: 0, z: 1 },
  up: { x: 0, y: 1, z: 0 },
  west: { x: -1, y: 0, z: 0 },
}

export const pistonPositionAt = (
  origin: PistonPosition,
  facing: PistonFacing,
  distance: number,
): PistonPosition => {
  const offset = OFFSETS[facing]
  return {
    x: origin.x + offset.x * distance,
    y: origin.y + offset.y * distance,
    z: origin.z + offset.z * distance,
  }
}

const positionKey = ({ x, y, z }: PistonPosition): string => `${x},${y},${z}`

/** Plans extension/retraction without mutating the supplied view. */
export const planPistonTransition = (
  request: PistonTransitionRequest,
  world: PistonWorldView,
  capabilities: BlockCapabilityLookup,
): PistonMovementOutcome => {
  const targetState: PistonState = request.powered ? 'extended' : 'retracted'
  if (request.state === targetState) return { kind: 'noop', state: request.state }

  if (targetState === 'retracted') {
    const base: PistonMovementPlan = {
      piston: request.piston,
      facing: request.facing,
      kind: request.kind,
      fromState: request.state,
      toState: targetState,
      moves: [],
    }
    if (request.kind === 'normal') return { kind: 'move', plan: base }

    const source = pistonPositionAt(request.piston, request.facing, 2)
    const cell = world.read(source)
    if (cell.kind === 'missing' || cell.kind === 'out-of-world') {
      return { kind: 'refused', refusal: { reason: cell.kind, position: source } }
    }
    if (cell.kind === 'empty' || capabilities.pistonImmovable(cell.block)) {
      return { kind: 'move', plan: base }
    }
    return {
      kind: 'move',
      plan: {
        ...base,
        moves: [{ block: cell.block, from: source, to: pistonPositionAt(request.piston, request.facing, 1) }],
      },
    }
  }

  const blocks: Array<{ readonly block: BlockRef; readonly position: PistonPosition }> = []
  for (let distance = 1; distance <= PISTON_PUSH_LIMIT + 1; distance += 1) {
    const position = pistonPositionAt(request.piston, request.facing, distance)
    const cell = world.read(position)
    if (cell.kind === 'missing' || cell.kind === 'out-of-world') {
      return { kind: 'refused', refusal: { reason: cell.kind, position } }
    }
    if (cell.kind === 'empty') {
      return {
        kind: 'move',
        plan: {
          piston: request.piston,
          facing: request.facing,
          kind: request.kind,
          fromState: request.state,
          toState: targetState,
          moves: blocks.toReversed().map(({ block, position: from }) => ({
            block,
            from,
            to: pistonPositionAt(from, request.facing, 1),
          })),
        },
      }
    }
    if (capabilities.pistonImmovable(cell.block)) {
      return { kind: 'refused', refusal: { reason: 'immovable', position } }
    }
    if (blocks.length === PISTON_PUSH_LIMIT) {
      return { kind: 'refused', refusal: { reason: 'too-long', position } }
    }
    blocks.push({ block: cell.block, position })
  }
  throw new Error('unreachable piston scan')
}

export type PistonApplyPort<E = never> = {
  /** Must compare expected source blocks and commit all moves plus state together. */
  readonly commit: (plan: PistonMovementPlan) => Effect.Effect<void, E>
}

/** A plan has no duplicate cells and every move follows the piston's axis. */
export const validatePistonPlan = (plan: PistonMovementPlan): PistonPlanRefusal | undefined => {
  const sources = new Set<string>()
  const targets = new Set<string>()
  for (const move of plan.moves) {
    const source = positionKey(move.from)
    const target = positionKey(move.to)
    if (sources.has(source) || targets.has(target)) {
      return { reason: 'duplicate', position: sources.has(source) ? move.from : move.to }
    }
    sources.add(source)
    targets.add(target)
    const direction = plan.toState === 'extended' ? 1 : -1
    if (target !== positionKey(pistonPositionAt(move.from, plan.facing, direction))) {
      return { reason: 'collision', position: move.to }
    }
  }
  return undefined
}

/** Delegates one validated plan to one atomic host commit. */
export const applyPistonPlan = <E>(
  plan: PistonMovementPlan,
  port: PistonApplyPort<E>,
): import('effect').Effect.Effect<void, E | PistonPlanRefusal> => {
  const refusal = validatePistonPlan(plan)
  return refusal === undefined
    ? port.commit(plan)
    : Effect.fail(refusal)
}
