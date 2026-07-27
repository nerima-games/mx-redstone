/**
 * How many occupants become how much signal.
 *
 * The reference only has the switch (`redstone-simulation.ts:40` — a plate is a
 * source when `state.active`), so the weighted arithmetic here is ported from
 * vanilla. What it must get right is the bottom of the curve: a heavy plate is
 * used to COUNT, and a formula that rounded would report nothing until the
 * eleventh entity arrived, which reads to a player as a plate that does not work.
 */
import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import {
  HEAVY_PLATE_CAPACITY,
  LIGHT_PLATE_CAPACITY,
  plateSignal,
  type PlateWeighing,
} from '../domain/pressure-plate'
import { MAX_POWER_LEVEL } from '../domain/signal-level'

const BINARY: PlateWeighing = { kind: 'binary' }
const LIGHT: PlateWeighing = { kind: 'weighted', capacity: LIGHT_PLATE_CAPACITY }
const HEAVY: PlateWeighing = { kind: 'weighted', capacity: HEAVY_PLATE_CAPACITY }

describe('pressure plate signal', () => {
  it.effect('an empty plate emits nothing, whichever kind it is', () =>
    Effect.sync(() => {
      for (const weighing of [BINARY, LIGHT, HEAVY]) {
        expect(plateSignal(0, weighing)).toBe(0)
      }
    }),
  )

  it.effect('a stone or wooden plate is a switch: anything on it is full power', () =>
    Effect.sync(() => {
      for (const occupants of [1, 2, 15, 150, 10_000]) {
        expect(plateSignal(occupants, BINARY)).toBe(MAX_POWER_LEVEL)
      }
    }),
  )

  it.effect('REGRESSION: ONE entity on a heavy plate reads 1, not 0 — a counter must count from one', () =>
    Effect.sync(() => {
      // The whole use of a weighted plate is telling "none" apart from "some".
      // `Math.round(1 / 150 * 15)` is 0, and a plate that reports nothing until
      // the eleventh entity is a plate a player throws away.
      expect(plateSignal(1, HEAVY)).toBe(1)
      expect(plateSignal(10, HEAVY)).toBe(1)
      expect(plateSignal(11, HEAVY)).toBe(2)
    }),
  )

  it.effect('a light plate counts one for one, and a heavy plate counts in tens', () =>
    Effect.sync(() => {
      // The two capacities are what the plates are FOR: gold reads individual
      // items, iron reads bulk.
      for (let occupants = 1; occupants <= LIGHT_PLATE_CAPACITY; occupants += 1) {
        expect(plateSignal(occupants, LIGHT)).toBe(occupants)
      }
      expect(plateSignal(HEAVY_PLATE_CAPACITY, HEAVY)).toBe(MAX_POWER_LEVEL)
      // Half capacity is 7.5 levels, and the ceiling makes it 8 rather than 7.
      // The rounding direction is the same decision as the floor above: a
      // weighted plate that under-reports is a plate that misses the thing it
      // was placed to detect.
      expect(plateSignal(HEAVY_PLATE_CAPACITY / 2, HEAVY)).toBe(8)
      expect(plateSignal(HEAVY_PLATE_CAPACITY / 3, HEAVY)).toBe(5)
    }),
  )

  it.effect('both weighted plates saturate rather than overflowing the signal range', () =>
    Effect.sync(() => {
      for (const weighing of [LIGHT, HEAVY]) {
        for (const occupants of [1, 7, 200, 5000]) {
          const signal = plateSignal(occupants, weighing)
          expect(Number.isInteger(signal)).toBe(true)
          expect(signal).toBeGreaterThanOrEqual(0)
          expect(signal).toBeLessThanOrEqual(MAX_POWER_LEVEL)
        }
        expect(plateSignal(100_000, weighing)).toBe(MAX_POWER_LEVEL)
      }
    }),
  )

  it.effect('the reading never falls as occupants arrive', () =>
    Effect.sync(() => {
      for (const weighing of [BINARY, LIGHT, HEAVY]) {
        let previous = 0
        for (let occupants = 0; occupants <= 200; occupants += 1) {
          const signal = plateSignal(occupants, weighing)
          expect(signal).toBeGreaterThanOrEqual(previous)
          previous = signal
        }
      }
    }),
  )

  it.effect('REGRESSION: a nonsense count or capacity degrades to a plate, never to NaN', () =>
    Effect.sync(() => {
      // A NaN level would go into the power map and propagate: `NaN > 0` is
      // false, so every cell downstream would read unpowered and the plate would
      // look broken rather than mis-configured. Same argument as mc-sim's
      // `heldCount` (domain/inventory.ts).
      expect(plateSignal(Number.NaN, HEAVY)).toBe(0)
      expect(plateSignal(-3, HEAVY)).toBe(0)
      expect(plateSignal(Number.POSITIVE_INFINITY, HEAVY)).toBe(0)

      expect(plateSignal(1, { kind: 'weighted', capacity: 0 })).toBe(MAX_POWER_LEVEL)
      expect(plateSignal(1, { kind: 'weighted', capacity: Number.NaN })).toBe(MAX_POWER_LEVEL)
      expect(plateSignal(0, { kind: 'weighted', capacity: 0 })).toBe(0)
    }),
  )
})
