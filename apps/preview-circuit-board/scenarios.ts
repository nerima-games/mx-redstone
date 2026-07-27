/**
 * Circuits worth looking at, prebuilt.
 *
 * A dev application, not shipped API.
 *
 * ---------------------------------------------------------------------------
 * Why a sandbox ships with fixtures
 * ---------------------------------------------------------------------------
 *
 * plan.md §3.12 asks for 「部品を置いて動かすサンドボックス」— a sandbox where you
 * place parts and run them — and an empty grid satisfies that literally while
 * being useless on the first frame. Worse, an empty grid makes the preview's
 * real job optional: nobody discovers that a repeater ignores its delay by
 * placing one repeater, only by placing one and then comparing it against a line
 * that has none.
 *
 * Every scenario below is therefore built to make ONE claim checkable, and its
 * `notes` say which. Half of them failed their own claim on the first run, and
 * those failures were the point — see this directory's README.md. The ones that
 * have been answered are kept, with their notes rewritten to say what you should
 * now see: a scenario that is deleted once it passes demonstrates the rule
 * exactly once, and the rules these demonstrate (a repeater is a diode, litness
 * stops where power stops) are the ones a future change is most likely to break
 * without noticing.
 *
 * These are not tests. `pnpm verify` does not run them. A scenario that is wrong
 * is a scenario that draws a wrong picture, which is loud; a test that is wrong
 * is silent, which is why the scenario tests live in `test/power-graph.ts` and
 * assert exact levels.
 */
import type { PositionKey } from '../../domain/position-key'
import { keyOf, makePart, type Coord, type Facing, type Part, type PartKind } from './board'

export type BuiltScenario = {
  readonly parts: Map<PositionKey, Part>
  readonly watched: ReadonlyArray<PositionKey>
}

export type Scenario = {
  readonly name: string
  readonly title: string
  /** What to press, and what to look at. Shown in the HUD and by `--list`. */
  readonly notes: ReadonlyArray<string>
  readonly minWidth: number
  readonly minHeight: number
  readonly build: () => BuiltScenario
}

type Builder = {
  readonly parts: Map<PositionKey, Part>
  readonly put: (coord: Coord, kind: PartKind, overrides?: Partial<Part>) => PositionKey
  readonly run: (coord: Coord, length: number, kind?: PartKind) => ReadonlyArray<PositionKey>
}

const builder = (): Builder => {
  const parts = new Map<PositionKey, Part>()

  const put = (coord: Coord, kind: PartKind, overrides: Partial<Part> = {}): PositionKey => {
    const key = keyOf(coord)
    parts.set(key, makePart(kind, overrides))
    return key
  }

  const run = (coord: Coord, length: number, kind: PartKind = 'wire'): ReadonlyArray<PositionKey> =>
    Array.from({ length }, (_, index) => put({ x: coord.x + index, y: coord.y }, kind))

  return { parts, put, run }
}

const lever = (facing: Facing = 'right'): Partial<Part> => ({ active: false, facing })

// ---------------------------------------------------------------------------

/**
 * A lever, a long wire, a lamp.
 *
 * The claim used to be "a redstone signal travels 15 cells". It travels 14, and
 * the documentation now says so everywhere: the source occupies one of the
 * fifteen levels, so the first wire is already decayed. Count the cells that
 * still carry power in the `power` view — this circuit is where that was found.
 */
const wireRun: Scenario = {
  name: 'wire-run',
  title: 'wire decay — how far does a signal actually reach?',
  notes: [
    'press t on the lever (cursor starts on it), then . to step one tick',
    'switch to the power view (v) and count: the wire next to the lever is 14, not 15',
    'the 15th wire and the lamp beyond it never light — one cell short of vanilla',
    'that gap is RECORDED, not fixed: closing it renumbers every level in every circuit',
  ],
  minWidth: 22,
  minHeight: 5,
  build: () => {
    const { parts, put, run } = builder()
    const source = put({ x: 1, y: 2 }, 'lever', lever())
    const wires = run({ x: 2, y: 2 }, 16)
    const lamp = put({ x: 18, y: 2 }, 'lamp')
    return { parts, watched: [source, wires[0] ?? source, wires[13] ?? source, wires[14] ?? source, lamp] }
  },
}

/**
 * Three lamps in a row next to one wire.
 *
 * The claim, from the `CONDUCTS_POWER` comment: a lamp receives power but does
 * not conduct it, so it cannot weld two circuits together. Watch how many lamps
 * light. Two of the three used to.
 */
