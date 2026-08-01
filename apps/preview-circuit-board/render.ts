/**
 * Three ways to look at the same circuit.
 *
 * A dev application, not shipped API.
 *
 * ---------------------------------------------------------------------------
 * Why three views and not one pretty one
 * ---------------------------------------------------------------------------
 *
 * A coloured board is an impression: every circuit renderer produces something
 * that looks like a circuit. The other two views exist to make the picture
 * falsifiable, which is the same argument mc-worldgen's preview makes for
 * printing numbers under its terrain map.
 *
 *   - `board`   — what is placed where, and roughly how hot it is.
 *   - `power`   — the exact level 0–15 in every cell, as one hex digit. "The
 *                 wire next to the lever is 14, not 15" is a sentence you can
 *                 only write after looking at this view.
 *   - `timeline`— power at a watched cell plotted against TICK. This is the one
 *                 that earns the preview its place: a signal that arrives two
 *                 ticks late looks identical to a correct one in every view that
 *                 shows only the present, and obvious here.
 *
 * All three are pure functions of (sandbox, cursor, style). Nothing in this file
 * reads `process`, which is what lets `--once` produce a byte-identical frame
 * for the same circuit and the same tick.
 */
import { isLit, MAX_POWER_LEVEL, powerAt } from '../../src/domain/power-graph'
import type { PositionKey } from '../../src/domain/position-key'
import { mix, padEnd, padStart, type Rgb, type Style } from './ansi'
import { coordOf, FACING_GLYPH, isGraphKind, keyOf, type Coord, type Part } from './board'
import { boardOf, watchedCells, type Sandbox } from './sandbox'

export type ViewMode = 'board' | 'power' | 'timeline'

export const VIEW_MODES: ReadonlyArray<ViewMode> = ['board', 'power', 'timeline']

export const isViewMode = (value: string): value is ViewMode =>
  (VIEW_MODES as ReadonlyArray<string>).includes(value)

const EMPTY: Rgb = [58, 62, 70]
const GUTTER: Rgb = [110, 118, 130]
const POWER_OFF: Rgb = [96, 42, 42]
const POWER_ON: Rgb = [255, 76, 76]
const LIT: Rgb = [255, 214, 92]
const DARK: Rgb = [120, 110, 80]
const SOURCE: Rgb = [120, 220, 140]
const WORLD: Rgb = [150, 156, 166]
const IMMOVABLE: Rgb = [176, 130, 220]
const MACHINE: Rgb = [140, 190, 240]
const CURSOR_INK: Rgb = [16, 18, 22]
const CURSOR_BACKDROP: Rgb = [236, 226, 130]

/** Red, brighter with level. Level 0 is dull rather than black so a dead wire is still visibly a wire. */
const powerColor = (level: number): Rgb => mix(POWER_OFF, POWER_ON, level / MAX_POWER_LEVEL)

const glyphFor = (part: Part, level: number, lit: boolean): { readonly glyph: string; readonly color: Rgb } => {
  if (part.kind === 'wire') {
    return { glyph: '+', color: powerColor(level) }
  }
  if (part.kind === 'torch') {
    return level > 0 ? { glyph: 'T', color: [255, 140, 90] } : { glyph: 't', color: [110, 80, 70] }
  }
  if (part.kind === 'lever') {
    return part.active ? { glyph: '/', color: SOURCE } : { glyph: '\\', color: [90, 120, 100] }
  }
  if (part.kind === 'button') {
    return part.active ? { glyph: 'B', color: SOURCE } : { glyph: 'b', color: [90, 120, 100] }
  }
  if (part.kind === 'repeater') {
    return { glyph: FACING_GLYPH[part.facing], color: powerColor(level) }
  }
  if (part.kind === 'comparator') {
    // The MODE is the glyph and the LEVEL is the colour, because a comparator's
    // level is the thing worth reading off the board — it is the only component
    // whose output is a number, and a facing arrow like the repeater's would
    // spend the glyph on the one property the HUD already reports.
    return { glyph: part.subtract ? 'S' : 'C', color: powerColor(level) }
  }
  if (part.kind === 'observer') {
    // Case follows the lever and the button: loud while it fires. A pulse two
    // ticks long is exactly the thing a final-state test cannot see, so it has
    // to be visible here.
    return part.active
      ? { glyph: 'E', color: SOURCE }
      : { glyph: 'e', color: [90, 120, 100] }
  }
  if (part.kind === 'lamp') {
    return lit ? { glyph: 'O', color: LIT } : { glyph: 'o', color: DARK }
  }
  if (part.kind === 'piston') {
    return { glyph: 'P', color: part.extended ? MACHINE : [96, 118, 140] }
  }
  if (part.kind === 'head') {
    return {
      glyph: part.facing === 'left' || part.facing === 'right' ? '=' : '"',
      color: MACHINE,
    }
  }
  if (part.kind === 'obsidian') {
    return { glyph: '%', color: IMMOVABLE }
  }
  return { glyph: '#', color: WORLD }
}

