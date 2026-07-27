/**
 * Command-line options for the circuit-board preview.
 *
 * A dev application, not shipped API.
 *
 * Pure: `parseArguments` reads an array and returns a value. It never touches
 * `process`, so the whole option surface is exercisable without launching a
 * terminal UI — which matters because a parser that can only be tested by
 * starting a full-screen app is a parser nobody tests.
 *
 * Adapted from mc-worldgen's `apps/preview-terrain/options.ts`, including its
 * two hard-won behaviours: `--` is accepted and ignored (pnpm 9 forwards a
 * literal one when somebody writes `pnpm preview -- --stats` out of npm habit),
 * and an unknown flag is an ERROR rather than a silent no-op. A dropped
 * `--scenario` is a preview showing the wrong circuit with full confidence.
 */
import { DEFAULT_SCENARIO, SCENARIO_NAMES, SCENARIOS } from './scenarios'
import { isViewMode, VIEW_MODES, type ViewMode } from './render'

/**
 * The board a scenario is drawn on.
 *
 * Fixed rather than sized to the terminal, and that is deliberate: a board whose
 * width depends on the window is a board where "the wire runs off the edge"
 * means something different on every machine, and the whole point of this app is
 * that a circuit behaves the same everywhere. The window clips the view; it does
 * not change the circuit.
 */
export const DEFAULT_BOARD_WIDTH = 36
export const DEFAULT_BOARD_HEIGHT = 14

/** How many ticks the `n` key advances. Ten is one vanilla second of redstone. */
export const DEFAULT_RUN_TICKS = 10

export type PreviewOptions = {
  readonly scenario: string
  readonly view: ViewMode
  readonly width: number
  readonly height: number
  readonly runTicks: number
  /** Advance this many ticks before drawing. Makes `--once` show a settled circuit. */
  readonly ticks: number
  readonly once: boolean
  /** Throw every lever and hold every button before drawing. */
  readonly leversOn: boolean
  /** Glyphs instead of colour, so a frame can be pasted into an issue or a diff. */
  readonly ascii: boolean
  readonly stats: boolean
  readonly list: boolean
  readonly help: boolean
  readonly frameWidth: number | undefined
  readonly frameHeight: number | undefined
  readonly errors: ReadonlyArray<string>
}

const DEFAULTS = {
  scenario: DEFAULT_SCENARIO,
  view: 'board',
  width: DEFAULT_BOARD_WIDTH,
  height: DEFAULT_BOARD_HEIGHT,
  runTicks: DEFAULT_RUN_TICKS,
  ticks: 0,
  once: false,
  leversOn: false,
  ascii: false,
  stats: false,
  list: false,
  help: false,
  frameWidth: undefined,
  frameHeight: undefined,
  errors: [],
} satisfies PreviewOptions

type Accumulator = {
  -readonly [Key in keyof PreviewOptions]: PreviewOptions[Key]
}

const readNumber = (
  accumulator: Accumulator,
  flag: string,
  raw: string | undefined,
): number | undefined => {
  if (raw === undefined) {
    accumulator.errors = [...accumulator.errors, `${flag} needs a value`]
    return undefined
  }
  const value = Number(raw)
  if (!Number.isFinite(value)) {
    accumulator.errors = [...accumulator.errors, `${flag}: "${raw}" is not a number`]
    return undefined
  }
  return value
}