const lampChain: Scenario = {
  name: 'lamp-chain',
  title: 'litness stops exactly where power stops',
  notes: [
    't the lever, . once, and count the lit lamps (O = lit, o = dark)',
    'only the first lamp touches a wire, so only the first lights',
    'the second used to light too: isLit asked whether any NEIGHBOUR carried power, and a lit',
    'lamp carries its own decayed level. It now asks whether a cell that DRIVES it carries power',
  ],
  minWidth: 12,
  minHeight: 5,
  build: () => {
    const { parts, put, run } = builder()
    const source = put({ x: 1, y: 2 }, 'lever', lever())
    run({ x: 2, y: 2 }, 2)
    const lampA = put({ x: 4, y: 2 }, 'lamp')
    const lampB = put({ x: 5, y: 2 }, 'lamp')
    const lampC = put({ x: 6, y: 2 }, 'lamp')
    return { parts, watched: [source, lampA, lampB, lampC] }
  },
}

/**
 * The same signal sent down two lines, one through a 4-tick repeater.
 *
 * The claim used to be `Component.delayTicks` — 「vanilla 1–4」 — and a repeater
 * set to 4 arriving four ticks after one set to 1. It never did: the field was
 * stored and never read, and it has been removed rather than left as a promise
 * the graph does not keep. The two lamps make the comparison a glance instead of
 * an arithmetic exercise, and the comparison is now the DOCUMENTED gap.
 */
const repeaterDelay: Scenario = {
  name: 'repeater-delay',
  title: 'repeater delay — one tick, and only one',
  notes: [
    't the lever, then step (.) one tick at a time and watch the two lamps',
    'the top line is plain wire; the bottom goes through a repeater set to 4 ticks',
    'the repeater costs exactly one tick whichever delay you set — [ and ] change a preview-only',
    'number. `Component` has no delay field: honouring one needs memory propagateTick has not got',
  ],
  minWidth: 16,
  minHeight: 8,
  build: () => {
    const { parts, put, run } = builder()
    const source = put({ x: 1, y: 3 }, 'lever', lever())
    // The vertical spine: the lever feeds one wire, which feeds both rows, so
    // the two lines are fed by the same signal at the same tick. Comparing
    // arrival times only means something if the departure was simultaneous.
    put({ x: 2, y: 3 }, 'wire')

    run({ x: 2, y: 1 }, 8)
    put({ x: 2, y: 2 }, 'wire')
    const plainLamp = put({ x: 10, y: 1 }, 'lamp')

    run({ x: 2, y: 5 }, 3)
    put({ x: 2, y: 4 }, 'wire')
    const repeater = put({ x: 5, y: 5 }, 'repeater', { facing: 'right', delayTicks: 4 })
    run({ x: 6, y: 5 }, 4)
    const delayedLamp = put({ x: 10, y: 5 }, 'lamp')

    return { parts, watched: [source, plainLamp, repeater, delayedLamp] }
  },
}

/**
 * A repeater with a wire on its input side, its output side and one flank.
 *
 * The claim is the word "repeater" itself: in vanilla it is a DIODE. Signal
 * enters the back, leaves the front, and nothing comes out of the sides. This
 * circuit is how the absence of that rule was found, and what it cost.
 */
const repeaterLatch: Scenario = {
  name: 'repeater-latch',
  title: 'a repeater is a diode',
  notes: [
    't the lever and step twice: the lamp lights and the side branch stays DARK',
    'now t the lever OFF and keep stepping (n): the lamp goes out two ticks later, and stays out',
    'it used to do neither. Driving all four neighbours fed the repeater its own output through',
    'its input cell, so any circuit with a repeater in it could never be switched off',
  ],
  minWidth: 14,
  minHeight: 7,
  build: () => {
    const { parts, put, run } = builder()
    const source = put({ x: 1, y: 1 }, 'lever', lever())
    run({ x: 2, y: 1 }, 3)
    const repeater = put({ x: 5, y: 1 }, 'repeater', { facing: 'right', delayTicks: 1 })
    const input = keyOf({ x: 4, y: 1 })
    run({ x: 6, y: 1 }, 3)
    const lamp = put({ x: 9, y: 1 }, 'lamp')
    // Touching the repeater's flank and nothing else. In vanilla this branch
    // stays dark whatever the repeater does.
    const branch = put({ x: 5, y: 2 }, 'wire')
    put({ x: 5, y: 3 }, 'wire')
    const branchLamp = put({ x: 5, y: 4 }, 'lamp')
    return { parts, watched: [source, input, repeater, lamp, branch, branchLamp] }
  },
}

