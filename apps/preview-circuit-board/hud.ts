/**
 * The status panel under the board.
 *
 * A dev application, not shipped API.
 *
 * The HUD is not decoration. A coloured grid is unfalsifiable on its own —
 * every circuit renderer produces something that looks like a circuit. The HUD
 * prints the numbers the picture is claiming: which tick it is, what the cell
 * under the cursor actually holds and at what level, how many lamps are lit, how
 * long the circuit takes to settle under the library's own limit AND under a
 * limit that cannot be hit. When those last two disagree, the panel says so in
 * as many words, because "oscillating" is a verdict a reader will otherwise
 * believe.
 */
import type { Rgb, Style } from './ansi'
import { keyOf, type Coord, type Facing, type PartKind } from './board'
import { LEGEND, type ViewMode } from './render'
import { boardStats, describeCell, settleReport, type Sandbox } from './sandbox'

const LABEL: Rgb = [150, 160, 175]
const VALUE: Rgb = [235, 240, 246]
const WARN: Rgb = [255, 150, 60]
const GOOD: Rgb = [130, 220, 150]

export type HudState = {
  readonly cursor: Coord
  readonly view: ViewMode
  readonly palette: PartKind
  readonly facing: Facing
  readonly delayTicks: number
  readonly runTicks: number
  readonly clipped: boolean
}

/** How many terminal rows `buildHud` needs. Kept next to it so they cannot drift. */
export const HUD_ROWS = 8

const field = (style: Style, label: string, value: string): string =>
  `${style.paint(label, LABEL)} ${style.paint(value, VALUE)}`

const describeSettle = (style: Style, sandbox: Sandbox): string => {
  const report = settleReport(sandbox)

  if (!report.oscillating) {
    return [
      field(style, 'settles in', `${String(report.ticks)} tick(s)`),
      // The limit is a property of THIS board (one tick per delay element, +2),
      // so it is read from the report rather than from a constant.
      style.dim(`limit ${String(report.limit)}`),
    ].join('  ')
  }

  if (report.oscillatingUnbounded) {
    return [
      `${style.paint('settle', LABEL)} ${style.paint('OSCILLATING', WARN)}`,
      style.dim(`still changing after ${String(report.ticks)} ticks, and after 4096 — a real clock`),
    ].join('  ')
  }

  // The interesting case: the library says "oscillating", a longer search says
  // "settles". The circuit is fine; the bound is too small. This is what a
  // constant derived from wire decay produced for every long repeater chain, and
  // the panel keeps the case so that a future bound which is also too small is
  // read off the screen rather than believed.
  return [
    `${style.paint('settle', LABEL)} ${style.paint('OSCILLATING (false alarm)', WARN)}`,
    style.paint(
      `— settles at tick ${String(report.ticksUnbounded)}, past this board's limit of ${String(report.limit)}`,
      GOOD,
    ),
  ].join('  ')
}

const describePistons = (style: Style, sandbox: Sandbox): string => {
  if (sandbox.events.length === 0) {
    return style.dim('pistons  nothing moved last tick')
  }
  return sandbox.events
    .slice(0, 3)
    .map((event) => {
      const color = event.kind === 'refused' ? WARN : VALUE
      return `${style.paint(`piston ${event.at}`, LABEL)} ${style.paint(`${event.kind}: ${event.detail}`, color)}`
    })
    .join('   ')
}

export const buildHud = (
  state: HudState,
  sandbox: Sandbox,
  style: Style,
): ReadonlyArray<string> => {
  const stats = boardStats(sandbox)
  const scenarioLine = [
    style.bold(style.paint('mx-redstone circuit board', VALUE)),
    field(style, 'scenario', sandbox.scenario),
    field(style, 'view', state.view),
    field(style, 'tick', String(sandbox.tick)),
    state.clipped ? style.paint('board is larger than this window', WARN) : '',
  ]
    .filter((part) => part !== '')
    .join('  ')

  const cursorLine = [
    field(style, 'cursor', keyOf(state.cursor)),
    style.paint(describeCell(sandbox, state.cursor), VALUE),
  ].join('  ')

  const paletteLine = [
    field(style, 'place', state.palette),
    field(style, 'facing', state.facing),
    // Labelled as unmodelled on the panel itself: the graph has no delay field,
    // and a number on screen with no marking is a claim that it does something.
    field(style, 'repeater delay', `${String(state.delayTicks)} (not modelled)`),
    field(style, 'n runs', `${String(state.runTicks)} ticks`),
  ].join('  ')

  const statsLine = [
    field(style, 'parts', String(stats.parts)),
    field(style, 'in graph', String(stats.components)),
    field(style, 'powered', String(stats.powered)),
    field(style, 'lamps lit', `${String(stats.litLamps)}/${String(stats.lamps)}`),
    field(style, 'max level', String(stats.maxPower)),
  ].join('  ')

  const notes = sandbox.note === '' ? style.dim('—') : style.paint(sandbox.note, VALUE)

  return [
    scenarioLine,
    cursorLine,
    paletteLine,
    statsLine,
    describeSettle(style, sandbox),
    describePistons(style, sandbox),
    `${style.paint('last', LABEL)} ${notes}`,
    style.dim(KEY_HINT),
  ]
}

export const KEY_HINT =
  'arrows/hjkl move  space place  e erase  f rotate  t toggle  1-9 0 - palette  [ ] delay  . step  n run  s settle  r reset  c clear  o scenario  m watch  v view  ? help  x quit'

/**
 * The help overlay.
 *
 * Deliberately the same text as `--help`'s key section: a person who learned the
 * keys from one should not have to relearn them from the other.
 */
export const buildHelp = (style: Style): ReadonlyArray<string> => [
  style.bold('mx-redstone circuit board — keys'),
  '',
  ...KEY_SECTIONS.map((line) => style.dim(line)),
  '',
  style.bold('legend'),
  ...LEGEND.map((line) => style.dim(line)),
  '',
  style.dim('press any key to return'),
]

export const KEY_SECTIONS: ReadonlyArray<string> = [
  '  arrows / hjkl     move the cursor           (HJKL moves 5)',
  '  space / enter     place the selected part',
  '  e                 erase the cell',
  '  f                 rotate: torch support, repeater/comparator output, observer eye, piston push',
  '  t                 throw a lever / press a button / switch a comparator between compare and subtract',
  '  1-9 0 -           wire torch lever button repeater comparator observer lamp piston block obsidian',
  '  [ ]               repeater delay 1-4 — preview-only; the graph does not model delay',
  '  .                 step ONE redstone tick',
  '  n                 run --run-ticks ticks (default 10)',
  '  s                 settle: run until the power map stops changing',
  '  r                 reset the power map and the tick counter (the board stays)',
  '  c                 clear the board',
  '  o / O             next / previous scenario',
  '  m                 watch this cell in the timeline view',
  '  v                 cycle view: board -> power -> timeline',
  '  ?                 this help          x  Esc  Ctrl-C   quit',
]

/** Scenario notes, wrapped for the help overlay and the first frame. */
export const buildNotes = (style: Style, notes: ReadonlyArray<string>, title: string): ReadonlyArray<string> => [
  style.paint(title, VALUE),
  ...notes.map((note) => style.dim(`  · ${note}`)),
]
