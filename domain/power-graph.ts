/**
 * The redstone power graph.
 *
 * ---------------------------------------------------------------------------
 * This is INTERNAL. It is not the public API of mx-redstone.
 * ---------------------------------------------------------------------------
 *
 * plan.md §3.12 gives this repository one public surface — 「stage登録のみ
 * (電力グラフは内部実装)」 — and this file is the thing it is careful to keep
 * private. The reason is that a power graph is a shape, and shapes leak: the
 * moment another repository can name `CircuitBoard`, redstone's data layout
 * becomes a cross-repository contract and every optimisation to it becomes a
 * breaking change. Everything below is exported for this repository's own tests
 * and its circuit-board preview; see docs/public-api.md.
 *
 * ---------------------------------------------------------------------------
 * The model, and what is deliberately not in it
 * ---------------------------------------------------------------------------
 *
 * A tick is a pure function of (board, previous power map). That has three
 * consequences worth stating:
 *
 *   - There is NO geometry here. Adjacency is supplied as an explicit map. The
 *     real adjacency is "the six faces of a voxel", and it belongs to
 *     mc-kernel's coordinate types (plan.md §3.1) — restating it here would fork
 *     the vocabulary. Keeping the graph geometry-free also makes a circuit
 *     fixture a literal, which is what makes the scenario tests readable.
 *   - There is NO clock. Repeater delay and torch inversion are counted in
 *     REDSTONE TICKS, i.e. in invocations of `propagateTick`, not in seconds.
 *     Wall time would make a circuit behave differently on a faster machine.
 *   - There is NO world mutation. `propagateTick` computes power; turning power
 *     into a moved piston or a lit lamp is `stages/registration.ts`'s job, and
 *     it goes through mc-sim.
 *
 * ---------------------------------------------------------------------------
 * Why one-tick delays are modelled rather than smoothed away
 * ---------------------------------------------------------------------------
 *
 * A redstone torch inverts its input with a one-tick delay, and that delay is
 * not an implementation artefact — it is the mechanism every clock, monostable
 * and memory cell in the game is built out of. Computing torch state from the
 * CURRENT power map instead of the previous one would make a torch loop either
 * diverge or settle to a constant, and every clock circuit in every player's
 * world would stop working. `previous` is therefore a required argument, not an
 * optimisation.
 *
 * ---------------------------------------------------------------------------
 * Direction: a component drives SOME of its edges, not all of them
 * ---------------------------------------------------------------------------
 *
 * Adjacency is undirected, and for a wire that is the whole truth. It is not the
 * truth for the two components that READ a cell. A repeater is a DIODE — in at
 * the back, out at the front, nothing out of the sides — and a torch does not
 * power the block it is attached to (docs/testing.md §7 lists 「トーチは支持セルを
 * 電源にしない」 among the reference implementation's settled rules).
 *
 * An earlier draft pushed a source's power to EVERY neighbour, and both of those
 * components became latches. The repeater lifted its own input wire with its own
 * output and re-fired itself from itself on the next tick, so ANY circuit
 * containing a repeater could never be switched off; the torch did the same to
 * the wire it inverts and blinked with period 2 instead of inverting. Neither
 * was visible to a test that asserts a final state, because the final state with
 * the lever ON is the expected one — it is the state after the source goes AWAY
 * that was wrong.
 *
 * `Component` therefore NAMES the cells involved — `inputFrom` / `outputTo` for
 * a repeater, `invertedBy` for a torch — and `conductsInto` is the single place
 * where those names become edges. A predicate over `ComponentKind` cannot
 * express this: direction is a property of the placement, not of the kind.
 */
import type { PositionKey } from './position-key'

/**
 * Redstone power runs 0–15; a wire loses one level per cell.
 *
 * A signal therefore crosses FOURTEEN wire cells, not fifteen. A source occupies
 * a cell of the power map like everything else, and every conducting step loses
 * one, so the first wire beside a lever is already at 14 and the fourteenth is
 * at 1. Fifteen was written in several places here and is wrong in all of them:
 * it counts the source's own cell as wire.
 *
 * This is a DIVERGENCE from vanilla, where the dust touching a lever is at 15
 * and a run reaches fifteen cells, and it is recorded rather than fixed. Closing
 * it means a source not decaying into its first neighbour, which changes every
 * level in every circuit and is a behaviour decision, not a typo. What is fixed
 * is the arithmetic claim; `test/power-graph.test.ts` pins the 14 so that the
 * day somebody does close the gap, it is a failing test rather than a quiet
 * renumbering of the whole board.
 */
