/**
 * The sandbox: a board, a power map, a tick counter and the history behind it.
 *
 * A dev application, not shipped API.
 *
 * ---------------------------------------------------------------------------
 * Why stepping is the primary verb
 * ---------------------------------------------------------------------------
 *
 * A test asserts a FINAL state. That makes a whole class of redstone defect
 * invisible to it: a signal that arrives two ticks late still arrives, a
 * repeater that ignores its delay still repeats, a latch that settles the right
 * way for the wrong reason still settles. Every one of those is obvious the
 * moment you can advance the circuit one tick at a time and watch where the
 * power is.
 *
 * So this module keeps three things a test would not bother with:
 *
 *   - `tick`, shown on screen, because "how many ticks did that take" is the
 *     question the preview exists to answer.
 *   - `history`, a rolling record of the power map at every tick, which is what
 *     the timeline view draws. A power level plotted against time is a
 *     measurement; a coloured board is an impression.
 *   - `events`, the piston outcomes from the last tick, including refusals.
 *     A refusal that is not displayed is indistinguishable from a piston that
 *     did nothing for no reason.
 *
 * ---------------------------------------------------------------------------
 * No clock
 * ---------------------------------------------------------------------------
 *
 * `tick` is incremented by a keystroke. There is no timer, no animation loop and
 * no wall-clock read anywhere in this app, so the `Date.now()` ban costs nothing
 * and the `mc-kernel-allow-time-source` escape hatch is not taken. That is not
 * an accident of the UI: a redstone tick is a fixed-rate counter on purpose
 * (`stages/registration.ts:11-27`), and a preview that advanced circuits on a
 * wall clock would show a different circuit on a faster machine.
 */
import {
  emptyPowerMap,
  isLit,
  powerAt,
  propagateTick,
  settle,
  settleTickLimitFor,
  type CircuitBoard,
  type PowerMap,
} from '../../domain/power-graph'
import type { PositionKey } from '../../domain/position-key'
import {
  applyPistons,
  circuitBoardOf,
  inBounds,
  isGraphKind,
  keyOf,
  makePart,
  OPPOSITE_FACING,
  step,
  type BoardSize,
  type Coord,
  type Facing,
  type Part,
  type PartKind,
  type PistonEvent,
} from './board'

/**
 * How many ticks of history the timeline keeps.
 *
 * Enough to see a slow repeater chain arrive and a clock repeat several times,
 * and small enough that the memory is a rounding error. When it overflows the
 * OLDEST entry is dropped, so the timeline always ends at "now" — a timeline
 * that scrolled away from the tick you just executed would be useless.
 */
export const HISTORY_LIMIT = 256

/** Vanilla's repeater delays. */
export const MIN_REPEATER_DELAY = 1
export const MAX_REPEATER_DELAY = 4

export type HistoryEntry = {
  readonly tick: number
  readonly power: PowerMap
}

export type Sandbox = {
  readonly size: BoardSize
  parts: Map<PositionKey, Part>
  power: PowerMap
  tick: number
  history: Array<HistoryEntry>
  watched: Array<PositionKey>
  events: ReadonlyArray<PistonEvent>
  /** One line describing what the last keystroke did. */
  note: string
  scenario: string
}

export const makeSandbox = (
  size: BoardSize,
  parts: ReadonlyMap<PositionKey, Part>,
  options: { readonly watched?: ReadonlyArray<PositionKey>; readonly scenario?: string } = {},
): Sandbox => ({
  size,
  parts: new Map(parts),
  power: emptyPowerMap,
  tick: 0,
  history: [{ tick: 0, power: emptyPowerMap }],
  watched: [...(options.watched ?? [])],
  events: [],
  note: '',
  scenario: options.scenario ?? 'sandbox',
})

export const boardOf = (sandbox: Sandbox): CircuitBoard => circuitBoardOf(sandbox.parts)

