/**
 * The barrel is pinned explicitly.
 *
 * `index.ts` is what mc-compose imports. A re-export dropped from it is
 * invisible to every other test here — they all import the modules directly —
 * while breaking the only consumer that matters. Same reasoning as
 * `mc-kernel/test/public-api.test.ts`.
 *
 * The second block below is the interesting one. plan.md §3.12 makes the power
 * graph INTERNAL, and it is nevertheless re-exported, because the circuit-board
 * preview and these tests import it by name and a package that lies about its
 * own entry point is worse than one that exports too much. Pinning it here
 * records that it is deliberately visible, and docs/public-api.md records that
 * it is deliberately not contract.
 */
import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import * as redstone from '../index'
import { planPush } from '../domain/piston'
import { propagateTick } from '../domain/power-graph'
import { REDSTONE_STAGE_IDS } from '../stages/stage-ids'

describe('public API surface', () => {
  it.effect('re-exports the stage registration contract — the only thing plan.md §3.12 makes public', () =>
    Effect.sync(() => {
      const contract = [
        'redstoneStages',
        'makeRedstoneStages',
        'makeRedstoneFrameState',
        'REDSTONE_STAGE_IDS',
        'UPSTREAM_STAGE_IDS',
        'StageId',
        'DeltaTimeSecs',
      ]

      for (const name of contract) {
        expect(Object.keys(redstone)).toContain(name)
      }
    }),
  )

  it.effect('re-exports the internal power graph and piston planner, which the preview and tests drive', () =>
    Effect.sync(() => {
      const internal = [
        // power graph — internal by §3.12, visible by necessity
        'MAX_POWER_LEVEL',
        'emptyPowerMap',
        'powerAt',
        'sourcesOf',
        'propagateTick',
        'settle',
        'SETTLE_TICK_LIMIT',
        'isLit',
        // pistons — the capability lookup is a parameter, never a local set
        'PISTON_PUSH_LIMIT',
        'planPush',
        'isPistonMovable',
        // fixed-rate ticking
        'REDSTONE_TICK_SECS',
        'MAX_TICKS_PER_FRAME',
        'ticksForFrame',
        'emptyCircuitBoard',
        'EXPERIENCE_MODULE_STAGE_PREFIXES',
        'OWN_STAGE_PREFIX',
      ]

      for (const name of internal) {
        expect(Object.keys(redstone)).toContain(name)
      }
    }),
  )

  it.effect('exposes the same implementations through the barrel as through the modules', () =>
    Effect.sync(() => {
      expect(redstone.planPush).toBe(planPush)
      expect(redstone.propagateTick).toBe(propagateTick)
      expect(redstone.REDSTONE_STAGE_IDS).toBe(REDSTONE_STAGE_IDS)
    }),
  )

  it.effect('REGRESSION: exports no block roster — the immovable set belongs to mc-kernel', () =>
    Effect.sync(() => {
      // plan.md §3.12. The reference had `PISTON_IMMOVABLE_BLOCKS` as a local
      // constant (redstone-piston-world-effects.ts:12-33). Re-introducing one
      // and exporting it would make this repository an authority on blocks,
      // which is mc-kernel's job.
      const forbidden = [
        'PISTON_IMMOVABLE_BLOCKS',
        'IMMOVABLE_BLOCKS',
        'BLOCK_TYPES',
        'blockTypeToIndex',
      ]
      for (const name of forbidden) {
        expect(Object.keys(redstone)).not.toContain(name)
      }
    }),
  )

  it.effect('REGRESSION: exports nothing that would let a consumer resolve a total stage order', () =>
    Effect.sync(() => {
      // plan.md §2.3-3: the total order is mc-compose's alone.
      const forbidden = ['sortStages', 'stageOrder', 'totalOrder', 'framePipeline', 'runFrame']
      for (const name of forbidden) {
        expect(Object.keys(redstone)).not.toContain(name)
      }
    }),
  )
})
