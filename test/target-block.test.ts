import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { MAX_POWER_LEVEL } from '../src/domain/signal-level'
import { targetSignal } from '../src/domain/target-block'

const CENTRE = 0.5
const EDGE = 0
const OPPOSITE_EDGE = 1
const MID_SIGNAL = 8
const MIN_SIGNAL = 1
const MISS_SIGNAL = 0

describe('target block signal', () => {
  it.effect('a miss emits nothing and the bullseye emits full power', () =>
    Effect.sync(() => {
      expect(targetSignal(null)).toBe(MISS_SIGNAL)
      expect(targetSignal({ horizontal: CENTRE, vertical: CENTRE })).toBe(MAX_POWER_LEVEL)
    }),
  )

  it.effect('strength falls in square bands from the centre to one at every edge', () =>
    Effect.sync(() => {
      expect(targetSignal({ horizontal: 0.25, vertical: CENTRE })).toBe(MID_SIGNAL)
      expect(targetSignal({ horizontal: CENTRE, vertical: 0.75 })).toBe(MID_SIGNAL)
      expect(targetSignal({ horizontal: EDGE, vertical: CENTRE })).toBe(MIN_SIGNAL)
      expect(targetSignal({ horizontal: OPPOSITE_EDGE, vertical: OPPOSITE_EDGE })).toBe(
        MIN_SIGNAL,
      )
    }),
  )

  it.effect('the rule is deterministic and symmetric across axes and opposing edges', () =>
    Effect.sync(() => {
      const hits = [
        { horizontal: 0.2, vertical: 0.4 },
        { horizontal: 0.8, vertical: 0.4 },
        { horizontal: 0.4, vertical: 0.2 },
        { horizontal: 0.4, vertical: 0.8 },
      ]
      const readings = hits.map(targetSignal)

      const [expected] = readings
      expect(new Set(readings)).toStrictEqual(new Set([expected]))
      expect(hits.map(targetSignal)).toStrictEqual(readings)
    }),
  )

  it.effect('out-of-face and non-finite coordinates clamp to an edge-safe signal', () =>
    Effect.sync(() => {
      for (const hit of [
        { horizontal: -1, vertical: CENTRE },
        { horizontal: 2, vertical: CENTRE },
        { horizontal: Number.NaN, vertical: CENTRE },
        { horizontal: Number.POSITIVE_INFINITY, vertical: CENTRE },
      ]) {
        expect(targetSignal(hit)).toBe(MIN_SIGNAL)
      }
    }),
  )
})