export const MAX_POWER_LEVEL = 15

export type PowerLevel = number

export type ComponentKind = 'wire' | 'torch' | 'lever' | 'button' | 'repeater' | 'lamp'

/**
 * One placed component.
 *
 * A single record with optional fields rather than a discriminated union of six
 * types: the union is nicer to write and much worse to store, because the
 * preview's circuit board is a dense grid that is edited one field at a time.
 * Revisit when the component set stops growing.
 */
export type Component = {
  readonly kind: ComponentKind
  /**
   * Levers and buttons: whether the player has switched it on.
   *
   * A button is a PULSE in vanilla and a boolean here; nothing in this file
   * counts one down. That is deliberate and it is the caller's job — see the
   * note above `sourcesOf`.
   */
  readonly active?: boolean
  /**
   * Torches: the cell whose power inverts this torch. In the world this is the
   * block the torch is attached to.
   *
   * The torch reads this cell and never DRIVES it (`conductsInto`). A torch that
   * powered its own support would re-light itself from it on the next tick.
   */
  readonly invertedBy?: PositionKey
  /**
   * Repeaters: the cell read as input. In the world this is the block behind the
   * repeater.
   */
  readonly inputFrom?: PositionKey
  /**
   * Repeaters: the ONE cell this repeater drives. In the world this is the block
   * the repeater faces.
   *
   * A repeater restores full power, which is how a signal travels further than
   * the reach of a single wire run. It restores it in exactly one direction:
   * omitting this field leaves the repeater's output unwired, which is the state
   * of a repeater the player has just placed with nothing in front of it. That
   * default is the same asymmetry `inputFrom` has — inert, not omnidirectional —
   * because the failure it prevents (two circuits welded through a component
   * placed to ISOLATE them) is silent, and the failure it causes (a repeater
   * that does nothing) is visible on the first tick.
   *
   * NOT MODELLED: vanilla's 1–4 tick repeater delay. A `delayTicks` field used
   * to sit here, was never read by anything, and has been removed rather than
   * left as a promise the graph does not keep. Honouring it needs memory — the
   * input from N ticks ago — and `propagateTick` is by design a pure function of
   * (board, previous power map), which holds exactly one tick of history. Adding
   * that memory is a change to the tick's state shape, not a change to this
   * record, so the field will come back with the mechanism and not before. Every
   * repeater currently costs exactly one tick; `test/power-graph.test.ts` pins
   * that, and `settleTickLimitFor` depends on it.
   */
  readonly outputTo?: PositionKey
}

export type CircuitBoard = {
  readonly components: ReadonlyMap<PositionKey, Component>
  /**
   * Undirected adjacency. Supplied rather than computed — see the note above on
   * geometry.
   */
  readonly adjacency: ReadonlyMap<PositionKey, ReadonlyArray<PositionKey>>
}

export type PowerMap = ReadonlyMap<PositionKey, PowerLevel>

export const emptyPowerMap: PowerMap = new Map<PositionKey, PowerLevel>()

export const powerAt = (map: PowerMap, key: PositionKey): PowerLevel => map.get(key) ?? 0

const neighboursOf = (board: CircuitBoard, key: PositionKey): ReadonlyArray<PositionKey> =>
  board.adjacency.get(key) ?? []