/** Accepts `--flag value`, `--flag=value` and `--no-flag`. */
export const parseArguments = (argv: ReadonlyArray<string>): PreviewOptions => {
  const accumulator: Accumulator = { ...DEFAULTS }
  const queue = [...argv]

  while (queue.length > 0) {
    const token = queue.shift()
    if (token === undefined) {
      break
    }

    const equalsAt = token.indexOf('=')
    const flag = equalsAt === -1 ? token : token.slice(0, equalsAt)
    const inlineValue = equalsAt === -1 ? undefined : token.slice(equalsAt + 1)
    const takeValue = (): string | undefined => inlineValue ?? queue.shift()

    switch (flag) {
      case '--':
        break
      case '--help':
      case '-h':
        accumulator.help = true
        break
      case '--stats':
        accumulator.stats = true
        break
      case '--list':
        accumulator.list = true
        break
      case '--once':
        accumulator.once = true
        break
      case '--levers-on':
        accumulator.leversOn = true
        break
      case '--ascii':
        accumulator.ascii = true
        break
      case '--scenario': {
        const value = takeValue()
        if (value !== undefined && SCENARIO_NAMES.includes(value)) {
          accumulator.scenario = value
        } else {
          accumulator.errors = [
            ...accumulator.errors,
            `--scenario: "${String(value)}" is not one of ${SCENARIO_NAMES.join(', ')}`,
          ]
        }
        break
      }
      case '--view': {
        const value = takeValue()
        if (value !== undefined && isViewMode(value)) {
          accumulator.view = value
        } else {
          accumulator.errors = [
            ...accumulator.errors,
            `--view: "${String(value)}" is not one of ${VIEW_MODES.join(', ')}`,
          ]
        }
        break
      }
      case '--board-width':
        accumulator.width = Math.max(4, readNumber(accumulator, flag, takeValue()) ?? accumulator.width)
        break
      case '--board-height':
        accumulator.height = Math.max(4, readNumber(accumulator, flag, takeValue()) ?? accumulator.height)
        break
      case '--run-ticks':
        accumulator.runTicks = Math.max(1, readNumber(accumulator, flag, takeValue()) ?? accumulator.runTicks)
        break
      case '--ticks':
        accumulator.ticks = Math.max(0, readNumber(accumulator, flag, takeValue()) ?? accumulator.ticks)
        break
      case '--width':
        accumulator.frameWidth = readNumber(accumulator, flag, takeValue()) ?? accumulator.frameWidth
        break
      case '--height':
        accumulator.frameHeight = readNumber(accumulator, flag, takeValue()) ?? accumulator.frameHeight
        break
      default:
        accumulator.errors = [...accumulator.errors, `unknown option: ${flag}`]
        break
    }
  }

  return {
    ...accumulator,
    width: Math.trunc(accumulator.width),
    height: Math.trunc(accumulator.height),
    runTicks: Math.trunc(accumulator.runTicks),
    ticks: Math.trunc(accumulator.ticks),
  }
}

export const SCENARIO_LIST: ReadonlyArray<string> = SCENARIOS.flatMap((scenario) => [
  `  ${scenario.name}${' '.repeat(Math.max(1, 18 - scenario.name.length))}${scenario.title}`,
  ...scenario.notes.map((note) => `${' '.repeat(20)}· ${note}`),
  '',
])

export const USAGE: ReadonlyArray<string> = [
  'pnpm preview [options]        circuit-board sandbox for @nerima-games/mx-redstone',
  '',
  'options',
  `  --scenario <name>   prebuilt circuit to load (default ${DEFAULT_SCENARIO})`,
  '  --list              print the scenarios and what each one is for',
  '  --view <mode>       board | power | timeline                (default board)',
  '  --ticks <n>         advance n redstone ticks before drawing (default 0)',
  `  --run-ticks <n>     how many ticks the n key advances       (default ${String(DEFAULT_RUN_TICKS)})`,
  `  --board-width <n>   board size in cells                     (default ${String(DEFAULT_BOARD_WIDTH)})`,
  `  --board-height <n>                                          (default ${String(DEFAULT_BOARD_HEIGHT)})`,
  '  --once              render one frame to stdout and exit (no raw mode, pipe-safe)',
  '  --levers-on         throw every lever before drawing — a piped frame of an idle',
  '                      circuit measures nothing',
  '  --ascii             glyphs instead of colour — pasteable into an issue or a diff',
  '  --stats             print the numeric report instead of a picture',
  '  --width <n> --height <n>   force the frame size in terminal cells',
  '  --help              this text',
  '',
  'keys (interactive)',
  '  arrows / hjkl   move the cursor            (HJKL moves 5)',
  '  space / enter   place   e erase   f rotate   t toggle a lever, button or comparator mode',
  '  1-9 0 -         wire torch lever button repeater comparator observer lamp piston block obsidian',
  '  [ ]             repeater delay 1-4',
  '  .               step ONE redstone tick',
  '  n               run --run-ticks ticks       s  settle       r  reset power',
  '  c               clear the board             o/O  next / previous scenario',
  '  m               watch this cell in the timeline view',
  '  v               cycle view                  ?  help         x  Esc  Ctrl-C  quit',
]
