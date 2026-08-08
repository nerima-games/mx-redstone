/**
 * Deterministic clock services for frame-stage tests.
 *
 * `FrameServices` is mc-kernel's `ClockPort`, so every stage invocation is
 * checked against the same published service contract as production hosts.
 */
import {
  EpochMillis,
  FixedClockLayer,
  type FrameServices,
  MonotonicTimeSecs,
} from '@nerima-games/mc-kernel'
import type { Layer } from 'effect'

const ZERO_MONOTONIC_SECS = 0
const ZERO_WALL_CLOCK_EPOCH_MILLIS = 0

/**
 * Everything a stage of this repository may assume is present when it runs.
 */
// eslint-disable-next-line new-cap
export const FrameServicesLayer: Layer.Layer<FrameServices> = FixedClockLayer({
  // eslint-disable-next-line new-cap
  monotonicSecs: MonotonicTimeSecs(ZERO_MONOTONIC_SECS),
  // eslint-disable-next-line new-cap
  wallClockEpochMillis: EpochMillis(ZERO_WALL_CLOCK_EPOCH_MILLIS),
})
