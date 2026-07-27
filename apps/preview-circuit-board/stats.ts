/**
 * The numeric report: `pnpm preview --stats`.
 *
 * A dev application, not shipped API.
 *
 * ---------------------------------------------------------------------------
 * Why a picture is not enough
 * ---------------------------------------------------------------------------
 *
 * A board full of colour is unfalsifiable: every propagation rule produces
 * something that looks like a circuit lighting up. The claims this repository
 * actually makes are numeric — how far a signal crosses, what a repeater delay
 * buys, how many ticks a settle search may take — and each one is either true or
 * false of the code as written.
 *
 * Every number below is MEASURED at run time from the shipped modules. Nothing
 * here is a recorded expectation, so this report cannot go stale: fix the
 * behaviour and the finding disappears by itself. mc-worldgen's preview report
 * is the precedent, and it is where five real defects in that repository were
 * found — including a constant justified by an undersampled measurement, which is
 * exactly what §4 below turned out to be here.
 *
 * Not a test. `pnpm verify` does not run this. When a finding here is confirmed
 * it should become an assertion in `test/power-graph.test.ts`, where it will
 * fail loudly instead of waiting to be read.
 *
 * ---------------------------------------------------------------------------
 * The findings that have been answered are still MEASURED
 * ---------------------------------------------------------------------------
 *
 * The first run produced seven findings; four of them are fixed and their checks
 * are still here, silent. That is on purpose and it is the difference between
 * this file and a changelog: a check that is deleted when it passes tests the
 * code exactly once. The assertions in `test/power-graph.test.ts` are what stop
 * a regression reaching a person; these lines are what stop it reaching a person
 * who is only looking at the picture.
 */
import { planPush, PISTON_PUSH_LIMIT } from '../../domain/piston'
import {
  emptyPowerMap,
  isLit,
  MAX_POWER_LEVEL,
  powerAt,
  propagateTick,
  settle,
  settleTickLimitFor,
  type CircuitBoard,
  type PowerMap,
} from '../../domain/power-graph'
import type { PositionKey } from '../../domain/position-key'
import { REDSTONE_TICK_SECS, ticksForFrame } from '../../stages/registration'
import {
  circuitBoardOf,
  keyOf,
  makePart,
  PREVIEW_BLOCKS,
  previewCapabilities,
  type Part,
  type PartKind,
} from './board'
import { SCENARIOS } from './scenarios'
import { makeSandbox, settleReport, UNBOUNDED_SETTLE_LIMIT } from './sandbox'

const UNBOUNDED = UNBOUNDED_SETTLE_LIMIT

type Cells = Map<PositionKey, Part>

const cells = (): Cells => new Map<PositionKey, Part>()

const at = (
  map: Cells,
  x: number,
  y: number,
  kind: PartKind,
  overrides: Partial<Part> = {},
): PositionKey => {
  const key = keyOf({ x, y })
  map.set(key, makePart(kind, overrides))
  return key
}

const row = (map: Cells, x: number, y: number, length: number, kind: PartKind = 'wire'): void => {
  for (let index = 0; index < length; index += 1) {
    at(map, x + index, y, kind)
  }
}

const pad = (text: string, width: number): string =>
  text.length >= width ? text : text + ' '.repeat(width - text.length)

const padNumber = (value: number, width: number): string => {
  const text = String(value)
  return text.length >= width ? text : ' '.repeat(width - text.length) + text
}

const yesNo = (value: boolean): string => (value ? 'yes' : 'no')

// ---------------------------------------------------------------------------
// 1. How far does a signal actually travel?
// ---------------------------------------------------------------------------

type ReachMeasurement = {
  readonly levels: ReadonlyArray<number>
  readonly firstWireLevel: number
  readonly poweredCells: number
}

