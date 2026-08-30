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
export type { BlockRef } from './block-ref.js'

import { Effect } from 'effect'
import type { BlockRef } from './block-ref.js'

/**
 * The subset of mc-kernel's capability table that piston logic needs.
 *
 * Injected as a parameter rather than imported as a table, which is what keeps
 * the block list out of this repository. Narrow on purpose: a wider interface
 * would tempt the next rule to reach for a flag it should have asked for
 * explicitly.
 */
export type BlockCapabilityLookup = {
  /** Kernel's `pistonImmovable` flag (capability-flag-audit.md §3). */
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
      return { kind: 'refused', refusal: { at: index, reason: 'immovable' } }
    }
    if (index >= PISTON_PUSH_LIMIT) {
      return { kind: 'refused', refusal: { at: index, reason: 'too-long' } }
    }
  }

  return { kind: 'push', plan: { length: column.length, moved: [...column] } }
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
  readonly reason: 'collision' | 'duplicate' | 'immovable' | 'invalid-transition' | 'missing' | 'out-of-world' | 'too-long'
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

const positionKey = ({ x: posX, y: posY, z: posZ }: PistonPosition): string => `${posX},${posY},${posZ}`

/**
 * Distance from a piston's base to its head — the adjacent cell — and also the
 * step size the extension scan advances by, one cell at a time.
 */
const ADJACENT_CELL_DISTANCE = 1

/** Distance from a sticky piston's base to the block it pulls in on retraction. */
const STICKY_PULL_SOURCE_DISTANCE = 2

/** Direction multiplier applied to a per-cell offset when a piston extends. */
const EXTEND_DIRECTION = 1

/** Direction multiplier applied to a per-cell offset when a piston retracts. */
const RETRACT_DIRECTION = -1

/** Index of the first entry in a `moves` array. */
const FIRST_MOVE_INDEX = 0

/** Index of the second entry in a `moves` array. */
const SECOND_MOVE_INDEX = 1

/** A normal (non-sticky) piston retraction must carry zero pulled-block moves. */
const NORMAL_PISTON_RETRACT_MOVE_LIMIT = 0

/** A sticky piston retraction pulls at most one block. */
const STICKY_PISTON_RETRACT_MOVE_LIMIT = 1

/** The three inputs every planning helper below needs, bundled so each helper stays within the max-params budget. */
type PistonPlanningContext = {
  readonly capabilities: BlockCapabilityLookup
  readonly request: PistonTransitionRequest
  readonly world: PistonWorldView
}

const buildRetractionBasePlan = (request: PistonTransitionRequest): PistonMovementPlan => ({
  facing: request.facing,
  fromState: request.state,
  kind: request.kind,
  moves: [],
  piston: request.piston,
  toState: 'retracted',
})

const planStickyRetraction = (
  context: PistonPlanningContext,
  base: PistonMovementPlan,
): PistonMovementOutcome => {
  const source = pistonPositionAt(context.request.piston, context.request.facing, STICKY_PULL_SOURCE_DISTANCE)
  const cell = context.world.read(source)
  if (cell.kind === 'missing' || cell.kind === 'out-of-world') {
    return { kind: 'refused', refusal: { position: source, reason: cell.kind } }
  }
  if (cell.kind === 'empty' || context.capabilities.pistonImmovable(cell.block)) {
    return { kind: 'move', plan: base }
  }
  return {
    kind: 'move',
    plan: {
      ...base,
      moves: [{ block: cell.block, from: source, to: pistonPositionAt(context.request.piston, context.request.facing, ADJACENT_CELL_DISTANCE) }],
    },
  }
}

const planRetraction = (context: PistonPlanningContext): PistonMovementOutcome => {
  const base = buildRetractionBasePlan(context.request)
  if (context.request.kind === 'normal') {
    return { kind: 'move', plan: base }
  }
  return planStickyRetraction(context, base)
}

type ExtendedColumnBlock = { readonly block: BlockRef; readonly position: PistonPosition }

