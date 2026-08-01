/**
 * The hopper's two rules: the inversion and the cadence.
 *
 * The inversion is the interesting one. Every other component in this repository
 * acts when power arrives; a hopper STOPS. A reader who knows the rest of the
 * model writes `if (powered)` and gets a filter that is open when it should be
 * shut, which is a machine that empties itself.
 *
 * The reference models neither rule — `redstone-hopper-world-effects.ts:11-14`
 * says so in as many words ("this model transfers directly") and moves items on
 * every frame — so these expectations come from vanilla, not from it.
 */
import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import {
  HOPPER_TRANSFER_ITEMS,
  HOPPER_TRANSFER_PERIOD_TICKS,
  hopperTransferDue,
  isHopperLocked,
} from '../src/domain/hopper'
import { REDSTONE_TICK_SECS } from '../src/stages/registration'

describe('hopper locking — the one component power switches OFF', () => {
  it.effect('REGRESSION: a POWERED hopper is locked; this is the inverse of every other component', () =>
    Effect.sync(() => {
      expect(isHopperLocked(true)).toBe(true)
      expect(isHopperLocked(false)).toBe(false)
    }),
  )

  it.effect('REGRESSION: a locked hopper transfers nothing, whatever its cooldown says', () =>
    Effect.sync(() => {
      // Both halves matter. A rule that only checked the lock would transfer
      // every tick; a rule that only checked the cadence would drain a locked
      // filter every fourth tick, which is the sorting machine failing slowly
      // enough that nobody notices until the chest is empty.
      for (let ticks = 0; ticks < 20; ticks += 1) {
        expect(hopperTransferDue({ powered: true, ticksSinceTransfer: ticks })).toBe(false)
      }
    }),
  )
})

describe('hopper cadence', () => {
  it.effect('an unlocked hopper transfers once every HOPPER_TRANSFER_PERIOD_TICKS ticks', () =>
    Effect.sync(() => {
      // Driven the way a caller would: reset the counter on every transfer.
      const transfers: Array<number> = []
      let ticksSinceTransfer = HOPPER_TRANSFER_PERIOD_TICKS

      for (let tick = 0; tick < 20; tick += 1) {
        if (hopperTransferDue({ powered: false, ticksSinceTransfer })) {
          transfers.push(tick)
          ticksSinceTransfer = 0
        } else {
          ticksSinceTransfer += 1
        }
      }

      expect(transfers).toStrictEqual([0, 5, 10, 15])
    }),
  )

  it.effect('the period is four REDSTONE ticks, which is vanilla’s eight game ticks', () =>
    Effect.sync(() => {
      // Redstone runs at 10 Hz (DN-RS-3, `REDSTONE_TICK_SECS`) and the game at
      // 20, so eight game ticks is four of these. Asserted against the tick rate
      // rather than left as a comment: if the redstone rate is ever changed, a
      // constant written in the other clock's units becomes silently wrong.
      expect(HOPPER_TRANSFER_PERIOD_TICKS).toBe(4)
      expect(HOPPER_TRANSFER_PERIOD_TICKS * REDSTONE_TICK_SECS).toBeCloseTo(0.4, 10)
      expect(HOPPER_TRANSFER_ITEMS).toBe(1)
    }),
  )

  it.effect('REGRESSION: a hopper that stepped OVER its deadline still transfers, rather than waiting forever', () =>
    Effect.sync(() => {
      // `stages/registration.ts` runs up to MAX_TICKS_PER_FRAME ticks in a loop
      // and DISCARDS the excess after a long frame (DN-RS-3), so a counter can
      // jump past any particular value. An `===` here would leave that hopper
      // waiting for a number it will never see again — a machine that stops
      // after a lag spike and never restarts.
      for (const ticks of [4, 5, 9, 400]) {
        expect(hopperTransferDue({ powered: false, ticksSinceTransfer: ticks })).toBe(true)
      }
      for (const ticks of [0, 1, 2, 3]) {
        expect(hopperTransferDue({ powered: false, ticksSinceTransfer: ticks })).toBe(false)
      }
    }),
  )

  it.effect('unlocking a long-locked hopper transfers immediately, not four ticks later', () =>
    Effect.sync(() => {
      // What makes a redstone-clocked filter emit one item per PULSE rather than
      // one item per pulse that happens to coincide with the cadence. The
      // counter keeps running while the hopper is locked because the caller only
      // resets it on a transfer, and there were none.
      let ticksSinceTransfer = 0
      for (let tick = 0; tick < 30; tick += 1) {
        expect(hopperTransferDue({ powered: true, ticksSinceTransfer })).toBe(false)
        ticksSinceTransfer += 1
      }
      expect(hopperTransferDue({ powered: false, ticksSinceTransfer })).toBe(true)
    }),
  )
})
