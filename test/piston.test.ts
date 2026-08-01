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
  isPistonMovable,
  PISTON_PUSH_LIMIT,
  planPush,
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