/** One step of the extension scan: either the scan is done (refused or found the vacancy to push into) or one more block joins the column. */
type ExtensionStep =
  | { readonly kind: 'settled'; readonly outcome: PistonMovementOutcome }
  | { readonly kind: 'joins-column'; readonly block: ExtendedColumnBlock }

const buildExtensionMovePlan = (
  context: PistonPlanningContext,
  blocks: ReadonlyArray<ExtendedColumnBlock>,
): PistonMovementOutcome => ({
  kind: 'move',
  plan: {
    facing: context.request.facing,
    fromState: context.request.state,
    kind: context.request.kind,
    moves: blocks.toReversed().map(({ block, position: from }) => ({
      block,
      from,
      to: pistonPositionAt(from, context.request.facing, ADJACENT_CELL_DISTANCE),
    })),
    piston: context.request.piston,
    toState: 'extended',
  },
})

const scanExtensionCell = (
  context: PistonPlanningContext,
  position: PistonPosition,
  blocks: ReadonlyArray<ExtendedColumnBlock>,
): ExtensionStep => {
  const cell = context.world.read(position)
  if (cell.kind === 'missing' || cell.kind === 'out-of-world') {
    return { kind: 'settled', outcome: { kind: 'refused', refusal: { position, reason: cell.kind } } }
  }
  if (cell.kind === 'empty') {
    return { kind: 'settled', outcome: buildExtensionMovePlan(context, blocks) }
  }
  if (context.capabilities.pistonImmovable(cell.block)) {
    return { kind: 'settled', outcome: { kind: 'refused', refusal: { position, reason: 'immovable' } } }
  }
  if (blocks.length === PISTON_PUSH_LIMIT) {
    return { kind: 'settled', outcome: { kind: 'refused', refusal: { position, reason: 'too-long' } } }
  }
  return { block: { block: cell.block, position }, kind: 'joins-column' }
}

/**
 * Terminates without an explicit bound check because `scanExtensionCell`'s own
 * `blocks.length === PISTON_PUSH_LIMIT` guard proves it: reaching iteration N
 * requires every earlier iteration to have taken the `joins-column` branch (any
 * `settled` step returns immediately), and `joins-column` pushes exactly one
 * entry per iteration. So by the `PISTON_PUSH_LIMIT`-th push, `blocks.length`
 * is necessarily `PISTON_PUSH_LIMIT`, and that guard — checked unconditionally,
 * ahead of `joins-column`, on every call — fires no later than the very next
 * iteration. A bounded `for` here would need a trailing throw for a case that
 * can provably never run; `while (true)` lets the loop's own return be the
 * only exit, so there is no unreachable branch to prove dead or instrument
 * around.
 */
const planExtension = (context: PistonPlanningContext): PistonMovementOutcome => {
  const blocks: Array<ExtendedColumnBlock> = []
  let distance = ADJACENT_CELL_DISTANCE
  while (true) {
    const position = pistonPositionAt(context.request.piston, context.request.facing, distance)
    const step = scanExtensionCell(context, position, blocks)
    if (step.kind === 'settled') {
      return step.outcome
    }
    blocks.push(step.block)
    distance += ADJACENT_CELL_DISTANCE
  }
}

const resolvePistonTargetState = (powered: boolean): PistonState => {
  if (powered) {
    return 'extended'
  }
  return 'retracted'
}

/** Plans extension/retraction without mutating the supplied view. */
export const planPistonTransition = (
  request: PistonTransitionRequest,
  world: PistonWorldView,
  capabilities: BlockCapabilityLookup,
): PistonMovementOutcome => {
  const targetState = resolvePistonTargetState(request.powered)
  if (request.state === targetState) {
    return { kind: 'noop', state: request.state }
  }

  const context: PistonPlanningContext = { capabilities, request, world }
  if (targetState === 'retracted') {
    return planRetraction(context)
  }

  return planExtension(context)
}

export type PistonApplyPort<Err = never> = {
  /** Must compare expected source blocks and commit all moves plus state together. */
  readonly commit: (plan: PistonMovementPlan) => Effect.Effect<void, Err>
}

const resolveConflictPosition = (sourceAlreadyTaken: boolean, move: PistonMove): PistonPosition => {
  if (sourceAlreadyTaken) {
    return move.from
  }
  return move.to
}

