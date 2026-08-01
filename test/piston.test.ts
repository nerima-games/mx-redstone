/**
 * Piston push rules, and the structural check that no block list has crept back
 * into this repository.
 *
 * plan.md §3.12: 「ピストンの不可動ブロック集合は能力フラグ(`pistonImmovable`)で
 * kernel に定義(参照実装はローカル定数だった)」. The reference's local set is at
 * `packages/app/application/frame/stages/redstone-piston-world-effects.ts:12-33`.
 */
import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import {
  applyPistonPlan,
  isPistonMovable,
  PISTON_PUSH_LIMIT,
  planPush,
  planPistonTransition,
  validatePistonPlan,
  type BlockCapabilityLookup,
  type BlockRef,
} from '../src/domain/piston'

/** A lookup standing in for kernel's capability table. */
const immovableSet = (blocks: ReadonlyArray<BlockRef>): BlockCapabilityLookup => {
  const set = new Set(blocks)
  return { pistonImmovable: (block) => set.has(block) }
}

const NOTHING_IS_IMMOVABLE: BlockCapabilityLookup = { pistonImmovable: () => false }

describe('REGRESSION: the immovable set is a kernel capability flag, not a local constant', () => {
  it.effect('a block name this repository has never heard of is immovable if — and only if — the lookup says so', () =>
    Effect.sync(() => {
      // `QUANTUM_OBSIDIAN` appears nowhere in mx-redstone. If this file were
      // consulting a local list, the answer could not depend on the injected
      // lookup, and one of these two assertions would fail.
      const column: ReadonlyArray<BlockRef> = ['QUANTUM_OBSIDIAN']

      expect(planPush(column, immovableSet(['QUANTUM_OBSIDIAN'])).kind).toBe('refused')
      expect(planPush(column, NOTHING_IS_IMMOVABLE).kind).toBe('push')
    }),
  )

  it.effect('the blocks the reference hardcoded are decided by the caller here, every one of them', () =>
    Effect.sync(() => {
      // The reference's 20-entry literal, verbatim. In this repository not one
      // of these names appears in shipped source: they are data supplied by
      // whoever owns the capability table (mc-kernel/docs/capability-flag-audit.md).
      const referenceList: ReadonlyArray<BlockRef> = [
        'AIR', 'BEDROCK', 'WATER', 'LAVA', 'FIRE', 'NETHER_PORTAL', 'END_PORTAL',
        'END_PORTAL_FRAME', 'END_PORTAL_FRAME_FILLED', 'END_GATEWAY', 'DRAGON_EGG',
        'END_CRYSTAL', 'PISTON', 'PISTON_HEAD', 'CHEST', 'FURNACE', 'SHULKER_BOX',
        'ANVIL', 'CAULDRON', 'WATER_CAULDRON',
      ]
      const capabilities = immovableSet(referenceList)

      for (const block of referenceList) {
        expect(isPistonMovable(capabilities, block)).toBe(false)
      }
      // And a stone block, which is not on that list, moves.
      expect(isPistonMovable(capabilities, 'STONE')).toBe(true)
    }),
  )

  it.effect('a lookup that never refuses makes every block pushable, including bedrock', () =>
    Effect.sync(() => {
      // Nonsense as a game rule, and exactly the point: mx-redstone has no
      // opinion about bedrock. Adding one here would be the reference's mistake.
      expect(isPistonMovable(NOTHING_IS_IMMOVABLE, 'BEDROCK')).toBe(true)
    }),
  )
})