/**
 * The cells that GENERATE power this tick, before any wire propagation.
 *
 * Levers and buttons are unconditional sources. Torches and repeaters read
 * `previous`, which is what gives them their one-tick behaviour.
 *
 * ---------------------------------------------------------------------------
 * A button does not release itself, and that is the caller's job
 * ---------------------------------------------------------------------------
 *
 * In vanilla a stone button pops back out after 10 redstone ticks and a wooden
 * one after 15 — that pulse is what makes a button a button rather than a small
 * lever, and every monostable circuit depends on it. `active` is nevertheless a
 * plain boolean here and nothing below counts down, so a pressed button stays
 * pressed for as long as the board says it is pressed.
 *
 * That is a placement, not an oversight. Two reasons, in order of weight:
 *
 *   - A pulse is REMAINING TIME, and remaining time is state. This function is a
 *     pure function of (board, previous power map); the power map has no cell to
 *     put it in, and the board is an input, not something this file may rewrite
 *     ("There is NO world mutation" in the header). Counting it here means
 *     inventing a second state shape, exactly as repeater delay does.
 *   - The component records are assembled by whoever owns the world — the
 *     preview's grid today, mc-worldgen's chunks later — and `active` is that
 *     owner's statement about the world right now. A lever's `active` is cleared
 *     by the player; a button's is cleared by TIME, and the thing that knows
 *     redstone time is passing is `stages/registration.ts`, which converts a
 *     frame's dt into redstone ticks and already holds the board `Ref`. Release
 *     belongs there, next to the tick counter, not in the graph.
 *
 * So the graph's contract is narrow and honest: it reports what the board says.
 * `test/power-graph.test.ts` names the current behaviour so that implementing
 * release upstream shows up as a failing test rather than a silent change.
 */
export const sourcesOf = (board: CircuitBoard, previous: PowerMap): PowerMap => {
  const sources = new Map<PositionKey, PowerLevel>()

  for (const [key, component] of board.components) {
    if (component.kind === 'lever' || component.kind === 'button') {
      if (component.active === true) {
        sources.set(key, MAX_POWER_LEVEL)
      }
      continue
    }

    if (component.kind === 'torch') {
      // Inversion, delayed by one tick. A torch with no attachment burns
      // permanently, which is the standard way to write a constant source.
      const inputPower =
        component.invertedBy === undefined ? 0 : powerAt(previous, component.invertedBy)
      if (inputPower === 0) {
        sources.set(key, MAX_POWER_LEVEL)
      }
      continue
    }

    if (component.kind === 'repeater') {
      // Repeaters restore FULL power rather than passing the level through:
      // that is what lets a signal cross more wire than one run reaches (14
      // cells — see `MAX_POWER_LEVEL`). Where that full power GOES is
      // `conductsInto`'s business, not this function's: `sourcesOf` says a cell
      // generates, never who it generates into.
      const inputPower =
        component.inputFrom === undefined ? 0 : powerAt(previous, component.inputFrom)
      if (inputPower > 0) {
        sources.set(key, MAX_POWER_LEVEL)
      }
    }

    // `wire` and `lamp` generate nothing, so they need no branch.
    //
    // An if-chain rather than a `switch`, deliberately: a `switch` over a closed
    // union needs a `default` clause to satisfy oxlint's `default-case`, and
    // that clause is unreachable — an uncoverable branch sitting permanently in
    // the report, which is exactly the kind of noise that makes a coverage
    // threshold something people learn to ignore.
  }

  return sources
}

/**
 * Which components can be ENERGISED by a neighbour.
 *
 * Only wires and lamps. A lever, a button, a torch or a repeater holds whatever
 * level `sourcesOf` gave it and is never raised by an adjacent wire.
 *
 * This is the rule that makes a torch invert rather than latch. In an earlier
 * draft every component could receive, and a torch standing next to the wire it
 * inverts was re-energised by that wire on the very tick it was supposed to go
 * out — a torch that could never turn off, and therefore a game with no clocks,
 * no monostables and no memory cells. It is worth stating loudly because the
 * symptom (a circuit that is always on) looks nothing like the cause.
 */
const RECEIVES_POWER: ReadonlySet<ComponentKind> = new Set<ComponentKind>(['wire', 'lamp'])

/**
 * Which components pass power ONWARD to their neighbours.
 *
 * Wires, plus anything acting as a source this tick — a lever has to be able to
 * energise the wire it is placed against. Lamps are the interesting exclusion:
 * letting one conduct is the classic beginner's bug, because it silently welds
 * the two independent circuits either side of it into one.
 */
const CONDUCTS_POWER: ReadonlySet<ComponentKind> = new Set<ComponentKind>([
  'wire',
  'lever',
  'button',
  'torch',
  'repeater',
])