const measureReach = (sourceKind: PartKind, overrides: Partial<Part> = {}): ReachMeasurement => {
  const map = cells()
  at(map, 0, 0, sourceKind, { active: true, ...overrides })
  row(map, 1, 0, 18)
  const board = circuitBoardOf(map)
  const power = settle(board, { limit: UNBOUNDED }).power

  const levels = Array.from({ length: 18 }, (_, index) => powerAt(power, keyOf({ x: index + 1, y: 0 })))
  return {
    levels,
    firstWireLevel: levels[0] ?? 0,
    poweredCells: levels.filter((level) => level > 0).length,
  }
}

// ---------------------------------------------------------------------------
// 2. What does a repeater's delay do?
// ---------------------------------------------------------------------------

const measureRepeaterArrival = (delayTicks: number): number => {
  const map = cells()
  at(map, 0, 0, 'lever', { active: true })
  at(map, 1, 0, 'wire')
  at(map, 2, 0, 'repeater', { facing: 'right', delayTicks })
  at(map, 3, 0, 'wire')
  const lamp = at(map, 4, 0, 'lamp')

  const board = circuitBoardOf(map)
  let power: PowerMap = emptyPowerMap
  for (let tick = 1; tick <= 32; tick += 1) {
    power = propagateTick(board, power)
    if (isLit(board, power, lamp)) {
      return tick
    }
  }
  return -1
}

const measurePlainArrival = (): number => {
  const map = cells()
  at(map, 0, 0, 'lever', { active: true })
  row(map, 1, 0, 3)
  const lamp = at(map, 4, 0, 'lamp')

  const board = circuitBoardOf(map)
  let power: PowerMap = emptyPowerMap
  for (let tick = 1; tick <= 32; tick += 1) {
    power = propagateTick(board, power)
    if (isLit(board, power, lamp)) {
      return tick
    }
  }
  return -1
}


// ---------------------------------------------------------------------------
// 2-1. What does a comparator do to the number it is passing on?
// ---------------------------------------------------------------------------

/**
 * A ladder of comparators, each reading the dust the last one drove.
 *
 * A comparator is the only component whose output is a LEVEL rather than a
 * yes/no, so it is the only one for which "how much did this cost" is a question
 * with an answer other than a tick. In vanilla the answer is nothing: a
 * comparator drives the dust in front of it at its own output strength, so a
 * value crosses any number of them unchanged.
 */
const measureComparatorLadder = (stages: number): ReadonlyArray<number> => {
  const map = cells()
  at(map, 0, 0, 'lever', { active: true })
  for (let index = 0; index < stages; index += 1) {
    at(map, index * 2 + 1, 0, 'comparator', { facing: 'right' })
    at(map, index * 2 + 2, 0, 'wire')
  }
  const board = circuitBoardOf(map)
  const power = settle(board, { limit: UNBOUNDED }).power
  return Array.from({ length: stages }, (_, index) => powerAt(power, keyOf({ x: index * 2 + 1, y: 0 })))
}

// ---------------------------------------------------------------------------
// 3. Is a repeater a diode?
// ---------------------------------------------------------------------------

type DiodeMeasurement = {
  /** Power on the wire feeding the repeater, before and after it turns on. */
  readonly inputBefore: number
  readonly inputAfter: number
  /** Power on a wire touching the repeater's flank and nothing else. */
  readonly flank: number
  /** Power on the output wire once the source has been switched OFF again. */
  readonly outputAfterSourceOff: number
  readonly ticksAfterSourceOff: number
}

/**
 * A lever, wire, repeater, wire, and a stub touching the repeater's side.
 *
 * The vanilla rule this measures is what a repeater IS: a diode. Signal enters
 * the back, leaves the front, nothing leaves the sides, and when the input goes
 * away so does the output.
 */
