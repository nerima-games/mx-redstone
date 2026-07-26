/**
 * `apps/preview-circuit-board` — the built-in circuit-board sandbox.
 *
 * plan.md §3.12 asks this repository for 「回路シナリオテスト（fixture 回路 → 期待
 * 状態）+ 回路盤プレビュー（部品を置いて動かすサンドボックス）」, and plan.md §6 Step 2
 * makes both halves the completion criterion: tests green AND the built-in
 * preview operable. This is the second half. plan.md §4.1 requires it to live
 * with the thing it verifies, so it is a dev application INSIDE mx-redstone: not
 * a package, not part of `index.ts`, and not something a consumer can import.
 *
 * ---------------------------------------------------------------------------
 * Why this renders in a terminal
 * ---------------------------------------------------------------------------
 *
 * `docs/testing.md` §4-1 originally specified a launch harness from
 * `mc-playground-kit`, taken as a devDependency. That is still the right home
 * for a first-person preview — mc-sim's obstacle course cannot be anything else.
 * It is the wrong home for this one, for three reasons:
 *
 *  1. Nothing is published yet (README 現状: bottom-up publish-then-pin). A
 *     preview that cannot be run is not a completion criterion, it is a plan to
 *     have one.
 *  2. A circuit board SHOWS STATE. Everything plan.md asks the sandbox to make
 *     visible — the power level in a cell, which lamp is lit, how many ticks a
 *     signal took — is a number attached to a coordinate. First-person 3D adds
 *     nothing to any of them and takes away the ability to see the whole circuit
 *     at once. mc-worldgen's terrain preview made this argument first and it
 *     holds here more strongly, because a circuit has no silhouette to lose.
 *  3. `tsconfig.base.json` omits "DOM" from `lib`, so a browser type does not
 *     typecheck anywhere in this repository — the same mechanical guarantee
 *     mc-worldgen relies on. A 3D preview would need that lib back in some
 *     tsconfig, converting a mechanical property into a promise.
 *
 * What is lost is real: this preview cannot show you a piston shoving a player,
 * because there is no player and no world. It shows the circuit and the block
 * column, which is what this repository owns.
 *
 * ---------------------------------------------------------------------------
 * Constraints this app is written under
 * ---------------------------------------------------------------------------
 *
 *  - `apps` is in `SCAN_ROOTS` (scripts/check-dependency-whitelist.ts), so the
 *    preview's imports are gated like any other source here. It imports this
 *    repository's own modules and nothing else — no org package, no npm
 *    dependency, not even a colour library.
 *  - The `Date.now()` / `new Date()` / `performance.now()` ban applies. It is
 *    satisfied without an escape hatch: there is no clock read anywhere in this
 *    app, because redstone advances in ticks and a tick here is a keystroke.
 *    `mc-kernel-allow-time-source` is not taken.
 *  - `pnpm verify` does not run this app. `tsconfig.preview.json` typechecks it
 *    and `pnpm lint` lints it; `pnpm preview` is not a gate.
 */
import { ANSI_STYLE, PLAIN_STYLE, type Style } from './ansi'
import { coordOf, FACINGS, type Coord, type Facing, type PartKind } from './board'
import { buildHelp, buildHud, buildNotes, HUD_ROWS, type HudState } from './hud'
import { parseArguments, SCENARIO_LIST, USAGE, type PreviewOptions } from './options'
import { contentRows, isClipped, renderView, VIEW_MODES, type ViewMode } from './render'
import {
  clearBoard,
  makeSandbox,
  MAX_REPEATER_DELAY,
  MIN_REPEATER_DELAY,
  placeAt,
  eraseAt,
  resetPower,
  rotateAt,
  runTicks,
  setDelayAt,
  settleSandbox,
  stepOnce,
  toggleAt,
  toggleWatch,
  type Sandbox,
} from './sandbox'
import { DEFAULT_SCENARIO, SCENARIOS } from './scenarios'
import { buildStatsReport } from './stats'
import {
  enterFullScreen,
  isInteractive,
  leaveFullScreen,
  onExit,
  onInputEnd,
  onKey,
  onResize,
  paintFrame,
  screenSize,
  writeLine,
} from './terminal'

/** The palette, in the order the number keys select it. */
const PALETTE: ReadonlyArray<PartKind> = [
  'wire',
  'torch',
  'lever',
  'button',
  'repeater',
  'lamp',
  'piston',
  'block',
  'obsidian',
]

type State = {
  sandbox: Sandbox
  cursor: Coord
  view: ViewMode
  palette: PartKind
  facing: Facing
  delayTicks: number
  scenarioIndex: number
  showHelp: boolean
}