/**
 * A column ruler.
 *
 * Board coordinates appear in every HUD line and in every piston report, so
 * finding cell (13, 4) by eye has to be possible. Cells are two columns wide —
 * a terminal cell is about twice as tall as it is wide, so one character per
 * cell would draw a square board as a tall thin one and make "these two wires
 * are the same length" impossible to see.
 */
const columnRuler = (width: number, style: Style): string => {
  const digits = Array.from({ length: width }, (_, x) => `${String(x % 10)} `).join('')
  return style.dim(`    ${digits}`)
}

const rowLabel = (y: number, style: Style): string => style.paint(`${padStart(String(y), 3)} `, GUTTER)

const visibleWidth = (sandbox: Sandbox, columns: number): number =>
  Math.max(1, Math.min(sandbox.size.width, Math.floor((columns - 5) / 2)))

const visibleHeight = (sandbox: Sandbox, rows: number): number =>
  Math.max(1, Math.min(sandbox.size.height, rows - 1))

const renderGrid = (
  sandbox: Sandbox,
  cursor: Coord,
  style: Style,
  columns: number,
  rows: number,
  cellOf: (coord: Coord, part: Part | undefined) => { readonly glyph: string; readonly color: Rgb },
): ReadonlyArray<string> => {
  const width = visibleWidth(sandbox, columns)
  const height = visibleHeight(sandbox, rows)
  const lines: Array<string> = [columnRuler(width, style)]

  for (let y = 0; y < height; y += 1) {
    const cells: Array<string> = [rowLabel(y, style)]
    for (let x = 0; x < width; x += 1) {
      const coord = { x, y }
      const part = sandbox.parts.get(keyOf(coord))
      const { glyph, color } = cellOf(coord, part)
      const isCursor = cursor.x === x && cursor.y === y
      cells.push(
        isCursor
          ? style.cell(`${glyph} `, CURSOR_INK, CURSOR_BACKDROP)
          : style.cell(`${glyph} `, color, undefined),
      )
    }
    lines.push(cells.join(''))
  }

  return lines
}

const renderBoard = (
  sandbox: Sandbox,
  cursor: Coord,
  style: Style,
  columns: number,
  rows: number,
): ReadonlyArray<string> => {
  const board = boardOf(sandbox)
  return renderGrid(sandbox, cursor, style, columns, rows, (coord, part) => {
    if (part === undefined) {
      return { glyph: '.', color: EMPTY }
    }
    const key = keyOf(coord)
    return glyphFor(part, powerAt(sandbox.power, key), isLit(board, sandbox.power, key))
  })
}

/**
 * The measurement view: one hex digit per powered cell.
 *
 * Parts that are not in the power graph keep their board glyph, dimmed. A digit
 * on a piston would be a lie — a piston has no entry in the power map, it reads
 * its neighbours (`board.ts`, `applyPistons`).
 */
const renderPower = (
  sandbox: Sandbox,
  cursor: Coord,
  style: Style,
  columns: number,
  rows: number,
): ReadonlyArray<string> =>
  renderGrid(sandbox, cursor, style, columns, rows, (coord, part) => {
    if (part === undefined) {
      return { glyph: '.', color: EMPTY }
    }
    const key = keyOf(coord)
    if (!isGraphKind(part.kind)) {
      const { glyph } = glyphFor(part, 0, false)
      return { glyph, color: EMPTY }
    }
    const level = powerAt(sandbox.power, key)
    return { glyph: level.toString(16), color: powerColor(level) }
  })