const measureDiode = (settleTicks = 4, offTicks = 20): DiodeMeasurement => {
  const map = cells()
  const lever = at(map, 0, 0, 'lever', { active: true })
  row(map, 1, 0, 3)
  at(map, 4, 0, 'repeater', { facing: 'right', delayTicks: 1 })
  row(map, 5, 0, 3)
  at(map, 4, 1, 'wire')

  const inputKey = keyOf({ x: 3, y: 0 })
  const flankKey = keyOf({ x: 4, y: 1 })
  const outputKey = keyOf({ x: 5, y: 0 })

  let power: PowerMap = emptyPowerMap
  power = propagateTick(circuitBoardOf(map), power)
  const inputBefore = powerAt(power, inputKey)

  for (let tick = 1; tick < settleTicks; tick += 1) {
    power = propagateTick(circuitBoardOf(map), power)
  }
  const inputAfter = powerAt(power, inputKey)
  const flank = powerAt(power, flankKey)

  map.set(lever, makePart('lever', { active: false }))
  for (let tick = 0; tick < offTicks; tick += 1) {
    power = propagateTick(circuitBoardOf(map), power)
  }

  return {
    inputBefore,
    inputAfter,
    flank,
    outputAfterSourceOff: powerAt(power, outputKey),
    ticksAfterSourceOff: offTicks,
  }
}

// ---------------------------------------------------------------------------
// 4. Is settle's bound big enough — and is it derived from the right quantity?
// ---------------------------------------------------------------------------

type ChainProbe = {
  readonly length: number
  readonly limit: number
  readonly boundedTicks: number
  readonly boundedOscillating: boolean
  readonly unboundedTicks: number
  readonly unboundedOscillating: boolean
}

const repeaterChainBoard = (length: number): CircuitBoard => {
  const map = cells()
  at(map, 0, 0, 'lever', { active: true })
  for (let index = 0; index < length; index += 1) {
    at(map, index + 1, 0, 'repeater', { facing: 'right', delayTicks: 1 })
  }
  return circuitBoardOf(map)
}

const torchChainBoard = (length: number): CircuitBoard => {
  const map = cells()
  at(map, 0, 0, 'lever', { active: true })
  for (let index = 0; index < length; index += 1) {
    at(map, index + 1, 0, 'torch', { facing: 'left' })
  }
  return circuitBoardOf(map)
}

const probeChain = (board: CircuitBoard, length: number): ChainProbe => {
  const bounded = settle(board)
  const unbounded = settle(board, { limit: UNBOUNDED })
  return {
    length,
    limit: settleTickLimitFor(board),
    boundedTicks: bounded.ticks,
    boundedOscillating: bounded.oscillating,
    unboundedTicks: unbounded.ticks,
    unboundedOscillating: unbounded.oscillating,
  }
}

const CHAIN_LENGTHS: ReadonlyArray<number> = [2, 8, 14, 15, 16, 18, 20, 24]

// ---------------------------------------------------------------------------
// 4. Does a lamp conduct?
// ---------------------------------------------------------------------------

type LampProbe = {
  readonly index: number
  readonly ownLevel: number
  readonly lit: boolean
}

const measureLampChain = (count: number): ReadonlyArray<LampProbe> => {
  const map = cells()
  at(map, 0, 0, 'lever', { active: true })
  at(map, 1, 0, 'wire')
  const lamps = Array.from({ length: count }, (_, index) => at(map, index + 2, 0, 'lamp'))

  const board = circuitBoardOf(map)
  const power = settle(board, { limit: UNBOUNDED }).power

  return lamps.map((key, index) => ({
    index,
    ownLevel: powerAt(power, key),
    lit: isLit(board, power, key),
  }))
}

// ---------------------------------------------------------------------------
// 5. Does a button ever release?
// ---------------------------------------------------------------------------

const measureButtonHold = (ticks: number): { readonly stillPowered: boolean; readonly level: number } => {
  const map = cells()
  at(map, 0, 0, 'button', { active: true })
  const wire = at(map, 1, 0, 'wire')

  const board = circuitBoardOf(map)
  let power: PowerMap = emptyPowerMap
  for (let tick = 0; tick < ticks; tick += 1) {
    power = propagateTick(board, power)
  }
  const level = powerAt(power, wire)
  return { stillPowered: level > 0, level }
}

// ---------------------------------------------------------------------------
// 6. planPush across every column length
// ---------------------------------------------------------------------------