/**
 * WHICH of a component's edges it drives this tick.
 *
 * `CONDUCTS_POWER` above answers "can this kind push power onward at all"; this
 * answers "along which edges", and the two are different questions because
 * direction is a property of the PLACEMENT, not of the kind. Two components have
 * an answer narrower than "all of them":
 *
 *   - a repeater drives exactly `outputTo` and nothing else. It is a diode. The
 *     flanks stay dark, and — the reason any circuit with a repeater in it can
 *     be switched off at all — so does `inputFrom`, which the repeater samples
 *     on the next tick and would otherwise find lifted by its own output.
 *   - a torch drives every neighbour EXCEPT `invertedBy`. It does not power the
 *     block it hangs on, so it inverts instead of blinking.
 *
 * The filter over `neighboursOf` rather than a bare `[outputTo]` is deliberate:
 * `adjacency` IS the graph, so a named cell that is not a declared edge selects
 * nothing rather than creating a new edge. A caller cannot teleport power by
 * naming a distant cell, and a repeater whose output was deleted from the board
 * goes inert instead of powering a coordinate that is no longer there.
 *
 * Everything else — wire, lever, button — drives all of its edges, which is what
 * makes a wire a wire.
 */
const conductsInto = (board: CircuitBoard, key: PositionKey): ReadonlyArray<PositionKey> => {
  const component = board.components.get(key)
  if (component === undefined || !CONDUCTS_POWER.has(component.kind)) {
    return []
  }

  const neighbours = neighboursOf(board, key)

  if (component.kind === 'repeater') {
    return neighbours.filter((neighbour) => neighbour === component.outputTo)
  }

  if (component.kind === 'torch') {
    return neighbours.filter((neighbour) => neighbour !== component.invertedBy)
  }

  return neighbours
}

/**
 * Advance the circuit by one redstone tick.
 *
 * Multi-source BFS with decay: sources start at their level and each conducting
 * step loses one. The queue is seeded in descending power order, so a cell is
 * reached at its final level first and the sweep is O(cells + edges) rather than
 * O(cells × sources).
 *
 * A lamp's own entry in the returned map is a DECAYED level, so it is not the
 * right thing to test for litness — see `isLit`.
 */
export const propagateTick = (board: CircuitBoard, previous: PowerMap): PowerMap => {
  const power = new Map<PositionKey, PowerLevel>()
  const sources = [...sourcesOf(board, previous)].sort(([, left], [, right]) => right - left)

  const queue: Array<PositionKey> = []
  for (const [key, level] of sources) {
    power.set(key, level)
    queue.push(key)
  }

  // `for...of` over an array re-reads `length` on every step, so entries pushed
  // inside the loop ARE visited — which makes this a BFS queue with no cursor
  // and no `queue[head]` indexed read. Under `noUncheckedIndexedAccess` that
  // read would be `PositionKey | undefined` and would need an unreachable
  // `undefined` guard, i.e. a branch that can never be covered.
  for (const key of queue) {
    const outgoing = powerAt(power, key) - 1
    if (outgoing <= 0) {
      continue
    }

    for (const neighbour of conductsInto(board, key)) {
      const neighbourKind = board.components.get(neighbour)?.kind
      if (neighbourKind === undefined || !RECEIVES_POWER.has(neighbourKind)) {
        continue
      }
      if (powerAt(power, neighbour) >= outgoing) {
        continue
      }
      power.set(neighbour, outgoing)
      queue.push(neighbour)
    }
  }

  return power
}

/**
 * The components whose output is a function of the PREVIOUS power map.
 *
 * These are the two that cost a tick. Everything else resolves inside the sweep.
 */
const DELAYED_KINDS: ReadonlySet<ComponentKind> = new Set<ComponentKind>(['torch', 'repeater'])