const loadScenario = (state: State, index: number, options: PreviewOptions): void => {
  const wrapped = ((index % SCENARIOS.length) + SCENARIOS.length) % SCENARIOS.length
  const scenario = SCENARIOS[wrapped]
  if (scenario === undefined) {
    return
  }

  const built = scenario.build()
  state.scenarioIndex = wrapped
  state.sandbox = makeSandbox(
    {
      width: Math.max(options.width, scenario.minWidth),
      height: Math.max(options.height, scenario.minHeight),
    },
    built.parts,
    { watched: built.watched, scenario: scenario.name },
  )
  state.cursor = built.watched[0] === undefined ? { x: 0, y: 0 } : coordOf(built.watched[0])
  state.sandbox.note = scenario.title

  if (options.leversOn) {
    // A scenario is built switched OFF so a person can watch it come on. A piped
    // frame has nobody to press the key, and a frame of an idle circuit shows
    // nothing at all.
    for (const [key, part] of Array.from(state.sandbox.parts)) {
      if (part.kind === 'lever' || part.kind === 'button') {
        state.sandbox.parts.set(key, { ...part, active: true })
      }
    }
  }
}

const frameSize = (options: PreviewOptions): { readonly columns: number; readonly rows: number } => {
  const screen = screenSize()
  return {
    columns: Math.max(24, options.frameWidth ?? screen.columns),
    rows: Math.max(6, (options.frameHeight ?? screen.rows) - HUD_ROWS - 2),
  }
}

const clampCursor = (state: State): void => {
  state.cursor = {
    x: Math.min(Math.max(state.cursor.x, 0), state.sandbox.size.width - 1),
    y: Math.min(Math.max(state.cursor.y, 0), state.sandbox.size.height - 1),
  }
}

const move = (state: State, dx: number, dy: number): void => {
  state.cursor = { x: state.cursor.x + dx, y: state.cursor.y + dy }
  clampCursor(state)
}

const render = (state: State, options: PreviewOptions, style: Style): ReadonlyArray<string> => {
  const frame = frameSize(options)
  const columns = frame.columns
  // Piping to stdout crops the empty board below the circuit; a person editing
  // the board needs to see the space they can build into. The timeline is not a
  // board — cropping it to the board's height would silently drop watched cells,
  // which is the one thing that view exists to show.
  const rows =
    options.once && state.view !== 'timeline'
      ? Math.min(frame.rows, contentRows(state.sandbox) + 1)
      : frame.rows

  if (state.showHelp) {
    return buildHelp(style)
  }

  const scenario = SCENARIOS[state.scenarioIndex]
  const hudState: HudState = {
    cursor: state.cursor,
    view: state.view,
    palette: state.palette,
    facing: state.facing,
    delayTicks: state.delayTicks,
    runTicks: options.runTicks,
    // Asked about the WINDOW, not the cropped frame: `--once` crops on purpose
    // and reporting that as "your board is bigger than your terminal" would be a
    // warning about nothing.
    clipped: isClipped(state.sandbox, columns, frame.rows),
  }

  // One line of the scenario's own notes, so the first frame says what to look
  // at. The rest are on `?` and on `--list`. `--once` has already printed all of
  // them above the board, so it does not repeat one here.
  const hint = options.once ? undefined : scenario?.notes[0]

  return [
    ...renderView(state.view, state.sandbox, state.cursor, style, columns, rows),
    '',
    ...(hint === undefined ? [] : [style.dim(`try: ${hint}`)]),
    ...buildHud(hudState, state.sandbox, style),
  ]
}