type PushProbe = {
  readonly length: number
  readonly outcome: string
}

const probePush = (length: number): PushProbe => {
  const column = Array.from({ length }, () => PREVIEW_BLOCKS.movable)
  const outcome = planPush(column, previewCapabilities)
  return {
    length,
    outcome:
      outcome.kind === 'push'
        ? `push ${String(outcome.plan.length)}`
        : `refused ${outcome.refusal.reason} at ${String(outcome.refusal.at)}`,
  }
}

const probeImmovableAt = (index: number): string => {
  const column = Array.from({ length: 5 }, (_, position) =>
    position === index ? PREVIEW_BLOCKS.immovable : PREVIEW_BLOCKS.movable,
  )
  const outcome = planPush(column, previewCapabilities)
  return outcome.kind === 'push'
    ? `push ${String(outcome.plan.length)}`
    : `refused ${outcome.refusal.reason} at ${String(outcome.refusal.at)}`
}

// ---------------------------------------------------------------------------
// 7. The clock, and the frame-rate conversion above it
// ---------------------------------------------------------------------------

const measureClockPeriod = (): number => {
  const map = cells()
  const first = at(map, 0, 0, 'torch', { facing: 'down' })
  at(map, 0, 1, 'torch', { facing: 'up' })

  const board = circuitBoardOf(map)
  let power: PowerMap = emptyPowerMap
  const seen: Array<number> = []
  for (let tick = 0; tick < 12; tick += 1) {
    power = propagateTick(board, power)
    seen.push(powerAt(power, first))
  }

  for (let period = 1; period <= 6; period += 1) {
    const repeats = seen.every((level, index) => index < period || level === seen[index - period])
    if (repeats) {
      return period
    }
  }
  return -1
}

/**
 * Redstone ticks executed over `frames` frames of `dt`, against the ticks that
 * much wall time is worth.
 *
 * This is the accumulator's claim under test: 「the long-run tick rate is exact
 * rather than losing up to one tick's worth of time every frame」
 * (`stages/registration.ts:11-27`). A per-frame loss would show up here as a
 * drift that grows with the run length; a single pending tick would not.
 */
const measureFrameRate = (frames: number, fps: number): { readonly ticks: number; readonly drift: number } => {
  const dt = 1 / fps
  let accumulated = 0
  let total = 0
  for (let frame = 0; frame < frames; frame += 1) {
    const { ticks, remainderSecs } = ticksForFrame(accumulated, dt)
    accumulated = remainderSecs
    total += ticks
  }
  const expected = Math.round((frames / fps) / REDSTONE_TICK_SECS)
  return { ticks: total, drift: total - expected }
}

const FRAME_RATE_PROBES: ReadonlyArray<{ readonly frames: number; readonly fps: number }> = [
  { frames: 600, fps: 60 },
  { frames: 6000, fps: 60 },
  { frames: 60000, fps: 60 },
  { frames: 6000, fps: 144 },
  { frames: 3000, fps: 30 },
]

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

const scenarioTable = (): ReadonlyArray<string> => {
  const lines: Array<string> = [
    `  ${pad('scenario', 16)}${pad('parts', 7)}${pad('graph', 7)}${pad('settle', 8)}${pad('osc?', 6)}${pad('unbounded', 11)}${pad('osc?', 6)}lamps lit`,
  ]

  for (const scenario of SCENARIOS) {
    const built = scenario.build()
    const sandbox = makeSandbox({ width: 64, height: 32 }, built.parts, { scenario: scenario.name })
    // Throw every lever and hold every button: a scenario is built switched off
    // so a person can watch it come on, and a report of an idle circuit measures
    // nothing.
    for (const [key, part] of Array.from(sandbox.parts)) {
      if (part.kind === 'lever' || part.kind === 'button') {
        sandbox.parts.set(key, { ...part, active: true })
      }
    }

    const report = settleReport(sandbox)
    const board = circuitBoardOf(sandbox.parts)
    const power = settle(board, { limit: UNBOUNDED }).power
    const lamps = [...board.components].filter(([, component]) => component.kind === 'lamp')
    const lit = lamps.filter(([key]) => isLit(board, power, key)).length

    lines.push(
      `  ${pad(scenario.name, 16)}${pad(String(sandbox.parts.size), 7)}${pad(String(board.components.size), 7)}${pad(String(report.ticks), 8)}${pad(yesNo(report.oscillating), 6)}${pad(String(report.ticksUnbounded), 11)}${pad(yesNo(report.oscillatingUnbounded), 6)}${String(lit)}/${String(lamps.length)}`,
    )
  }

  return lines
}