/**
 * Upper bound on iterations in `settle`, for THIS board.
 *
 * A redstone clock NEVER settles — that is its purpose. Any fixpoint search over
 * a circuit therefore needs a cap, and the cap must be a documented answer
 * ("this circuit is oscillating") rather than a hang.
 *
 * ---------------------------------------------------------------------------
 * Why this is a function of the board and not a constant
 * ---------------------------------------------------------------------------
 *
 * It used to be `MAX_POWER_LEVEL + 2 = 17`, justified as "two more than the
 * longest possible wire run is enough for every acyclic circuit". That sentence
 * bounds the wrong quantity. **Settling time is bounded by sequential delay
 * elements, not by decay distance.** A whole wire run — however long — resolves
 * inside a single `propagateTick`, because the sweep is a BFS over the entire
 * board; decay costs no ticks at all. What costs a tick is reading `previous`,
 * and only a torch and a repeater do that.
 *
 * The old constant was therefore right for the wrong reason up to fifteen
 * elements and simply wrong above it: a chain of sixteen repeaters contains no
 * wire, contains no loop, needs eighteen ticks, and was reported
 * `oscillating: true` — a "your contraption is a clock" verdict for a circuit
 * that is perfectly stable, and a scheduler that stops ticking settled regions
 * would never stop ticking any real repeater chain.
 *
 * The bound is:
 *
 *   - one tick per delay element in SERIES. An element cannot resolve before its
 *     input has, so the deepest element resolves at tick (its depth + 1). The
 *     longest series chain cannot be longer than the number of delay elements on
 *     the board, so counting them is a sound over-estimate — and unlike "longest
 *     chain" it is O(components), needs no traversal, and stays defined for a
 *     board whose delay graph has a cycle.
 *   - plus one for the tick that produces the final map.
 *   - plus one for the tick that observes that it did not change. A fixpoint is
 *     only known after a tick that changes nothing.
 *
 * A board with no delay elements gets 2, which is exactly right: one tick to
 * light every wire, one to confirm. This is TIGHT, not generous, and that is the
 * point — a bound with slack in it hides the day the model grows a third delayed
 * component and somebody forgets to add it to `DELAYED_KINDS`.
 */
export const settleTickLimitFor = (board: CircuitBoard): number => {
  let delayed = 0
  for (const component of board.components.values()) {
    if (DELAYED_KINDS.has(component.kind)) {
      delayed += 1
    }
  }
  return delayed + 2
}

export type SettleResult = {
  readonly power: PowerMap
  readonly ticks: number
  /** `true` when the limit was reached without reaching a fixpoint. */
  readonly oscillating: boolean
}

const samePower = (left: PowerMap, right: PowerMap): boolean => {
  if (left.size !== right.size) {
    return false
  }
  for (const [key, level] of left) {
    if (right.get(key) !== level) {
      return false
    }
  }
  return true
}

/**
 * Tick until the power map stops changing, or until `settleTickLimitFor(board)`.
 *
 * For tests and for the preview's "step to stable" button. The frame stage does
 * NOT call this: the game runs one tick per redstone tick, because the
 * intermediate states are the thing the player is watching.
 */
export const settle = (
  board: CircuitBoard,
  options: { readonly from?: PowerMap; readonly limit?: number } = {},
): SettleResult => {
  const limit = options.limit ?? settleTickLimitFor(board)
  let power = options.from ?? emptyPowerMap

  for (let tick = 1; tick <= limit; tick += 1) {
    const next = propagateTick(board, power)
    if (samePower(power, next)) {
      return { power: next, ticks: tick, oscillating: false }
    }
    power = next
  }

  return { power, ticks: limit, oscillating: true }
}

/**
 * A lamp is lit when a cell that DRIVES it carries power.
 *
 * The qualification is the whole content of this function. It used to read "when
 * any adjacent cell carries power", and a lamp is in `RECEIVES_POWER` — a lit
 * lamp holds its own decayed level — so litness travelled exactly one lamp
 * further than power did: two lamps in a row both lit, the third did not.
 * `propagateTick` was never wrong about this; a lamp is not in `CONDUCTS_POWER`
 * and the second lamp's power really was 0. The leak was here, in the accessor,
 * one layer above the sweep — which is the same failure the comment on
 * `CONDUCTS_POWER` warns about, arriving through the door nobody was watching.
 * Reusing `conductsInto` means the accessor and the sweep cannot disagree again;
 * a lamp on a repeater's flank is dark here for the same reason it has no power.
 *
 * Not "the lamp's own level > 0", which would be shorter and wrong at the tail
 * of a wire run: a wire at level 1 has nothing left to give (`outgoing` is 0) so
 * the lamp beside it holds 0, and in vanilla that lamp is lit.
 */
export const isLit = (board: CircuitBoard, power: PowerMap, key: PositionKey): boolean =>
  board.components.get(key)?.kind === 'lamp' &&
  neighboursOf(board, key).some(
    (neighbour) => powerAt(power, neighbour) > 0 && conductsInto(board, neighbour).includes(key),
  )
