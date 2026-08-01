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
import * as redstone from '../src/index'
import { planPush } from '../src/domain/piston'
import { propagateTick } from '../src/domain/power-graph'
import { REDSTONE_STAGE_IDS } from '../src/stages/stage-ids'

describe('public API surface', () => {
  it.effect('re-exports stage registration and the semantic world runtime port', () =>
    Effect.sync(() => {
      const contract = [
        'redstoneStages',
        'makeRedstoneStages',
        // the full plan.md §4.1 module — Layer plus an Effect-valued
        // `frameStages`. Expressible only since the vertical-slice spike; see
        // `stages/registration.ts` on why the array was the obstacle.
        'redstoneModule',
        'makeRedstoneFrameState',
        'makeRuntimeRedstoneStages',
        'RedstoneWorldRuntime',
        'RedstoneWorldRuntimeLayer',
        'REDSTONE_STAGE_IDS',
        'UPSTREAM_STAGE_IDS',
      ]

      for (const name of contract) {
        expect(Object.keys(redstone)).toContain(name)
      }
    }),
  )

  // REGRESSION: `domain/frame-contract.ts` and `domain/position-key.ts` are
  // stand-ins for @nerima-games/mc-kernel with a deletion date written into
  // their headers. The barrel used to `export *` from both, which published
  // `StageId` and `DeltaTimeSecs` as API of a package that does not own them —
  // and therefore turned the promised deletion into a breaking change for every
  // consumer. mc-sim, mc-render and mc-playground-kit mention their mirrors in
  // an `index.ts` comment and re-export nothing; this repository now matches.
  it.effect('REGRESSION: does not republish mc-kernel’s vocabulary as its own', () =>
    Effect.sync(() => {
      const kernelsToOwn = ['StageId', 'DeltaTimeSecs']
      for (const name of kernelsToOwn) {
        expect(Object.keys(redstone)).not.toContain(name)
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
        // Replaced the `SETTLE_TICK_LIMIT` constant: the bound is a property of
        // a board (one tick per delay element, +2), and no single number can
        // stand for every board. See domain/power-graph.ts.
        'settleTickLimitFor',
        'isLit',
        // the two accessors that answer "is power arriving here" through the
        // same `conductsInto` the sweep uses, so the accessor cannot leak what
        // the sweep refused (DN-RS-5 §5-1)
        'drivenPowerAt',
        'isPowered',
        // the five components of completion criterion 3. Each is a rule in its
        // own file and each is re-exported for the same reason the power graph
        // is: this repository's tests and its preview drive them by name.
        'comparatorOutput',
        'containerSignalStrength',
        'CONTAINER_SIGNAL_FLOOR',
        'CONTAINER_SIGNAL_SPAN',
        'observeChanges',
        'OBSERVER_PULSE_TICKS',
        'dispenserEdges',
        'isHopperLocked',
        'hopperTransferDue',
        'HOPPER_TRANSFER_PERIOD_TICKS',
        'HOPPER_TRANSFER_ITEMS',
        'plateSignal',
        'LIGHT_PLATE_CAPACITY',
        'HEAVY_PLATE_CAPACITY',
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

  it.effect('REGRESSION: exports no item roster either — the hopper and the dispenser move things this repository cannot name', () =>
    Effect.sync(() => {
      // The block-roster test above, one vocabulary across. `ItemType` is
      // mc-kernel's closed union (`domain/item-type.ts:128`); a hopper that
      // moves items and a dispenser that ejects them are the two rules most
      // likely to grow a local list of them, and `domain/hopper.ts` records why
      // neither may. `ContainerSlot` is the shape the comparator reads and it
      // names no item at all — count and stack size, nothing else — which is
      // what lets the rule live here with the data still elsewhere.
      const forbidden = ['ITEM_TYPES', 'ItemType', 'ItemId', 'ItemStack', 'MAX_STACK_COUNT']
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