/**
 * Twenty repeaters in series.
 *
 * The claim used to be a constant: `SETTLE_TICK_LIMIT = MAX_POWER_LEVEL + 2`,
 * justified as 「Two more than the longest possible wire run is enough for every
 * acyclic circuit」. This circuit is acyclic, contains no wire at all, and needs
 * 22 ticks — so the constant called it a clock. The bound is now
 * `settleTickLimitFor(board)`: one tick per delay element, plus two.
 */
const repeaterChain: Scenario = {
  name: 'repeater-chain',
  title: 'settle’s tick limit counts delay elements, not wire cells',
  notes: [
    't the lever, then press s (settle) and read the HUD’s settle line',
    'it settles in 22 ticks and the limit for this board is 22: twenty repeaters, plus two',
    'under the old constant of 17 this reported OSCILLATING — for a circuit with no loop in it',
  ],
  minWidth: 26,
  minHeight: 5,
  build: () => {
    const { parts, put } = builder()
    const source = put({ x: 1, y: 2 }, 'lever', lever())
    const repeaters = Array.from({ length: 20 }, (_, index) =>
      put({ x: 2 + index, y: 2 }, 'repeater', { facing: 'right', delayTicks: 1 }),
    )
    const lamp = put({ x: 22, y: 2 }, 'lamp')
    return { parts, watched: [source, repeaters[9] ?? source, repeaters[19] ?? source, lamp] }
  },
}

/**
 * A torch inverting the wire it is fed by: the NOT gate every other gate is
 * built out of.
 *
 * This scenario's own first note was false and nobody noticed, because it is
 * true on tick 1 and the eye stops there. The torch drove its own support wire,
 * saw a powered input on the next tick and went out, then came back — a NOT gate
 * blinking with period 2. A torch does not power the block it hangs on
 * (`docs/testing.md` §7), and now it does not.
 */
const torchInverter: Scenario = {
  name: 'torch-inverter',
  title: 'a torch inverts its input, one tick late',
  notes: [
    'the lamp is LIT with the lever off — that is the inversion, and it stays lit however long',
    'you keep stepping. It used to blink: the torch powered the very wire it reads',
    't the lever and step: the torch goes out one tick AFTER the wire lights',
    'that one-tick lag is what every clock and memory cell in the game is made of',
  ],
  minWidth: 14,
  minHeight: 6,
  build: () => {
    const { parts, put, run } = builder()
    const source = put({ x: 1, y: 3 }, 'lever', lever())
    const input = run({ x: 2, y: 3 }, 3)
    // The torch hangs on the wire to its left, so that wire is what it inverts.
    const torch = put({ x: 5, y: 3 }, 'torch', { facing: 'left' })
    run({ x: 6, y: 3 }, 3)
    const lamp = put({ x: 9, y: 3 }, 'lamp')
    return { parts, watched: [source, input[2] ?? source, torch, lamp] }
  },
}

/**
 * Two torches inverting each other: a clock, and the thing `settleTickLimitFor`
 * exists to survive.
 */
const torchClock: Scenario = {
  name: 'torch-clock',
  title: 'a clock that never settles, on purpose',
  notes: [
    'press . repeatedly and watch the timeline view (v v): the pair blinks with period 2',
    'press s: settle reports oscillating: true and stops. That is the CORRECT answer here',
    'the lamps either side show the two phases; nothing you can do makes this circuit stable',
  ],
  minWidth: 12,
  minHeight: 8,
  build: () => {
    const { parts, put } = builder()
    // Each torch is attached to the other, so each inverts the other's previous
    // state. `previous` being a required argument is what makes this oscillate
    // rather than collapse to a constant.
    const first = put({ x: 3, y: 3 }, 'torch', { facing: 'down' })
    const second = put({ x: 3, y: 4 }, 'torch', { facing: 'up' })
    const lampA = put({ x: 4, y: 3 }, 'lamp')
    const lampB = put({ x: 4, y: 4 }, 'lamp')
    return { parts, watched: [first, second, lampA, lampB] }
  },
}

/**
 * A button, which in vanilla releases itself after a second.
 */