/** Returns false when the key means "quit". */
const handleKey = (state: State, key: string, options: PreviewOptions): boolean => {
  if (state.showHelp) {
    state.showHelp = false
    return true
  }

  const sandbox = state.sandbox

  switch (key) {
    case 'x':
    case 'escape':
    case 'ctrl-c':
      return false

    case 'left':
    case 'h':
      move(state, -1, 0)
      break
    case 'H':
      move(state, -5, 0)
      break
    case 'right':
    case 'l':
      move(state, 1, 0)
      break
    case 'L':
      move(state, 5, 0)
      break
    case 'up':
    case 'k':
      move(state, 0, -1)
      break
    case 'K':
      move(state, 0, -5)
      break
    case 'down':
    case 'j':
      move(state, 0, 1)
      break
    case 'J':
      move(state, 0, 5)
      break

    case ' ':
    case 'enter':
      sandbox.note = placeAt(sandbox, state.cursor, state.palette, state.facing, state.delayTicks)
      break
    case 'e':
      sandbox.note = eraseAt(sandbox, state.cursor)
      break
    case 'f': {
      const index = FACINGS.indexOf(state.facing)
      state.facing = FACINGS[(index + 1) % FACINGS.length] ?? 'right'
      sandbox.note = rotateAt(sandbox, state.cursor, state.facing)
      break
    }
    case 't':
      sandbox.note = toggleAt(sandbox, state.cursor)
      break
    case 'm':
      sandbox.note = toggleWatch(sandbox, state.cursor)
      break

    case '[':
      state.delayTicks = Math.max(MIN_REPEATER_DELAY, state.delayTicks - 1)
      sandbox.note = setDelayAt(sandbox, state.cursor, state.delayTicks)
      break
    case ']':
      state.delayTicks = Math.min(MAX_REPEATER_DELAY, state.delayTicks + 1)
      sandbox.note = setDelayAt(sandbox, state.cursor, state.delayTicks)
      break

    case '.':
      stepOnce(sandbox)
      sandbox.note = `stepped to tick ${String(sandbox.tick)}`
      break
    case 'n':
      runTicks(sandbox, options.runTicks)
      sandbox.note = `ran ${String(options.runTicks)} ticks, now at ${String(sandbox.tick)}`
      break
    case 's': {
      const report = settleSandbox(sandbox)
      sandbox.note = report.oscillating
        ? report.oscillatingUnbounded
          ? `settle gave up after ${String(report.ticks)} ticks — this circuit really does oscillate`
          : `settle said OSCILLATING after ${String(report.ticks)} ticks, but it settles at tick ${String(report.ticksUnbounded)}`
        : `settled after ${String(report.ticks)} tick(s)`
      break
    }
    case 'r':
      resetPower(sandbox)
      sandbox.note = 'power map and tick counter reset — the board is untouched'
      break
    case 'c':
      clearBoard(sandbox)
      sandbox.note = 'board cleared'
      break

    case 'o':
      loadScenario(state, state.scenarioIndex + 1, options)
      break
    case 'O':
      loadScenario(state, state.scenarioIndex - 1, options)
      break

    case 'v': {
      const index = VIEW_MODES.indexOf(state.view)
      state.view = VIEW_MODES[(index + 1) % VIEW_MODES.length] ?? 'board'
      break
    }

    case '?':
      state.showHelp = true
      break

    default: {
      const slot = Number(key)
      if (Number.isInteger(slot) && slot >= 1 && slot <= PALETTE.length) {
        state.palette = PALETTE[slot - 1] ?? 'wire'
        sandbox.note = `palette: ${state.palette}`
      }
      break
    }
  }

  return true
}

const runInteractive = (state: State, options: PreviewOptions, style: Style): void => {
  enterFullScreen()

  let restored = false
  const restore = (): void => {
    if (!restored) {
      restored = true
      leaveFullScreen()
    }
  }
  onExit(restore)

  const draw = (): void => {
    paintFrame(render(state, options, style))
  }

  const quit = (): void => {
    restore()
    process.exit(0)
  }

  onResize(draw)
  onInputEnd(quit)
  onKey((key) => {
    if (handleKey(state, key, options)) {
      draw()
      return
    }
    quit()
  })

  draw()
}

const main = (): number => {
  const options = parseArguments(process.argv.slice(2))
  const style = options.ascii ? PLAIN_STYLE : ANSI_STYLE

  if (options.errors.length > 0) {
    for (const error of options.errors) {
      writeLine(`preview-circuit-board: ${error}`)
    }
    writeLine('')
    for (const line of USAGE) {
      writeLine(line)
    }
    return 1
  }

  if (options.help) {
    for (const line of USAGE) {
      writeLine(line)
    }
    return 0
  }

  if (options.list) {
    writeLine('scenarios')
    writeLine('')
    for (const line of SCENARIO_LIST) {
      writeLine(line)
    }
    return 0
  }

  if (options.stats) {
    for (const line of buildStatsReport()) {
      writeLine(line)
    }
    return 0
  }

  const state: State = {
    sandbox: makeSandbox({ width: options.width, height: options.height }, new Map()),
    cursor: { x: 0, y: 0 },
    view: options.view,
    palette: 'wire',
    facing: 'right',
    delayTicks: MIN_REPEATER_DELAY,
    scenarioIndex: 0,
    showHelp: false,
  }

  const requested = SCENARIOS.findIndex((scenario) => scenario.name === options.scenario)
  loadScenario(state, requested === -1 ? SCENARIOS.findIndex((s) => s.name === DEFAULT_SCENARIO) : requested, options)
  runTicks(state.sandbox, options.ticks)

  if (options.once || !isInteractive()) {
    if (!options.once) {
      writeLine(
        style.dim('preview-circuit-board: stdin/stdout is not a TTY, drawing a single frame (same as --once)'),
      )
    }
    const scenario = SCENARIOS[state.scenarioIndex]
    if (scenario !== undefined) {
      for (const line of buildNotes(style, scenario.notes, scenario.title)) {
        writeLine(line)
      }
      writeLine('')
    }
    for (const line of render(state, options, style)) {
      writeLine(line)
    }
    return 0
  }

  runInteractive(state, options, style)
  return 0
}

const exitCode = main()
if (exitCode !== 0) {
  process.exit(exitCode)
}