const record = (sandbox: Sandbox): void => {
  sandbox.history.push({ tick: sandbox.tick, power: sandbox.power })
  if (sandbox.history.length > HISTORY_LIMIT) {
    sandbox.history.shift()
  }
}

/**
 * Advance one redstone tick: power first, then the world.
 *
 * The order is the whole reason `redstone:power` and `redstone:effects` are two
 * stages rather than one (docs/public-api.md §4-2). Doing it the other way round
 * — moving a piston and then computing power — makes the board a function of the
 * order the pistons happened to be iterated in.
 */
export const stepOnce = (sandbox: Sandbox): void => {
  const board = boardOf(sandbox)
  sandbox.power = propagateTick(board, sandbox.power)
  sandbox.tick += 1

  const applied = applyPistons(sandbox.parts, sandbox.size, sandbox.power)
  sandbox.parts = new Map(applied.parts)
  sandbox.events = applied.events

  record(sandbox)
}

export const runTicks = (sandbox: Sandbox, count: number): void => {
  for (let index = 0; index < Math.max(0, Math.floor(count)); index += 1) {
    stepOnce(sandbox)
  }
}

/**
 * A limit no acyclic circuit on a board this size can reach.
 *
 * Every sequential element (a torch, a repeater) costs one tick, so the worst
 * case is bounded by the number of cells. 4096 is more than a screen-sized board
 * can hold and still returns instantly, which is what makes "did the default
 * limit lie?" a question the preview can ask on every frame.
 */
export const UNBOUNDED_SETTLE_LIMIT = 4096

export type SettleReport = {
  readonly ticks: number
  readonly oscillating: boolean
  /** What `settleTickLimitFor` allowed this board — one per delay element, +2. */
  readonly limit: number
  /**
   * The verdict the library's default limit gives, and the verdict a generous
   * limit gives. These used to disagree for any chain of sixteen or more
   * sequential elements, because the default was a constant derived from wire
   * decay; the preview is where that showed up and the pair is kept so it can
   * show up again.
   */
  readonly ticksUnbounded: number
  readonly oscillatingUnbounded: boolean
}

/**
 * How long this circuit takes to stop changing, asked twice.
 *
 * Once with `settle`'s default limit — `settleTickLimitFor(board)` — and once
 * with a limit large enough that no acyclic circuit can hit it. The preview
 * shows both because the two answers must agree for every acyclic circuit, and
 * a disagreement means the default bound is too small. They disagreed for every
 * repeater chain of sixteen or more until the bound stopped being derived from
 * the longest possible wire run.
 *
 * The board is not advanced by this — it is a question, not a step. Pressing the
 * settle key advances the sandbox by the number of ticks reported here, so the
 * history records every intermediate state rather than jumping to the end.
 */
export const settleReport = (sandbox: Sandbox): SettleReport => {
  const board = boardOf(sandbox)
  const bounded = settle(board, { from: sandbox.power })
  const unbounded = settle(board, { from: sandbox.power, limit: UNBOUNDED_SETTLE_LIMIT })
  return {
    ticks: bounded.ticks,
    oscillating: bounded.oscillating,
    limit: settleTickLimitFor(board),
    ticksUnbounded: unbounded.ticks,
    oscillatingUnbounded: unbounded.oscillating,
  }
}

/**
 * Step until stable, or until the library's own limit says "oscillating".
 *
 * `report.ticks` is already the limit when the search gave up, so one field
 * covers both cases.
 */
export const settleSandbox = (sandbox: Sandbox): SettleReport => {
  const report = settleReport(sandbox)
  runTicks(sandbox, report.ticks)
  return report
}