const buttonLatch: Scenario = {
  name: 'button-latch',
  title: 'a button that never lets go',
  notes: [
    't the button (b -> B) and step: the lamp lights, as it should',
    'keep stepping. In vanilla the button pops back out after 10 redstone ticks',
    'here it stays down forever: Component.active is a boolean and nobody counts a pulse',
    'that is a placement, not an oversight — a pulse is state, and release is the caller’s job',
  ],
  minWidth: 12,
  minHeight: 5,
  build: () => {
    const { parts, put, run } = builder()
    const source = put({ x: 1, y: 2 }, 'button', { active: false })
    run({ x: 2, y: 2 }, 4)
    const lamp = put({ x: 6, y: 2 }, 'lamp')
    return { parts, watched: [source, lamp] }
  },
}

/**
 * Three pistons: one that pushes, one that hits obsidian, one that is one block
 * over the limit.
 */
const pistonBench: Scenario = {
  name: 'piston-push',
  title: 'planPush, and the two ways it says no',
  notes: [
    't each lever and step once; the HUD prints what each piston did and why',
    'row 1 pushes three blocks. Row 2 refuses: obsidian (%) is pistonImmovable',
    'row 3 refuses: 13 blocks is one past PISTON_PUSH_LIMIT. Retracting never pulls them back',
  ],
  minWidth: 24,
  minHeight: 9,
  build: () => {
    const { parts, put, run } = builder()
    const watched: Array<PositionKey> = []

    const row = (y: number, blocks: ReadonlyArray<PartKind>): void => {
      watched.push(put({ x: 1, y }, 'lever', lever()))
      run({ x: 2, y }, 2)
      put({ x: 4, y }, 'piston', { facing: 'right' })
      blocks.forEach((kind, index) => {
        put({ x: 5 + index, y }, kind)
      })
    }

    row(1, ['block', 'block', 'block'])
    row(4, ['block', 'obsidian'])
    row(7, Array.from({ length: 13 }, (): PartKind => 'block'))

    return { parts, watched }
  },
}


/**
 * Two comparators in a row, each reading the dust the last one drove.
 *
 * The claim: in vanilla a comparator passes a LEVEL through unchanged, and here
 * it loses one per stage. That is `MAX_POWER_LEVEL`'s recorded divergence — a
 * source decays into its first neighbour — arriving in the one component whose
 * output is a number other components do arithmetic on. For a lever it costs a
 * cell of reach; here it corrupts the value.
 *
 * Read it in the `power` view: the comparators show 15, 14, 13 rather than
 * 15, 15, 15.
 */
const comparatorLadder: Scenario = {
  name: 'comparator-ladder',
  title: 'a comparator loses one level per stage — vanilla loses none',
  notes: [
    't the lever, s to settle, then v to the power view and read the C cells left to right',
    'they read 15 14 13: each comparator emits what it READ, and the dust in front decays once more',
    'in vanilla all three are 15, because a comparator drives the dust at its own output strength',
    'this is the same divergence as "a signal crosses 14 cells, not 15" — recorded, not fixed (DN-RS-13)',
  ],
  minWidth: 16,
  minHeight: 6,
  build: () => {
    const { parts, put } = builder()
    const source = put({ x: 1, y: 2 }, 'lever', lever())
    const first = put({ x: 2, y: 2 }, 'comparator', { facing: 'right' })
    const d0 = put({ x: 3, y: 2 }, 'wire')
    const second = put({ x: 4, y: 2 }, 'comparator', { facing: 'right' })
    const d1 = put({ x: 5, y: 2 }, 'wire')
    const third = put({ x: 6, y: 2 }, 'comparator', { facing: 'right' })
    put({ x: 7, y: 2 }, 'wire')
    put({ x: 8, y: 2 }, 'lamp')
    return { parts, watched: [source, first, d0, second, d1, third] }
  },
}

/**
 * One comparator with a wire on its rear and a wire on one flank.
 *
 * Two claims at once. The mode key (`t`) switches compare and subtract, and the
 * flank is where compare-versus-subtract is visible at all: with the sides bare
 * the two modes are the same function. The second claim is that the comparator
 * drives NEITHER side — a comparator that powered its flanks would read its own
 * output as a side signal and, in compare mode, switch itself off with it.
 */