const HEX = '0123456789abcdef'

const levelGlyph = (level: number): string => HEX.charAt(Math.min(Math.max(level, 0), MAX_POWER_LEVEL))

const describeWatched = (sandbox: Sandbox, key: PositionKey): string => {
  const part = sandbox.parts.get(key)
  return `${padStart(key, 6)} ${part === undefined ? '-' : part.kind.slice(0, 8)}`
}

/**
 * Power at each watched cell, one column per tick, oldest on the left.
 *
 * The single most useful thing in this app. `test/power-graph.test.ts` can
 * assert that a lamp ends up lit; only a tape like this shows that it lit two
 * ticks after it should have, and only a tape like this makes the difference
 * between a 1-tick repeater and a 4-tick repeater visible as a difference rather
 * than as a number in a struct nobody reads.
 */
const renderTimeline = (
  sandbox: Sandbox,
  style: Style,
  columns: number,
  rows: number,
): ReadonlyArray<string> => {
  const watched = watchedCells(sandbox, Math.max(1, rows - 5))
  const labelWidth = 16
  const span = Math.max(8, columns - labelWidth - 2)
  const history = sandbox.history.slice(-span)

  if (watched.length === 0) {
    return [
      style.dim('nothing is being watched yet.'),
      style.dim('move the cursor onto a part and press m to plot its power against tick.'),
    ]
  }

  const ticks = history.map((entry) => entry.tick)
  const ruler = ticks
    .map((tick) => (tick % 10 === 0 ? style.paint('|', GUTTER) : style.dim('-')))
    .join('')
  const firstTick = ticks[0] ?? 0
  const lastTick = ticks[ticks.length - 1] ?? 0

  const lines: Array<string> = [
    style.dim(`${' '.repeat(labelWidth)}tick ${String(firstTick)} .. ${String(lastTick)}  (| marks every 10th tick)`),
    `${' '.repeat(labelWidth)}${ruler}`,
  ]

  for (const key of watched) {
    const cells = history
      .map((entry) => {
        const level = powerAt(entry.power, key)
        return style.paint(levelGlyph(level), level === 0 ? EMPTY : powerColor(level))
      })
      .join('')
    lines.push(`${style.paint(padEnd(describeWatched(sandbox, key), labelWidth), GUTTER)}${cells}`)
  }

  lines.push('')
  lines.push(
    style.dim(
      'each column is one redstone tick; each character is that cell’s power level in hex (0-f).',
    ),
  )

  return lines
}

export const renderView = (
  mode: ViewMode,
  sandbox: Sandbox,
  cursor: Coord,
  style: Style,
  columns: number,
  rows: number,
): ReadonlyArray<string> => {
  if (mode === 'power') {
    return renderPower(sandbox, cursor, style, columns, rows)
  }
  if (mode === 'timeline') {
    return renderTimeline(sandbox, style, columns, rows)
  }
  return renderBoard(sandbox, cursor, style, columns, rows)
}

/**
 * The rows a scenario actually occupies, plus one.
 *
 * `--once` writes to stdout so a frame can be pasted into an issue, and eight
 * rows of empty board underneath a two-row circuit is exactly the noise that
 * makes people screenshot instead. Interactive mode does NOT use this: a sandbox
 * you are placing parts in needs the empty space visible.
 */
export const contentRows = (sandbox: Sandbox): number => {
  let lowest = 0
  for (const key of sandbox.parts.keys()) {
    lowest = Math.max(lowest, coordOf(key).y)
  }
  return Math.min(sandbox.size.height, lowest + 2)
}

/** Whether the board is wider or taller than the frame it was drawn into. */
export const isClipped = (sandbox: Sandbox, columns: number, rows: number): boolean =>
  visibleWidth(sandbox, columns) < sandbox.size.width ||
  visibleHeight(sandbox, rows) < sandbox.size.height

export const LEGEND: ReadonlyArray<string> = [
  '+ wire   T/t torch   / \\ lever   B/b button   > < ^ v repeater   O/o lamp',
  'C comparator (compare)   S comparator (subtract)   E/e observer (E = pulsing)',
  'P piston   = " arm   # block   % obsidian (pistonImmovable)   . empty',
]
