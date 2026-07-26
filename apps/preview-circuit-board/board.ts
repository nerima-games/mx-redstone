/**
 * The sandbox board: a grid of placed parts, and the two things you can derive
 * from it.
 *
 * A dev application, not shipped API.
 *
 * ---------------------------------------------------------------------------
 * The grid lives here because the power graph refuses to have one
 * ---------------------------------------------------------------------------
 *
 * `domain/power-graph.ts:23-27` states the rule plainly: there is NO geometry in
 * the power graph. Adjacency is supplied as an explicit map, because the real
 * adjacency is "the six faces of a voxel" and that belongs to mc-kernel's
 * coordinate types. So a preview that wants a board a person can move a cursor
 * around has to bring its own geometry, and this file is it: a 2D grid, four
 * neighbours per cell, `"x,y"` for a `PositionKey`.
 *
 * That is the preview standing in for the caller the library expects. In the
 * game the same job is done by whoever reads redstone components out of
 * mc-worldgen's chunks and hands `propagateTick` a board; here it is done by a
 * cursor and a palette. Neither one is the library's business, which is exactly
 * why a fixture circuit can be written as a literal in a test
 * (docs/testing.md §3-1).
 *
 * ---------------------------------------------------------------------------
 * Pistons and blocks are modelled HERE, not in the library
 * ---------------------------------------------------------------------------
 *
 * `domain/power-graph.ts` has six component kinds and a piston is not one of
 * them: it is not a thing that carries power, it is a thing that MOVES THE
 * WORLD when power arrives, and moving the world is `redstone:effects` — whose
 * `run` is `Effect.void` today because mc-sim is not published
 * (`stages/registration.ts:154-163`).
 *
 * `applyPistons` below is therefore a preview-local stand-in for that stage. It
 * calls the library's `planPush` for the DECISION (what moves, and why a push is
 * refused) and does the moving itself. Two consequences worth being explicit
 * about, because a preview that quietly implements the library is a preview that
 * lies:
 *
 *   - Nothing here is evidence that `redstone:effects` works. It is evidence
 *     that `planPush` decides correctly, which is the part this repository owns.
 *   - The two block names below are a preview FIXTURE, not a roster. The
 *     immovable set belongs to mc-kernel's capability table (`domain/piston.ts`
 *     opens with why), and `BlockCapabilityLookup` is an injected parameter
 *     precisely so that a caller — a test, or this app — can supply two blocks
 *     without anybody having to write down twenty-two.
 */
import { planPush, type BlockCapabilityLookup, type BlockRef } from '../../domain/piston'
import { powerAt, type CircuitBoard, type Component, type PowerMap } from '../../domain/power-graph'
import type { PositionKey } from '../../domain/position-key'

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export type Facing = 'right' | 'down' | 'left' | 'up'

export const FACINGS: ReadonlyArray<Facing> = ['right', 'down', 'left', 'up']

export const FACING_DELTA: Record<Facing, readonly [number, number]> = {
  right: [1, 0],
  down: [0, 1],
  left: [-1, 0],
  up: [0, -1],
}

export const OPPOSITE_FACING: Record<Facing, Facing> = {
  right: 'left',
  down: 'up',
  left: 'right',
  up: 'down',
}

export const FACING_GLYPH: Record<Facing, string> = {
  right: '>',
  down: 'v',
  left: '<',
  up: '^',
}

export type Coord = { readonly x: number; readonly y: number }

/**
 * `"x,y"`.
 *
 * A string because `PositionKey` is a string (`domain/position-key.ts`), and
 * unbranded for the same reason that file gives: the preview must not invent a
 * second coordinate vocabulary either. When kernel is published this encoding is
 * replaced by kernel's, and the only file that has to change is this one.
 */
export const keyOf = (coord: Coord): PositionKey => `${String(coord.x)},${String(coord.y)}`

export const coordOf = (key: PositionKey): Coord => {
  const [rawX = '0', rawY = '0'] = key.split(',')
  return { x: Number(rawX), y: Number(rawY) }
}