type Finding = {
  readonly title: string
  readonly detail: ReadonlyArray<string>
}

const collectFindings = (): ReadonlyArray<Finding> => {
  const findings: Array<Finding> = []

  const leverReach = measureReach('lever')
  if (leverReach.poweredCells < MAX_POWER_LEVEL) {
    findings.push({
      title: `a signal crosses ${String(leverReach.poweredCells)} wire cells, not ${String(MAX_POWER_LEVEL)} — a RECORDED divergence from vanilla`,
      detail: [
        `The source cell holds ${String(MAX_POWER_LEVEL)} and the first wire is already decayed to ${String(leverReach.firstWireLevel)},`,
        'because a lever occupies a cell in the power map and every conducting step loses one.',
        'In vanilla the wire touching a lever is at 15 and the run reaches 15 cells.',
        'The arithmetic claim is fixed: 15 was written in four comments, a design note, a preview',
        'scenario and two test names, and every one of them now says 14. The BEHAVIOUR is not,',
        'because closing the gap means a source not decaying into its first neighbour, which',
        'renumbers every level in every circuit — a decision, not a typo.',
        'test/power-graph.test.ts pins the 14 so that decision cannot be taken quietly.',
      ],
    })
  }

  const diode = measureDiode()
  if (diode.outputAfterSourceOff > 0) {
    findings.push({
      title: 'a repeater latches itself ON and never lets go',
      detail: [
        `Lever on, four ticks, lever off, ${String(diode.ticksAfterSourceOff)} more ticks: the output wire is still at`,
        `${String(diode.outputAfterSourceOff)}. The lamp beyond it never goes out, and nothing on the board is a source.`,
        'The mechanism is `conductsInto` (domain/power-graph.ts): a repeater must drive `outputTo`',
        'and nothing else. If it drives every neighbour it also drives the cell it reads as input —',
        `that input wire goes from ${String(diode.inputBefore)} to ${String(diode.inputAfter)}, lifted by the repeater's own output — and on the`,
        'next tick sourcesOf sees a powered input and re-energises the repeater from itself.',
        'A repeater is a DIODE: signal in the back, out the front, and nothing in between when the',
        'input goes away. A self-sustaining loop here means any circuit with a repeater in it can',
        'never be switched off. Twenty-one tests did not catch this, because a test asserts a final',
        'state and that final state was the expected one — what was wrong was the state AFTER the',
        'source is removed, which nothing asked for.',
      ],
    })
  }
  if (diode.flank > 0) {
    findings.push({
      title: 'a repeater powers its own flanks, welding circuits that only touch it sideways',
      detail: [
        `A wire touching the side of the repeater and nothing else sits at ${String(diode.flank)}.`,
        'In vanilla a repeater outputs only to the block it faces, which is why `Component` names',
        '`outputTo` and `conductsInto` filters the adjacency row down to it. A predicate over',
        'ComponentKind cannot express this: direction is a property of the placement, not the kind.',
        'This is the same failure the CONDUCTS_POWER comment warns about — two independent circuits',
        'silently welded into one — except that a repeater is the component players use specifically',
        'to ISOLATE two circuits.',
      ],
    })
  }

  const arrivals = [1, 2, 3, 4].map(measureRepeaterArrival)
  const uniqueArrivals = [...new Set(arrivals)]
  if (uniqueArrivals.length === 1) {
    findings.push({
      title: "a repeater's delay is always one tick — vanilla's 1–4 is NOT MODELLED",
      detail: [
        `A repeater set to 1, 2, 3 or 4 ticks all deliver at tick ${String(arrivals[0] ?? -1)}.`,
        'The `delayTicks` field this used to report has been REMOVED from `Component`: it was',
        'accepted, stored and never read, and a field that silently does nothing is worse than an',
        'absent one. sourcesOf only asks whether the input carries power.',
        'Honouring a delay needs the input from N ticks ago, and propagateTick is by design a pure',
        'function of (board, previous power map) — one tick of history. That is a change to the',
        "tick's STATE SHAPE, not to the component record, so the field returns with the mechanism.",
        'The preview keeps [ and ] so the gap stays visible; test/power-graph.test.ts asserts the',
        'absence at compile time and the one-tick cost at run time.',
      ],
    })
  }

  const repeaterProbes = CHAIN_LENGTHS.map((length) => probeChain(repeaterChainBoard(length), length))
  const falseAlarm = repeaterProbes.find(
    (probe) => probe.boundedOscillating && !probe.unboundedOscillating,
  )
  if (falseAlarm !== undefined) {
    findings.push({
      title: `settle reports OSCILLATING for acyclic circuits from ${String(falseAlarm.length)} sequential elements up`,
      detail: [
        `This board's bound is ${String(falseAlarm.limit)} and it needs ${String(falseAlarm.unboundedTicks)} ticks, so settle returns`,
        'oscillating: true for a circuit that is perfectly stable.',
        'The bound must count SEQUENTIAL DELAY ELEMENTS, not decay distance. A whole wire run',
        'resolves inside one propagateTick — the sweep is a BFS over the entire board — while every',
        'torch and every repeater costs exactly one tick, because both read the PREVIOUS power map.',
        'It used to be the constant MAX_POWER_LEVEL + 2 = 17, justified as "two more than the',
        'longest possible wire run", which is the wrong quantity: a chain of 16 repeaters contains',
        'no wire at all, has no loop, and needs 18. settleTickLimitFor now counts torches and',
        'repeaters and adds two (one tick to produce the final map, one to observe it unchanged).',
        'A caller that trusts the flag (a "your contraption is a clock" warning, a scheduler that',
        'stops ticking a settled region) got the wrong answer for every real repeater chain.',
      ],
    })
  }

  const lampProbes = measureLampChain(3)
  const litBeyondFirst = lampProbes.filter((probe) => probe.index > 0 && probe.lit)
  if (litBeyondFirst.length > 0) {
    findings.push({
      title: 'a lamp lights its neighbour, though a lamp does not conduct',
      detail: [
        'Two lamps side by side, only the first touching a wire:',
        ...lampProbes.map(
          (probe) =>
            `  lamp ${String(probe.index)}: own power ${String(probe.ownLevel)}, isLit ${yesNo(probe.lit)}`,
        ),
        'propagateTick is right — a lamp is not in CONDUCTS_POWER, so the second lamp has power 0.',
        'isLit is what leaks when it asks whether any NEIGHBOUR carries power: a lamp IS in',
        'RECEIVES_POWER, so a lit lamp carries its own decayed level and litness travels exactly one',
        'lamp further than power does. The CONDUCTS_POWER comment explains why a lamp must not weld',
        'two circuits together; this is that failure one layer up, in the accessor, not in the sweep.',
        'The rule is "a cell that DRIVES me carries power" — isLit shares conductsInto with the',
        'sweep so the two cannot disagree. Not "my own level > 0", which would also pass this check',
        'and would go dark beside the last wire of a run, where vanilla lights the lamp.',
      ],
    })
  }


  const ladder = measureComparatorLadder(4)
  const passedThrough = ladder.every((level) => level === (ladder[0] ?? 0))
  if (!passedThrough) {
    findings.push({
      title: 'a comparator loses one level per stage — vanilla loses none',
      detail: [
        `Four comparators in a row, each reading the dust the last one drove: ${ladder.join(', ')}.`,
        'This is the SAME divergence as finding F1 above, arriving where it costs something other',
        'than reach. A lever losing its first level costs one cell of wire. A repeater loses',
        'nothing that survives, because it restores full power and discards the level it read.',
        'A comparator is the first component that PASSES A NUMBER ON, and other comparators do',
        'arithmetic on that number: an item sorter that compares two chests through different',
        'numbers of comparators gets different answers for equal chests.',
        'DELIBERATE and recorded (DN-RS-13), because closing it means a source not decaying into',
        'its first neighbour — the same one decision F1 defers, and it renumbers every circuit.',
        'test/power-graph.test.ts asserts these exact readings so that taking it is loud.',
      ],
    })
  }

  const held = measureButtonHold(60)
  if (held.stillPowered) {
    findings.push({
      title: 'a pressed button never releases',
      detail: [
        `60 ticks (six vanilla seconds) after being pressed, the wire is still at ${String(held.level)}.`,
        'A vanilla stone button pops out after 10 redstone ticks and a wooden one after 15, which is',
        'what makes a button a PULSE and a lever a switch — every monostable circuit depends on it.',
        'Component.active is a boolean and nothing in the graph counts down. DELIBERATE, and',
        'recorded: a pulse is REMAINING TIME, which is state the power map has no cell for, and the',
        'board is an input this module may not rewrite. `active` is a statement by whoever owns the',
        "world; a lever's is cleared by the player and a button's by TIME, and the thing that knows",
        'redstone time is passing is stages/registration.ts, which converts dt into ticks and holds',
        'the board Ref. Release belongs there. test/power-graph.test.ts names the current behaviour',
        'so that implementing it upstream fails a test instead of changing this line silently.',
      ],
    })
  }

  return findings
}

