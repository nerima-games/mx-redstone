/**
 * What struck the target. The host classifies the projectile: arrows and tridents keep a
 * target powered longer than anything else, and this rule knows no entity types.
 */
export type TargetProjectile = 'arrow' | 'other' | 'trident'

/**
 * A hit on one face of a target block.
 *
 * `horizontal` and `vertical` are face-local coordinates: 0 and 1 are opposite
 * edges, and 0.5 is the bullseye. The caller chooses the two axes for the
 * struck face, so this rule remains independent of world coordinates and face
 * orientation.
 *
 * A hit that does not name its projectile counts as `'other'`.
 */
export type TargetHit = {
  readonly horizontal: number
  readonly vertical: number
  readonly projectile?: TargetProjectile
}

import { type NonNegativeTickCount, NonNegativeTickCount as nonNegativeTickCount } from '@nerima-games/mc-kernel'
import { MAX_POWER_LEVEL, type PowerLevel } from './signal-level.js'

const FACE_MIN = 0
const FACE_MAX = 1
const FACE_CENTER = 0.5
const MIN_HIT_SIGNAL = 1
const NO_SIGNAL = 0

const normalizedCoordinate = (coordinate: number): number => {
  if (!Number.isFinite(coordinate)) {
    return FACE_MIN
  }
  return Math.max(FACE_MIN, Math.min(FACE_MAX, coordinate))
}

/**
 * Convert an arrow impact into the target block's redstone output.
 *
 * A miss emits 0. Every actual hit emits at least 1, rising in concentric
 * square bands to 15 at the centre. Out-of-face coordinates are clamped to the
 * nearest edge so malformed collision data cannot create an invalid level.
 */
export const targetSignal = (hit: TargetHit | null): PowerLevel => {
  if (hit === null) {
    return NO_SIGNAL
  }

  const distanceFromCentre = Math.max(
    Math.abs(normalizedCoordinate(hit.horizontal) - FACE_CENTER),
    Math.abs(normalizedCoordinate(hit.vertical) - FACE_CENTER),
  )
  const distanceRatio = distanceFromCentre / FACE_CENTER

  return Math.max(MIN_HIT_SIGNAL, Math.ceil((FACE_MAX - distanceRatio) * MAX_POWER_LEVEL))
}

/**
 * How many redstone ticks a hit keeps the target powered. Java Edition `TargetBlock` (read in
 * the 1.16.5 source, and unchanged as the 1.17.1 to 1.21 constants) holds 20 game ticks for an
 * `AbstractArrow`, which includes tridents, and 8 game ticks for any other projectile.
 */
const ARROW_HOLD_TICKS = 10
const OTHER_HOLD_TICKS = 4

const TARGET_HOLD_TICKS: Readonly<Record<TargetProjectile, NonNegativeTickCount>> = {
  arrow: nonNegativeTickCount(ARROW_HOLD_TICKS),
  other: nonNegativeTickCount(OTHER_HOLD_TICKS),
  trident: nonNegativeTickCount(ARROW_HOLD_TICKS),
}

export const targetHoldTicks = (hit: TargetHit): NonNegativeTickCount =>
  TARGET_HOLD_TICKS[hit.projectile ?? 'other']