export const step = (coord: Coord, facing: Facing, distance = 1): Coord => {
  const delta = FACING_DELTA[facing]
  return { x: coord.x + delta[0] * distance, y: coord.y + delta[1] * distance }
}

export const neighbourKeys = (key: PositionKey): ReadonlyArray<PositionKey> => {
  const coord = coordOf(key)
  return FACINGS.map((facing) => keyOf(step(coord, facing)))
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

/**
 * Everything that can sit in a cell.
 *
 * The first six are `ComponentKind` and go into the power graph. `piston`,
 * `block` and `obsidian` do not — they are the world the circuit acts on.
 * `head` is the extended piston's arm; it is not placeable, it only ever appears
 * because a piston put it there.
 */
export type PartKind =
  | 'wire'
  | 'torch'
  | 'lever'
  | 'button'
  | 'repeater'
  | 'lamp'
  | 'piston'
  | 'head'
  | 'block'
  | 'obsidian'

/** The kinds that `domain/power-graph.ts` knows about. */
const GRAPH_KINDS: ReadonlySet<PartKind> = new Set<PartKind>([
  'wire',
  'torch',
  'lever',
  'button',
  'repeater',
  'lamp',
])

export const isGraphKind = (kind: PartKind): boolean => GRAPH_KINDS.has(kind)

/** The kinds a piston can shove. */
const BLOCK_KINDS: ReadonlySet<PartKind> = new Set<PartKind>(['block', 'obsidian'])

/**
 * One placed part.
 *
 * A single record with every field present rather than a discriminated union,
 * for the reason `domain/power-graph.ts:56-63` gives for `Component`: this is a
 * dense grid edited one field at a time, and a union is nicer to write and much
 * worse to store. `facing` means something different per kind and each meaning
 * is documented at its use site in `circuitBoardOf`.
 */
export type Part = {
  readonly kind: PartKind
  /** torch: the side it hangs on. repeater: OUTPUT side. piston: push direction. */
  readonly facing: Facing
  /** lever: thrown. button: held down. */
  readonly active: boolean
  /**
   * repeater: 1–4, as in vanilla.
   *
   * A PREVIEW-ONLY field. `Component` has no delay, so this number never reaches
   * the power graph; it is kept so that `[` and `]` can demonstrate that fact
   * rather than leaving vanilla's most-used repeater control absent with no
   * explanation. `stats.ts` §3 measures the four settings arriving on the same
   * tick.
   */
  readonly delayTicks: number
  /** piston: the arm is out and a `head` occupies the cell in front. */
  readonly extended: boolean
}

export const makePart = (kind: PartKind, overrides: Partial<Part> = {}): Part => ({
  kind,
  facing: overrides.facing ?? 'right',
  active: overrides.active ?? false,
  delayTicks: overrides.delayTicks ?? 1,
  extended: overrides.extended ?? false,
})

export type PartMap = ReadonlyMap<PositionKey, Part>

export type BoardSize = { readonly width: number; readonly height: number }

export const inBounds = (size: BoardSize, coord: Coord): boolean =>
  coord.x >= 0 && coord.y >= 0 && coord.x < size.width && coord.y < size.height

// ---------------------------------------------------------------------------
// Grid -> CircuitBoard
// ---------------------------------------------------------------------------

const componentOf = (parts: PartMap, key: PositionKey, part: Part): Component | undefined => {
  const coord = coordOf(key)

  if (part.kind === 'wire' || part.kind === 'lamp') {
    return { kind: part.kind }
  }

  if (part.kind === 'lever' || part.kind === 'button') {
    return { kind: part.kind, active: part.active }
  }

  if (part.kind === 'torch') {
    // `facing` is the side the torch hangs on, and the cell there is its input.
    // A torch attached to nothing burns permanently — the standard way to write
    // a constant source (`domain/power-graph.ts:117-126`) — and this is where
    // that happens: no support cell means no `invertedBy` field at all.
    const support = keyOf(step(coord, part.facing))
    const supporting = parts.get(support)
    return supporting !== undefined && isGraphKind(supporting.kind)
      ? { kind: 'torch', invertedBy: support }
      : { kind: 'torch' }
  }

  if (part.kind === 'repeater') {
    // `facing` is the OUTPUT side because that is what the arrow on the screen
    // points at; the input is behind it. BOTH ends are named, because a repeater
    // is a diode and `domain/power-graph.ts` cannot know which way this one
    // points unless the board says so — with the output unnamed it drives
    // nothing, which is the right reading of a repeater with an empty cell in
    // front of it.
    //
    // `part.delayTicks` is deliberately NOT forwarded: `Component` has no delay
    // field, because the graph does not model one. The palette still carries the
    // number so the preview can show that setting it changes nothing.
    const input = keyOf(step(coord, OPPOSITE_FACING[part.facing]))
    const output = keyOf(step(coord, part.facing))
    const feeding = parts.get(input)
    const driven = parts.get(output)
    return {
      kind: 'repeater',
      ...(feeding !== undefined && isGraphKind(feeding.kind) ? { inputFrom: input } : {}),
      ...(driven !== undefined && isGraphKind(driven.kind) ? { outputTo: output } : {}),
    }
  }

  return undefined
}

/**
 * Project the grid onto the library's board.
 *
 * Adjacency is derived here and only here. Note that a piston, a block or a
 * piston head is NOT a vertex: power does not flow through the world, it flows
 * through the circuit, and a wire on either side of a block is two circuits.
 */
export const circuitBoardOf = (parts: PartMap): CircuitBoard => {
  const components = new Map<PositionKey, Component>()

  for (const [key, part] of parts) {
    const component = componentOf(parts, key, part)
    if (component !== undefined) {
      components.set(key, component)
    }
  }

  const adjacency = new Map<PositionKey, ReadonlyArray<PositionKey>>()
  for (const key of components.keys()) {
    adjacency.set(
      key,
      neighbourKeys(key).filter((neighbour) => components.has(neighbour)),
    )
  }

  return { components, adjacency }
}

// ---------------------------------------------------------------------------
// The effects layer: pistons
// ---------------------------------------------------------------------------

/**
 * The preview's two-block capability table.
 *
 * A FIXTURE. `domain/piston.ts` opens with why this repository contains no block
 * names: the immovable set is a kernel capability flag, and every consumer that
 * writes its own list is one more place to forget a block. The lookup being an
 * injected parameter is what lets this app name exactly the two blocks it draws
 * without that list existing anywhere in the shipped source.
 */
export const PREVIEW_BLOCKS = {
  movable: 'PREVIEW_STONE' as BlockRef,
  immovable: 'PREVIEW_OBSIDIAN' as BlockRef,
} as const

export const previewCapabilities: BlockCapabilityLookup = {
  pistonImmovable: (block) => block === PREVIEW_BLOCKS.immovable,
}

const blockRefOf = (part: Part): BlockRef =>
  part.kind === 'obsidian' ? PREVIEW_BLOCKS.immovable : PREVIEW_BLOCKS.movable

export type PistonEvent = {
  readonly at: PositionKey
  readonly kind: 'extended' | 'retracted' | 'refused'
  /** One line, for the HUD. Says WHY a refusal happened, never just "no". */
  readonly detail: string
}

const isPowered = (power: PowerMap, key: PositionKey): boolean =>
  neighbourKeys(key).some((neighbour) => powerAt(power, neighbour) > 0)

/**
 * Collect the run of pushable blocks in front of a piston.
 *
 * Returns the blocks nearest-first plus the cell the run ends at, which is the
 * cell the whole column has to move into. `undefined` means the run never ends
 * inside the board — the contraption is against the wall.
 */
const columnInFront = (
  parts: PartMap,
  size: BoardSize,
  origin: Coord,
  facing: Facing,
): { readonly blocks: ReadonlyArray<Part>; readonly landing: Coord } | undefined => {
  const blocks: Array<Part> = []
  let cursor = step(origin, facing)

  while (inBounds(size, cursor)) {
    const occupant = parts.get(keyOf(cursor))
    if (occupant === undefined) {
      return { blocks, landing: cursor }
    }
    if (!BLOCK_KINDS.has(occupant.kind)) {
      // A wire, a torch or another piston in the way. Vanilla breaks some of
      // these and is stopped by others; the preview refuses, and says so.
      return undefined
    }
    blocks.push(occupant)
    cursor = step(cursor, facing)
  }

  return undefined
}

/**
 * Apply every piston on the board, once.
 *
 * This is what `redstone:effects` will do through mc-sim. Two rules that look
 * like details and are not:
 *
 *   - A piston reads the power map from the tick that just finished. The stage
 *     split exists for exactly this (`docs/public-api.md` §4-2): power settles
 *     first, the world moves second, and a piston that read power mid-sweep
 *     would move differently depending on iteration order.
 *   - Retracting does NOT bring the blocks back. That is a plain piston; the
 *     sticky one is deliberately out of scope (`domain/piston.ts:38-45`),
 *     because its capability flag has not been settled in the audit and guessing
 *     it would put a wrong flag into fourteen repositories at once.
 */
export const applyPistons = (
  parts: PartMap,
  size: BoardSize,
  power: PowerMap,
): { readonly parts: PartMap; readonly events: ReadonlyArray<PistonEvent> } => {
  const next = new Map(parts)
  const events: Array<PistonEvent> = []

  // Sorted so the outcome does not depend on Map insertion order — two pistons
  // pushing the same column must produce the same board on every run, which is
  // the same determinism requirement docs/testing.md §5 puts on the circuit.
  const pistonKeys = [...parts]
    .filter(([, part]) => part.kind === 'piston')
    .map(([key]) => key)
    .sort()

  for (const key of pistonKeys) {
    const piston = next.get(key)
    if (piston === undefined || piston.kind !== 'piston') {
      continue
    }

    const powered = isPowered(power, key)
    const origin = coordOf(key)
    const headCoord = step(origin, piston.facing)

    if (!powered && piston.extended) {
      next.delete(keyOf(headCoord))
      next.set(key, { ...piston, extended: false })
      events.push({ at: key, kind: 'retracted', detail: 'unpowered — arm withdrawn (blocks stay)' })
      continue
    }

    if (!powered || piston.extended) {
      continue
    }

    const column = columnInFront(next, size, origin, piston.facing)
    if (column === undefined) {
      events.push({
        at: key,
        kind: 'refused',
        detail: 'obstructed — the column runs into a non-block part or off the board',
      })
      continue
    }

    const outcome = planPush(column.blocks.map(blockRefOf), previewCapabilities)

    if (outcome.kind === 'refused') {
      const { reason, at } = outcome.refusal
      events.push({
        at: key,
        kind: 'refused',
        detail:
          reason === 'immovable'
            ? `immovable block ${String(at + 1)} cell(s) ahead — obsidian does not move`
            : `too-long — the column exceeds the ${String(at)}-block push limit`,
      })
      continue
    }

    // Move from the far end back, so no block overwrites its neighbour.
    for (let index = column.blocks.length - 1; index >= 0; index -= 1) {
      const from = step(origin, piston.facing, index + 1)
      const to = step(origin, piston.facing, index + 2)
      const moving = next.get(keyOf(from))
      if (moving !== undefined) {
        next.delete(keyOf(from))
        next.set(keyOf(to), moving)
      }
    }

    next.set(keyOf(headCoord), makePart('head', { facing: piston.facing }))
    next.set(key, { ...piston, extended: true })
    events.push({
      at: key,
      kind: 'extended',
      detail:
        outcome.plan.length === 0
          ? 'extended into empty space'
          : `pushed ${String(outcome.plan.length)} block(s)`,
    })
  }

  return { parts: next, events }
}