describe('push planning', () => {
  it.effect('an empty column extends into free space', () =>
    Effect.sync(() => {
      const outcome = planPush([], NOTHING_IS_IMMOVABLE)
      expect(outcome).toStrictEqual({ kind: 'push', plan: { moved: [], length: 0 } })
    }),
  )

  it.effect('a run of movable blocks is pushed in column order', () =>
    Effect.sync(() => {
      const outcome = planPush(['STONE', 'DIRT', 'SAND'], NOTHING_IS_IMMOVABLE)
      expect(outcome).toStrictEqual({
        kind: 'push',
        plan: { moved: ['STONE', 'DIRT', 'SAND'], length: 3 },
      })
    }),
  )

  it.effect('an immovable block anywhere in the run refuses the whole push, and says where', () =>
    Effect.sync(() => {
      const outcome = planPush(['STONE', 'DIRT', 'OBSIDIAN'], immovableSet(['OBSIDIAN']))
      expect(outcome).toStrictEqual({
        kind: 'refused',
        refusal: { reason: 'immovable', at: 2 },
      })
    }),
  )

  it.effect(`exactly ${String(PISTON_PUSH_LIMIT)} blocks move; the next one refuses with a distinguishable reason`, () =>
    Effect.sync(() => {
      const atLimit = Array.from({ length: PISTON_PUSH_LIMIT }, () => 'STONE')
      const overLimit = [...atLimit, 'STONE']

      expect(planPush(atLimit, NOTHING_IS_IMMOVABLE).kind).toBe('push')

      const refused = planPush(overLimit, NOTHING_IS_IMMOVABLE)
      expect(refused).toStrictEqual({
        kind: 'refused',
        refusal: { reason: 'too-long', at: PISTON_PUSH_LIMIT },
      })
    }),
  )

  it.effect('REGRESSION: the two refusals stay distinguishable, because they mean different things to a player', () =>
    Effect.sync(() => {
      // "You cannot push obsidian" and "your contraption is one block too big"
      // need different explanations. A boolean predicate — which is what the
      // reference effectively had — can express neither.
      const immovable = planPush(['OBSIDIAN'], immovableSet(['OBSIDIAN']))
      const tooLong = planPush(
        Array.from({ length: PISTON_PUSH_LIMIT + 1 }, () => 'STONE'),
        NOTHING_IS_IMMOVABLE,
      )

      expect(immovable.kind).toBe('refused')
      expect(tooLong.kind).toBe('refused')
      expect(immovable).not.toStrictEqual(tooLong)
    }),
  )

  it.effect('the returned plan is a copy, so a caller cannot mutate the column it passed in', () =>
    Effect.sync(() => {
      const column = ['STONE', 'DIRT']
      const outcome = planPush(column, NOTHING_IS_IMMOVABLE)
      expect(outcome.kind).toBe('push')
      if (outcome.kind === 'push') {
        expect(outcome.plan.moved).not.toBe(column)
        expect(outcome.plan.moved).toStrictEqual(column)
      }
    }),
  )
})

const cells = (entries: ReadonlyArray<readonly [number, BlockRef]>) => {
  const world = new Map(entries.map(([x, block]) => [x, block]))
  return {
    read: ({ x }: { readonly x: number }) =>
      world.has(x) ? { kind: 'block' as const, block: world.get(x)! } : { kind: 'empty' as const },
  }
}