export const resetPower = (sandbox: Sandbox): void => {
  sandbox.power = emptyPowerMap
  sandbox.tick = 0
  sandbox.history = [{ tick: 0, power: emptyPowerMap }]
  sandbox.events = []
  // Retract every piston: the power map is gone, so leaving an arm out would
  // show a piston extended with nothing powering it.
  // A snapshot, because the loop deletes piston arms as it goes.
  for (const [key, part] of Array.from(sandbox.parts)) {
    if (part.kind === 'head') {
      sandbox.parts.delete(key)
    }
    if (part.kind === 'piston' && part.extended) {
      sandbox.parts.set(key, { ...part, extended: false })
    }
  }
}

export const clearBoard = (sandbox: Sandbox): void => {
  sandbox.parts = new Map()
  sandbox.watched = []
  resetPower(sandbox)
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

export const placeAt = (sandbox: Sandbox, coord: Coord, kind: PartKind, facing: Facing, delayTicks: number): string => {
  if (!inBounds(sandbox.size, coord)) {
    return 'outside the board'
  }
  const key = keyOf(coord)
  const existing = sandbox.parts.get(key)
  if (existing?.kind === 'head') {
    return 'a piston arm is in the way — unpower it first'
  }
  sandbox.parts.set(key, makePart(kind, { facing, delayTicks }))
  return `placed ${kind} at ${key}`
}

export const eraseAt = (sandbox: Sandbox, coord: Coord): string => {
  const key = keyOf(coord)
  const existing = sandbox.parts.get(key)
  if (existing === undefined) {
    return `${key} is already empty`
  }
  if (existing.kind === 'head') {
    return 'a piston arm is not erasable — unpower the piston'
  }
  sandbox.parts.delete(key)
  if (existing.kind === 'piston' && existing.extended) {
    // The arm is a separate cell. Leaving it behind would put an unattached
    // piston head on the board with nothing holding it.
    sandbox.parts.delete(keyOf(step(coord, existing.facing)))
  }
  sandbox.watched = sandbox.watched.filter((watched) => watched !== key)
  return `erased ${existing.kind} at ${key}`
}

/**
 * Throw a lever, or press a button.
 *
 * A button here LATCHES, and that is not a UI shortcut — it is the library's
 * behaviour showing through. `Component.active` is a boolean and nothing in the
 * repository counts a pulse down, so a pressed button stays pressed forever.
 * See `README.md` in this directory: the preview displays it rather than hiding
 * it behind a preview-local timer.
 */
export const toggleAt = (sandbox: Sandbox, coord: Coord): string => {
  const key = keyOf(coord)
  const part = sandbox.parts.get(key)
  if (part === undefined) {
    return `nothing at ${key}`
  }
  if (part.kind !== 'lever' && part.kind !== 'button') {
    return `${part.kind} has nothing to toggle`
  }
  sandbox.parts.set(key, { ...part, active: !part.active })
  return `${part.kind} at ${key} is now ${part.active ? 'off' : 'on'}`
}

export const rotateAt = (sandbox: Sandbox, coord: Coord, facing: Facing): string => {
  const key = keyOf(coord)
  const part = sandbox.parts.get(key)
  if (part === undefined) {
    return `nothing at ${key} — the palette facing is now ${facing}`
  }
  sandbox.parts.set(key, { ...part, facing })
  return `${part.kind} at ${key} now faces ${facing}`
}

export const setDelayAt = (sandbox: Sandbox, coord: Coord, delayTicks: number): string => {
  const key = keyOf(coord)
  const part = sandbox.parts.get(key)
  if (part?.kind !== 'repeater') {
    return `the palette repeater delay is now ${String(delayTicks)}`
  }
  sandbox.parts.set(key, { ...part, delayTicks })
  return `repeater at ${key} set to ${String(delayTicks)} tick(s) — watch whether it changes anything`
}

export const toggleWatch = (sandbox: Sandbox, coord: Coord): string => {
  const key = keyOf(coord)
  if (sandbox.watched.includes(key)) {
    sandbox.watched = sandbox.watched.filter((watched) => watched !== key)
    return `stopped watching ${key}`
  }
  if (!sandbox.parts.has(key)) {
    return `nothing at ${key} to watch`
  }
  sandbox.watched = [...sandbox.watched, key]
  return `watching ${key}`
}

// ---------------------------------------------------------------------------
// Read-only queries the HUD and the views need
// ---------------------------------------------------------------------------

/**
 * The cells the timeline plots.
 *
 * User marks win. With none, the interesting cells are picked automatically —
 * outputs first, then sources — because a preview that shows an empty timeline
 * until you have marked something teaches you nothing on the first frame.
 */
export const watchedCells = (sandbox: Sandbox, limit = 8): ReadonlyArray<PositionKey> => {
  if (sandbox.watched.length > 0) {
    return sandbox.watched.slice(0, limit)
  }

  const byPriority: Record<string, number> = {
    lamp: 0,
    repeater: 1,
    torch: 2,
    lever: 3,
    button: 4,
    piston: 5,
  }

  return [...sandbox.parts]
    .filter(([, part]) => byPriority[part.kind] !== undefined)
    .sort(([leftKey, left], [rightKey, right]) => {
      const rank = (byPriority[left.kind] ?? 9) - (byPriority[right.kind] ?? 9)
      return rank === 0 ? leftKey.localeCompare(rightKey) : rank
    })
    .slice(0, limit)
    .map(([key]) => key)
}

export type BoardStats = {
  readonly parts: number
  readonly components: number
  readonly powered: number
  readonly litLamps: number
  readonly lamps: number
  readonly maxPower: number
}

export const boardStats = (sandbox: Sandbox): BoardStats => {
  const board = boardOf(sandbox)
  let powered = 0
  let maxPower = 0
  for (const key of board.components.keys()) {
    const level = powerAt(sandbox.power, key)
    if (level > 0) {
      powered += 1
    }
    maxPower = Math.max(maxPower, level)
  }

  const lamps = [...board.components].filter(([, component]) => component.kind === 'lamp')

  return {
    parts: sandbox.parts.size,
    components: board.components.size,
    powered,
    lamps: lamps.length,
    litLamps: lamps.filter(([key]) => isLit(board, sandbox.power, key)).length,
    maxPower,
  }
}

/** What the cell under the cursor is, in one line. */
export const describeCell = (sandbox: Sandbox, coord: Coord): string => {
  const key = keyOf(coord)
  const part = sandbox.parts.get(key)
  if (part === undefined) {
    return 'empty'
  }

  const level = powerAt(sandbox.power, key)
  const board = boardOf(sandbox)

  const details: Array<string> = [part.kind]
  if (part.kind === 'lever' || part.kind === 'button') {
    details.push(part.active ? 'on' : 'off')
  }
  if (part.kind === 'repeater') {
    details.push(`facing ${part.facing}`, `delay ${String(part.delayTicks)} (not modelled)`)
    const input = keyOf(step(coord, OPPOSITE_FACING[part.facing]))
    const output = keyOf(step(coord, part.facing))
    details.push(board.components.has(input) ? `input ${input}` : 'no input')
    // A repeater is a diode: this is the only cell it drives, and an unnamed
    // output is a repeater wired to nothing rather than one wired to everything.
    details.push(board.components.has(output) ? `output ${output}` : 'no output')
  }
  if (part.kind === 'torch') {
    details.push(`on ${part.facing}`)
    const support = keyOf(step(coord, part.facing))
    details.push(board.components.has(support) ? `inverts ${support}` : 'unattached — burns always')
  }
  if (part.kind === 'piston') {
    details.push(`pushes ${part.facing}`, part.extended ? 'extended' : 'retracted')
  }
  if (part.kind === 'lamp') {
    details.push(isLit(board, sandbox.power, key) ? 'LIT' : 'dark')
  }
  if (isGraphKind(part.kind)) {
    details.push(`power ${String(level)}`)
  }

  return details.join('  ')
}