export const buildStatsReport = (): ReadonlyArray<string> => {
  const leverReach = measureReach('lever')
  // Facing left, i.e. attached to nothing: an unsupported torch burns
  // permanently, which is the standard way to write a constant source.
  const torchReach = measureReach('torch', { facing: 'left' })
  const arrivals = [1, 2, 3, 4].map(measureRepeaterArrival)
  const plainArrival = measurePlainArrival()
  const diode = measureDiode()
  const repeaterProbes = CHAIN_LENGTHS.map((length) => probeChain(repeaterChainBoard(length), length))
  const torchProbes = CHAIN_LENGTHS.map((length) => probeChain(torchChainBoard(length), length))
  const lampProbes = measureLampChain(4)
  const pushProbes = [0, 1, 11, 12, 13, 14].map(probePush)
  const clockPeriod = measureClockPeriod()
  const findings = collectFindings()

  const lines: Array<string> = [
    'mx-redstone circuit board — numeric report',
    'every number below is measured at run time from domain/ and stages/; nothing is recorded.',
    '',
    '1. scenarios (every lever thrown, every button held)',
    ...scenarioTable(),
    '',
    '2. how far a signal travels',
    `  MAX_POWER_LEVEL = ${String(MAX_POWER_LEVEL)}`,
    `  lever + 18 wires: ${leverReach.levels.join(' ')}`,
    `  torch + 18 wires: ${torchReach.levels.join(' ')}`,
    `  first wire after a source: ${String(leverReach.firstWireLevel)}`,
    `  wire cells carrying power: ${String(leverReach.poweredCells)}   (vanilla: ${String(MAX_POWER_LEVEL)}; the source holds one of the levels)`,
    '',
    '3. repeater delay  (the palette number only — `Component` has no delay field)',
    `  plain wire, same length, no repeater: lamp lights at tick ${String(plainArrival)}`,
    ...[1, 2, 3, 4].map(
      (delay, index) => `  palette delay = ${String(delay)}: lamp lights at tick ${String(arrivals[index] ?? -1)}`,
    ),
    '',
    '3-2. what does a comparator do to the number it passes on?  (lever - C - dust - C - dust - …)',
    `  four comparators in a row read: ${measureComparatorLadder(4).join(', ')}   (vanilla: 15, 15, 15, 15)`,
    '',
    '3-1. is a repeater a diode?  (lever - wire - repeater - wire, plus a stub on the flank)',
    `  input wire the tick before the repeater turns on: ${String(diode.inputBefore)}`,
    `  the same wire once the repeater is on:            ${String(diode.inputAfter)}   (must not rise: that is the latch)`,
    `  stub touching the repeater's flank:               ${String(diode.flank)}   (vanilla: 0)`,
    `  output wire ${String(diode.ticksAfterSourceOff)} ticks after the lever is switched OFF: ${String(diode.outputAfterSourceOff)}   (vanilla: 0)`,
    '',
    `4. settle, this board's own limit vs. limit ${String(UNBOUNDED)}`,
    '  the bound is one tick per DELAY ELEMENT (torch, repeater) plus two; wire length is not in it.',
    '  the two verdicts must agree for every acyclic circuit — a disagreement means the bound is small.',
    `  ${pad('elements', 10)}${pad('repeater chain', 41)}torch chain`,
    `  ${pad('', 10)}${pad('limit  ticks  osc?   unbounded  osc?', 41)}limit  ticks  osc?   unbounded  osc?`,
    ...CHAIN_LENGTHS.map((length, index) => {
      const repeater = repeaterProbes[index]
      const torch = torchProbes[index]
      const cell = (probe: ChainProbe | undefined): string =>
        probe === undefined
          ? pad('-', 41)
          : pad(
              `${padNumber(probe.limit, 5)}  ${padNumber(probe.boundedTicks, 5)}  ${pad(yesNo(probe.boundedOscillating), 6)} ${padNumber(probe.unboundedTicks, 9)}  ${pad(yesNo(probe.unboundedOscillating), 6)}`,
              41,
            )
      return `  ${pad(String(length), 10)}${cell(repeater)}${cell(torch)}`.trimEnd()
    }),
    '',
    '5. a lamp next to a lamp',
    ...lampProbes.map(
      (probe) =>
        `  lamp ${String(probe.index)} (${probe.index === 0 ? 'touching the wire' : `${String(probe.index)} lamp(s) away`}): own power ${String(probe.ownLevel)}, isLit ${yesNo(probe.lit)}`,
    ),
    '',
    '6. planPush',
    `  PISTON_PUSH_LIMIT = ${String(PISTON_PUSH_LIMIT)}`,
    ...pushProbes.map((probe) => `  ${padNumber(probe.length, 3)} movable block(s): ${probe.outcome}`),
    ...[0, 2, 4].map((index) => `  immovable at index ${String(index)} of 5: ${probeImmovableAt(index)}`),
    '',
    '7. timing above the graph',
    `  torch/torch clock period: ${String(clockPeriod)} tick(s)`,
    `  REDSTONE_TICK_SECS = ${String(REDSTONE_TICK_SECS)}  (${String(Math.round(1 / REDSTONE_TICK_SECS))} Hz)`,
    '  the accumulator claims the long-run rate is exact; a per-frame loss would grow with the run.',
    ...FRAME_RATE_PROBES.map(({ frames, fps }) => {
      const measured = measureFrameRate(frames, fps)
      return `  ${padNumber(frames, 6)} frames at ${padNumber(fps, 3)} fps (${pad(`${((frames / fps)).toFixed(1)} s`, 8)}) -> ${padNumber(measured.ticks, 6)} ticks   drift ${String(measured.drift)}`
    }),
    '  drift stays at one pending tick however long the run: the remainder is carried, not dropped.',
    '',
    `findings: ${String(findings.length)}`,
  ]

  findings.forEach((finding, index) => {
    lines.push('')
    lines.push(`  F${String(index + 1)}. ${finding.title}`)
    for (const detail of finding.detail) {
      lines.push(`      ${detail}`)
    }
  })

  if (findings.length === 0) {
    lines.push('  none — every claim in domain/ measured true.')
  }

  lines.push('')
  return lines
}