describe('positioned piston movement', () => {
  it.effect('extends a 12-block east-facing chain farthest-first', () =>
    Effect.sync(() => {
      const outcome = planPistonTransition(
        { piston: { x: 0, y: 0, z: 0 }, facing: 'east', kind: 'normal', state: 'retracted', powered: true },
        cells(Array.from({ length: PISTON_PUSH_LIMIT }, (_, index) => [index + 1, `BLOCK_${String(index)}`])),
        NOTHING_IS_IMMOVABLE,
      )
      expect(outcome.kind).toBe('move')
      if (outcome.kind === 'move') {
        expect(outcome.plan.moves).toHaveLength(PISTON_PUSH_LIMIT)
        expect(outcome.plan.moves[0]?.from.x).toBe(12)
        expect(outcome.plan.moves.at(-1)?.from.x).toBe(1)
      }
    }),
  )

  it.effect('refuses the 13th block and unavailable world boundaries', () =>
    Effect.sync(() => {
      const request = { piston: { x: 0, y: 0, z: 0 }, facing: 'east' as const, kind: 'normal' as const, state: 'retracted' as const, powered: true }
      const tooLong = planPistonTransition(
        request,
        cells(Array.from({ length: PISTON_PUSH_LIMIT + 1 }, (_, index) => [index + 1, 'STONE'])),
        NOTHING_IS_IMMOVABLE,
      )
      expect(tooLong.kind === 'refused' ? tooLong.refusal.reason : undefined).toBe('too-long')
      const boundary = planPistonTransition(
        request,
        { read: (position) => position.x === 2 ? { kind: 'out-of-world' } : { kind: 'block', block: 'STONE' } },
        NOTHING_IS_IMMOVABLE,
      )
      expect(boundary.kind === 'refused' ? boundary.refusal.reason : undefined).toBe('out-of-world')
    }),
  )

  it.effect('a sticky piston pulls one movable block into the vacated head cell', () =>
    Effect.sync(() => {
      const outcome = planPistonTransition(
        { piston: { x: 0, y: 0, z: 0 }, facing: 'up', kind: 'sticky', state: 'extended', powered: false },
        { read: ({ y }) => y === 2 ? { kind: 'block', block: 'STONE' } : { kind: 'empty' } },
        NOTHING_IS_IMMOVABLE,
      )
      expect(outcome).toStrictEqual({
        kind: 'move',
        plan: {
          piston: { x: 0, y: 0, z: 0 }, facing: 'up', kind: 'sticky', fromState: 'extended', toState: 'retracted',
          moves: [{ block: 'STONE', from: { x: 0, y: 2, z: 0 }, to: { x: 0, y: 1, z: 0 } }],
        },
      })
    }),
  )

  it.effect('rejects a malformed duplicate plan without invoking the atomic commit', () =>
    Effect.gen(function* () {
      let commits = 0
      const move = { block: 'STONE', from: { x: 1, y: 0, z: 0 }, to: { x: 2, y: 0, z: 0 } }
      const result = yield* Effect.either(applyPistonPlan({
        piston: { x: 0, y: 0, z: 0 }, facing: 'east', kind: 'normal', fromState: 'retracted', toState: 'extended', moves: [move, move],
      }, { commit: () => Effect.sync(() => { commits += 1 }) }))
      expect(result._tag).toBe('Left')
      expect(commits).toBe(0)

      expect(validatePistonPlan({
        piston: { x: 0, y: 0, z: 0 }, facing: 'east', kind: 'normal', fromState: 'retracted', toState: 'extended',
        moves: [{ block: 'STONE', from: { x: 1, y: 0, z: 0 }, to: { x: 3, y: 0, z: 0 } }],
      })).toStrictEqual({ reason: 'collision', position: { x: 3, y: 0, z: 0 } })
    }),
  )

  it.effect('rejects plans that bypass the push limit or deterministic movement shape', () =>
    Effect.gen(function* () {
      const piston = { x: 0, y: 0, z: 0 }
      const moves = Array.from({ length: PISTON_PUSH_LIMIT + 1 }, (_, index) => {
        const from = { x: PISTON_PUSH_LIMIT + 1 - index, y: 0, z: 0 }
        return { block: `BLOCK_${String(index)}`, from, to: { ...from, x: from.x + 1 } }
      })
      let commits = 0
      const result = yield* Effect.either(applyPistonPlan({
        piston, facing: 'east', kind: 'normal', fromState: 'retracted', toState: 'extended', moves,
      }, { commit: () => Effect.sync(() => { commits += 1 }) }))
      expect(result).toMatchObject({
        _tag: 'Left',
        left: { reason: 'too-long', position: { x: PISTON_PUSH_LIMIT + 1, y: 0, z: 0 } },
      })
      expect(commits).toBe(0)

      expect(validatePistonPlan({
        piston, facing: 'east', kind: 'normal', fromState: 'retracted', toState: 'extended',
        moves: [
          { block: 'STONE', from: { x: 1, y: 0, z: 0 }, to: { x: 2, y: 0, z: 0 } },
          { block: 'DIRT', from: { x: 2, y: 0, z: 0 }, to: { x: 3, y: 0, z: 0 } },
        ],
      })).toStrictEqual({ reason: 'collision', position: { x: 1, y: 0, z: 0 } })
    }),
  )

  it.effect('accepts only the single two-to-one-cell pull shape for sticky retraction', () =>
    Effect.sync(() => {
      const base = {
        piston: { x: 0, y: 0, z: 0 }, facing: 'east' as const, kind: 'sticky' as const,
        fromState: 'extended' as const, toState: 'retracted' as const,
      }
      expect(validatePistonPlan({
        ...base,
        moves: [{ block: 'STONE', from: { x: 2, y: 0, z: 0 }, to: { x: 1, y: 0, z: 0 } }],
      })).toBeUndefined()
      expect(validatePistonPlan({
        ...base,
        moves: [{ block: 'STONE', from: { x: 3, y: 0, z: 0 }, to: { x: 2, y: 0, z: 0 } }],
      })).toStrictEqual({ reason: 'collision', position: { x: 3, y: 0, z: 0 } })
      expect(validatePistonPlan({
        ...base,
        kind: 'normal',
        moves: [{ block: 'STONE', from: { x: 2, y: 0, z: 0 }, to: { x: 1, y: 0, z: 0 } }],
      })).toStrictEqual({ reason: 'invalid-transition', position: { x: 2, y: 0, z: 0 } })
    }),
  )

  it.effect('covers retraction, refusal, validation, and successful atomic apply boundaries', () =>
    Effect.gen(function* () {
      const piston = { x: 0, y: 0, z: 0 }
      const extended = { piston, facing: 'east' as const, kind: 'normal' as const, state: 'extended' as const, powered: true }
      expect(planPistonTransition(extended, cells([]), NOTHING_IS_IMMOVABLE)).toStrictEqual({ kind: 'noop', state: 'extended' })
      expect(planPistonTransition({ ...extended, powered: false }, cells([]), NOTHING_IS_IMMOVABLE)).toMatchObject({
        kind: 'move', plan: { moves: [], toState: 'retracted' },
      })

      const sticky = { ...extended, kind: 'sticky' as const, powered: false }
      for (const unavailable of ['missing', 'out-of-world'] as const) {
        expect(planPistonTransition(sticky, { read: () => ({ kind: unavailable }) }, NOTHING_IS_IMMOVABLE)).toMatchObject({
          kind: 'refused', refusal: { reason: unavailable },
        })
      }
      expect(planPistonTransition(sticky, cells([]), NOTHING_IS_IMMOVABLE)).toMatchObject({ kind: 'move', plan: { moves: [] } })
      expect(planPistonTransition(sticky, cells([[2, 'BEDROCK']]), immovableSet(['BEDROCK']))).toMatchObject({
        kind: 'move', plan: { moves: [] },
      })

      const extension = { ...extended, state: 'retracted' as const }
      expect(planPistonTransition(extension, cells([[1, 'BEDROCK']]), immovableSet(['BEDROCK']))).toMatchObject({
        kind: 'refused', refusal: { reason: 'immovable' },
      })

      const validPlan = {
        piston, facing: 'east' as const, kind: 'normal' as const, fromState: 'retracted' as const, toState: 'extended' as const,
        moves: [{ block: 'STONE', from: { x: 1, y: 0, z: 0 }, to: { x: 2, y: 0, z: 0 } }],
      }
      expect(validatePistonPlan(validPlan)).toBeUndefined()
      expect(validatePistonPlan({
        ...validPlan,
        moves: [validPlan.moves[0]!, { block: 'DIRT', from: { x: 3, y: 0, z: 0 }, to: { x: 2, y: 0, z: 0 } }],
      })).toMatchObject({ reason: 'duplicate' })

      let committed = false
      yield* applyPistonPlan(validPlan, { commit: () => Effect.sync(() => { committed = true }) })
      expect(committed).toBe(true)
    }),
  )
})