const comparatorSides: Scenario = {
  name: 'comparator-sides',
  title: 'compare against subtract, which only differ once a side is wired',
  notes: [
    't both levers, s to settle, v to the power view: the C reads 14 — the side (13) does not beat it',
    'move onto the C and press t. S is subtract: 14 - 13 = 1, and the dust in FRONT is 0',
    'that 0 is the divergence again — a level of 1 has nothing left to hand on, so the lamp goes out',
    'the stub below the C is a side input AND a flank: it is read, and it is never driven',
  ],
  minWidth: 16,
  minHeight: 8,
  build: () => {
    const { parts, put, run } = builder()
    const source = put({ x: 1, y: 3 }, 'lever', lever())
    const rear = put({ x: 2, y: 3 }, 'wire')
    const comparator = put({ x: 3, y: 3 }, 'comparator', { facing: 'right' })
    const out = put({ x: 4, y: 3 }, 'wire')
    put({ x: 5, y: 3 }, 'lamp')

    // The side: a lever three cells up, so the side arrives at 13 — one weaker
    // than the rear's 14 — and compare passes until you shorten the run. Two
    // wire cells rather than one, and the difference matters: with one, the side
    // is 14 as well, compare still passes (it passes on EQUALITY) and subtract
    // gives 0, so the scenario would demonstrate the boundary case instead of
    // the ordinary one. The preview is where that was noticed.
    const sideSource = put({ x: 3, y: 0 }, 'lever', lever())
    put({ x: 3, y: 1 }, 'wire')
    const side = put({ x: 3, y: 2 }, 'wire')

    // The flank the comparator must never drive. `y: 4` touches it and nothing
    // else — and note that it is ALSO a side cell, so it is doing two jobs: an
    // input the comparator reads and an output it must not write.
    const flank = run({ x: 3, y: 4 }, 1)

    return { parts, watched: [source, rear, comparator, out, sideSource, side, flank[0] ?? source] }
  },
}

/**
 * An observer watching a cell you can edit, wired to a lamp.
 *
 * The one scenario in this preview whose input is not a switch. Place or erase
 * a block in the watched cell and the observer pulses for exactly two ticks —
 * `OBSERVER_PULSE_TICKS` — then goes dark on its own. A test that asserts a
 * final state cannot see any of that: the final state is dark either way.
 *
 * It also shows the arming rule. The observer does NOT fire on the first tick
 * against the block that was already there, which is what stops a chunk load
 * from being a barrage of pulses.
 */
const observerEdge: Scenario = {
  name: 'observer-edge',
  title: 'an observer fires on a CHANGE, and not on what was already there',
  notes: [
    '. once: the observer arms on what it sees and stays dark (e). Placement is not a change',
    'move the cursor onto the block at its eye (the # to its left) and press e to mine it',
    '. again: the observer goes E and the lamp lights. . twice more and it is dark by itself',
    'the two-tick pulse is counted by the PREVIEW, not by domain/ — remaining time is state',
  ],
  minWidth: 14,
  minHeight: 6,
  build: () => {
    const { parts, put } = builder()
    // The watched cell, holding something a person can erase and replace.
    const watchedBlock = put({ x: 2, y: 2 }, 'block')
    // Facing LEFT means the eye looks left at the block and the output is on the
    // right — an observer reads forwards and pulses backwards.
    const observer = put({ x: 3, y: 2 }, 'observer', { facing: 'left' })
    const out = put({ x: 4, y: 2 }, 'wire')
    const lamp = put({ x: 5, y: 2 }, 'lamp')
    return { parts, watched: [watchedBlock, observer, out, lamp] }
  },
}

/** The empty board plan.md actually asked for. */
const sandbox: Scenario = {
  name: 'sandbox',
  title: 'an empty board',
  notes: [
    'pick a part with 1-9, 0 or - , move with the arrows or hjkl, place with space',
    'f rotates, t throws a lever or presses a button, e erases',
    '. steps one tick, n runs several, s settles, r resets the power map',
  ],
  minWidth: 4,
  minHeight: 4,
  build: () => ({ parts: new Map<PositionKey, Part>(), watched: [] }),
}

export const SCENARIOS: ReadonlyArray<Scenario> = [
  wireRun,
  lampChain,
  repeaterDelay,
  repeaterLatch,
  repeaterChain,
  comparatorLadder,
  comparatorSides,
  observerEdge,
  torchInverter,
  torchClock,
  buttonLatch,
  pistonBench,
  sandbox,
]

export const SCENARIO_NAMES: ReadonlyArray<string> = SCENARIOS.map((scenario) => scenario.name)

export const scenarioByName = (name: string): Scenario | undefined =>
  SCENARIOS.find((scenario) => scenario.name === name)

export const DEFAULT_SCENARIO = 'wire-run'