const resolveMoveDirection = (toState: PistonState): number => {
  if (toState === 'extended') {
    return EXTEND_DIRECTION
  }
  return RETRACT_DIRECTION
}

/** Tracks which source/target cells earlier moves in the same plan already claim. */
type ClaimedPositions = { readonly sources: Set<string>; readonly targets: Set<string> }

const checkMoveAgainstClaims = (
  move: PistonMove,
  claimed: ClaimedPositions,
  plan: PistonMovementPlan,
): PistonPlanRefusal | undefined => {
  const source = positionKey(move.from)
  const target = positionKey(move.to)
  if (claimed.sources.has(source) || claimed.targets.has(target)) {
    return { position: resolveConflictPosition(claimed.sources.has(source), move), reason: 'duplicate' }
  }
  claimed.sources.add(source)
  claimed.targets.add(target)
  const direction = resolveMoveDirection(plan.toState)
  if (target !== positionKey(pistonPositionAt(move.from, plan.facing, direction))) {
    return { position: move.to, reason: 'collision' }
  }
  return
}

const findMoveConflict = (plan: PistonMovementPlan): PistonPlanRefusal | undefined => {
  const claimed: ClaimedPositions = { sources: new Set<string>(), targets: new Set<string>() }
  for (const move of plan.moves) {
    const conflict = checkMoveAgainstClaims(move, claimed, plan)
    if (conflict) {
      return conflict
    }
  }
  return
}

const validateExtendedPlan = (plan: PistonMovementPlan): PistonPlanRefusal | undefined => {
  if (plan.moves.length > PISTON_PUSH_LIMIT) {
    return {
      position: pistonPositionAt(plan.piston, plan.facing, PISTON_PUSH_LIMIT + ADJACENT_CELL_DISTANCE),
      reason: 'too-long',
    }
  }
  for (const [index, move] of plan.moves.entries()) {
    const expectedDistance = plan.moves.length - index
    if (positionKey(move.from) !== positionKey(pistonPositionAt(plan.piston, plan.facing, expectedDistance))) {
      return { position: move.from, reason: 'collision' }
    }
  }
  return
}

const validateRetractionPlan = (plan: PistonMovementPlan): PistonPlanRefusal | undefined => {
  if (plan.kind === 'normal' && plan.moves.length > NORMAL_PISTON_RETRACT_MOVE_LIMIT) {
    return { position: plan.moves[FIRST_MOVE_INDEX]!.from, reason: 'invalid-transition' }
  }
  if (plan.moves.length > STICKY_PISTON_RETRACT_MOVE_LIMIT) {
    return { position: plan.moves[SECOND_MOVE_INDEX]!.from, reason: 'invalid-transition' }
  }
  const [pull] = plan.moves
  if (pull && (
    positionKey(pull.from) !== positionKey(pistonPositionAt(plan.piston, plan.facing, STICKY_PULL_SOURCE_DISTANCE))
    || positionKey(pull.to) !== positionKey(pistonPositionAt(plan.piston, plan.facing, ADJACENT_CELL_DISTANCE))
  )) {
    return { position: pull.from, reason: 'collision' }
  }
  return
}

/** A plan has the same bounded, deterministic shape as the pure planner emits. */
export const validatePistonPlan = (plan: PistonMovementPlan): PistonPlanRefusal | undefined => {
  if (plan.fromState === plan.toState) {
    return { position: plan.piston, reason: 'invalid-transition' }
  }

  const conflict = findMoveConflict(plan)
  if (conflict) {
    return conflict
  }

  if (plan.toState === 'extended') {
    return validateExtendedPlan(plan)
  }
  return validateRetractionPlan(plan)
}

/** Delegates one validated plan to one atomic host commit. */
export const applyPistonPlan = <Err>(
  plan: PistonMovementPlan,
  port: PistonApplyPort<Err>,
): import('effect').Effect.Effect<void, Err | PistonPlanRefusal> => {
  const refusal = validatePistonPlan(plan)
  if (refusal) {
    return Effect.fail(refusal)
  }
  return port.commit(plan)
}
