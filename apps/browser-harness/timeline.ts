import type { Speed } from './url-state.js'

export type TimelineAdvance = Readonly<{
  ticks: number
  remainderMs: number
}>

const REDSTONE_TICK_MS = 100
const ZERO_TIME = 0

export const advanceTimeline = (
  remainderMs: number,
  elapsedMs: number,
  speed: Speed,
): TimelineAdvance => {
  const accumulatedMs = Math.max(ZERO_TIME, remainderMs) + Math.max(ZERO_TIME, elapsedMs) * speed
  const ticks = Math.floor(accumulatedMs / REDSTONE_TICK_MS)
  return {
    ticks,
    remainderMs: accumulatedMs - ticks * REDSTONE_TICK_MS,
  }
}
