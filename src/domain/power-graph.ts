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
 *
 * ---------------------------------------------------------------------------
 * Rules live in their own files; this one places them
 * ---------------------------------------------------------------------------
 *
 * A comparator's arithmetic is `domain/comparator.ts` and a plate's weighing is
 * `domain/pressure-plate.ts`. Neither of those files knows what a board is, and
 * this one does not know what a comparator computes — it knows which cell is the
 * rear and which are the sides, which is placement, which is the one thing this
 * file is for. The two components that read no cell at all (`hopper`,
 * `dispenser`) appear here only as kinds, so that a board can contain them and
 * so that power stops at them.
 */
import { comparatorOutput, type ComparatorMode } from './comparator'
import type { PositionKey } from './position-key'
import { MAX_POWER_LEVEL, type PowerLevel } from './signal-level'

/**
 * The signal range, re-exported.
 *
 * `MAX_POWER_LEVEL` and `PowerLevel` moved to `domain/signal-level.ts` when the
 * comparator arrived — the comparator and the weighted pressure plate both do
 * arithmetic in this range, this file needs both of their rules, and a constant
 * that all three want cannot live in the file two of them import. That header
 * carries the full reasoning. The names are re-exported here, and therefore from
 * the barrel, so nothing downstream saw the move.
 */
export { MAX_POWER_LEVEL, type PowerLevel }

/**
 * Every kind of component a board can hold.
 *
 * The last five arrived together and split three ways, which is the useful thing
 * to notice about them:
 *
 *   - `comparator` is a SOURCE with a computed level, and the only component in
 *     the model whose output is a number rather than a yes/no.
 *   - `observer` and `pressure-plate` are sources whose `active` is set by
 *     something outside the graph — a block that changed, an entity that stood
 *     on it — exactly as a lever's is set by a player.
 *   - `hopper` and `dispenser` are neither. They neither receive power nor pass
 *     it, so a wire on each side of one is two circuits; they are on the board
 *     because `redstone:effects` has to find them and because power has to STOP
 *     at them. See `RECEIVES_POWER` for why they are not in it.
 */
export type ComponentKind =
  | 'wire'
  | 'torch'
  | 'lever'
  | 'button'
  | 'repeater'
  | 'lamp'
  | 'comparator'
  | 'observer'
  | 'pressure-plate'
  | 'piston'
  | 'hopper'
  | 'dispenser'

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
   * Levers, buttons, observers and pressure plates: whether it is currently on.
   *
   * One field for four components because it means one thing in all four: THE
   * OWNER OF THE WORLD SAYS THIS IS ON RIGHT NOW. What differs is who the owner
   * is answering to — a player's hand for a lever and a button, a block that
   * changed for an observer (`domain/observer.ts`), an entity standing on it for
   * a plate (`domain/pressure-plate.ts`) — and none of those is visible from
   * inside the power graph.
   *
   * A button is a PULSE in vanilla and a boolean here; nothing in this file
   * counts one down, and neither does anything count down an observer's two
   * ticks. That is deliberate and it is the caller's job — see the note above
   * `sourcesOf`.
   */
  readonly active?: boolean
  /**
   * How strong this source is while `active`. Omitted means full power.
   *
   * Only a weighted pressure plate needs it: a gold plate reports how many
   * things are standing on it, and `domain/pressure-plate.ts` turns that count
   * into this number. A lever could carry one and no lever does, which is the
   * right shape — the field is read for every source uniformly, so there is no
   * component for which setting it silently does nothing.
   *
   * Not used by a comparator. A comparator's level is derived from the board
   * every tick (see `sourcesOf`), so writing it down would be storing a cached
   * value beside the thing it is cached from.
   */
  readonly emits?: PowerLevel
  /** Repeaters: transition delay in redstone ticks, clamped to 1–4. */
  readonly delayTicks?: number
  /** Buttons: pulse duration in redstone ticks. Omitted means a stone button's 10 ticks. */
  readonly pulseTicks?: number
  /**
   * Torches: the cell whose power inverts this torch. In the world this is the
   * block the torch is attached to.
   *
   * The torch reads this cell and never DRIVES it (`conductsInto`). A torch that
   * powered its own support would re-light itself from it on the next tick.
   */
  readonly invertedBy?: PositionKey
  /**
   * Repeaters and comparators: the cell read as input. In the world this is the
   * block behind the component — its REAR.
   *
   * The two read it differently and that difference is the comparator: a
   * repeater asks whether the rear carries anything and then emits full power,
   * while a comparator asks HOW MUCH and emits a function of it. A repeater is
   * therefore immune to the level it receives and a comparator is not. Source
   * output must consequently enter adjacent dust unchanged (DN-RS-13).
   */
  readonly inputFrom?: PositionKey
  /**
   * Repeaters and comparators: the cells beside the component.
   *
   * A powered side locks a repeater at its current output. A comparator reads
   * the strongest side and compares it with its rear input.
   *
   * A list rather than two named fields because either component has two sides in
   * vanilla and the number is a property of the world's geometry, which this
   * file refuses to know. A caller working on a 2D preview grid supplies two; a
   * caller reading voxel faces might one day supply four for a vertical
   * placement. Omitted or empty means no lock for a repeater, while `compare`
   * passes the rear through and `subtract` subtracts nothing for a comparator.
   *
   * Like `outputTo`, these SELECT edges rather than create them — a side that is
   * not a declared neighbour is still read, because reading is not conducting
   * and `adjacency` bounds where power FLOWS, not what a component may look at.
   * The asymmetry is deliberate: `invertedBy` and `inputFrom` have always been
   * read without an edge (`sourcesOf` calls `powerAt(previous, …)` directly),
   * and a comparator's sides are the same kind of reading.
   */
  readonly sideInputs?: ReadonlyArray<PositionKey>
  /**
   * Comparators: `compare` (the default) or `subtract`.
   *
   * The player toggles it by right-clicking, so it is placement state like
   * `inputFrom`. Defaulting to `compare` matches a freshly placed comparator in
   * vanilla, and matches the reference, whose state field is a `comparatorSubtract`
   * boolean checked with `=== true` (`redstone-simulation.ts:321`).
   */
  readonly mode?: ComparatorMode
  /**
   * Comparators: what the CONTAINER behind this one reads, if there is one.
   *
   * The comparator's third input, and the one that is not in the model. A
   * comparator behind a chest measures how full the chest is, and how full a
   * chest is lives in mc-sim — so it is neither the board's topology nor the
   * previous power map, and `sourcesOf` is a pure function of exactly those two.
   *
   * It is a field for the same reason `active` is: it is a statement by whoever
   * owns the world about the world right now, computed with this repository's
   * own rule (`containerSignalStrength`, `domain/comparator.ts`) from data that
   * is mc-sim's. That header names the two missing pieces exactly.
   *
   * When present it REPLACES the rear reading rather than adding to it. In the
   * world the two are mutually exclusive: the cell behind a comparator holds
   * either a container or a wire, never both.
   */
  readonly containerSignal?: PowerLevel
  /**
   * Repeaters, comparators and observers: the ONE cell this component drives. In
   * the world this is the block it faces — for an observer, the cell behind it,
   * since an observer watches forwards and outputs backwards.
   *
   * All three are diodes and all three use this field, which is the point of it
   * being about placement rather than about kind. A comparator with its output
   * unnamed is as inert as a repeater with its output unnamed, and for the same
   * reason.
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
   * Stateful delay is implemented by `advanceTimedCircuit`. The legacy
   * `propagateTick` API intentionally retains its one-tick repeater behaviour.
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
    if (
      component.kind === 'lever' ||
      component.kind === 'button' ||
      component.kind === 'observer' ||
      component.kind === 'pressure-plate'
    ) {
      // The four components whose truth is declared from outside. `emits` lets
      // a weighted plate report a count rather than a yes; everything else
      // omits it and gets full power.
      if (component.active === true) {
        sources.set(key, component.emits ?? MAX_POWER_LEVEL)
      }
      continue
    }

    if (component.kind === 'torch') {
      // Inversion, delayed by one tick. A torch with no attachment burns
      // permanently, which is the standard way to write a constant source.
      const inputPower =
        component.invertedBy === undefined ? 0 : powerAt(previous, component.invertedBy)
      if (inputPower === 0 && component.active !== false) {
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
      continue
    }

    if (component.kind === 'comparator') {
      // The rear is either a container's reading or the cell behind, never
      // both: in the world that cell holds one or the other. Both are read from
      // OUTSIDE the current sweep — `previous` for the wire, the world owner's
      // statement for the container — which is what makes a comparator a delay
      // element like a repeater (`DELAYED_KINDS`).
      const rear =
        component.containerSignal ??
        (component.inputFrom === undefined ? 0 : powerAt(previous, component.inputFrom))
      const sides = (component.sideInputs ?? []).map((side) => powerAt(previous, side))
      const output = comparatorOutput(rear, sides, component.mode ?? 'compare')
      if (output > 0) {
        sources.set(key, output)
      }
    }

    // `wire`, `lamp`, `hopper` and `dispenser` generate nothing, so they need no
    // branch.
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
 *
 * ---------------------------------------------------------------------------
 * The two ACTUATORS are not in here, and the reference's predicate says they are
 * ---------------------------------------------------------------------------
 *
 * A hopper is locked while powered and a dispenser fires on a rising edge, so
 * both plainly have to know whether they are powered — and neither is in this
 * set. The answer is `drivenPowerAt`, which asks the question a receiver's own
 * map entry only approximates: does a cell that DRIVES me carry power.
 *
 * That is not the obvious reading of the reference. Its `canConduct`
 * (`redstone-simulation.ts:24-34`) lists Dispenser among the conductors and
 * excludes only Lamp and Hopper — but `canConduct` is ONE predicate gating both
 * directions there, and this repository splits the question in two
 * (`RECEIVES_POWER` here, `CONDUCTS_POWER` below). The split is already visible
 * in this line: a lamp receives here and does not conduct there, and the
 * reference cannot say that at all.
 *
 * Adding an actuator to this set would make it hold a decayed level of its own,
 * and DN-RS-5 §5-1 is the record of what that costs — a lamp is in this set, and
 * the accessor that read its own entry leaked litness exactly one cell past
 * where power stopped. An actuator whose "am I powered" came from its own entry
 * would inherit that bug and, being a dispenser, would fire on it.
 */
const RECEIVES_POWER: ReadonlySet<ComponentKind> = new Set<ComponentKind>(['wire', 'lamp'])

/**
 * Which components pass power ONWARD to their neighbours.
 *
 * Wires, plus anything acting as a source this tick — a lever has to be able to
 * energise the wire it is placed against. Lamps are the interesting exclusion:
 * letting one conduct is the classic beginner's bug, because it silently welds
 * the two independent circuits either side of it into one.
 *
 * `hopper` and `dispenser` are excluded for the same reason as a lamp, and it
 * matters more for them: a hopper is a block a player puts IN a circuit, so a
 * hopper that conducted would join the line feeding it to the line beyond it and
 * the filter would lock itself. They are in no set at all — they neither receive
 * nor conduct — which makes them exactly as transparent to power as an empty
 * cell, and `drivenPowerAt` still answers whether one is powered.
 */
const CONDUCTS_POWER: ReadonlySet<ComponentKind> = new Set<ComponentKind>([
  'wire',
  'lever',
  'button',
  'torch',
  'repeater',
  'comparator',
  'observer',
  'pressure-plate',
])

/**
 * WHICH of a component's edges it drives this tick.
 *
 * `CONDUCTS_POWER` above answers "can this kind push power onward at all"; this
 * answers "along which edges", and the two are different questions because
 * direction is a property of the PLACEMENT, not of the kind. Four components
 * have an answer narrower than "all of them":
 *
 *   - a repeater drives exactly `outputTo` and nothing else. It is a diode. The
 *     flanks stay dark, and — the reason any circuit with a repeater in it can
 *     be switched off at all — so does `inputFrom`, which the repeater samples
 *     on the next tick and would otherwise find lifted by its own output.
 *   - a comparator, likewise, and the latch it is protected from is worse than
 *     the repeater's: a comparator drives its own SIDES with its own output, and
 *     a compare-mode comparator whose side equals its rear emits 0. So one that
 *     powered its flanks would switch itself off, then on, then off — a
 *     two-tick blinker built out of a component players use to hold a value
 *     still.
 *   - an observer drives exactly `outputTo` too. Vanilla's observer emits from
 *     its back face only, and the cell it WATCHES is in front; an omnidirectional
 *     observer would pulse into the block whose change it is watching for.
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

  if (
    component.kind === 'repeater' ||
    component.kind === 'comparator' ||
    component.kind === 'observer'
  ) {
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
 * Multi-source BFS with decay: sources apply their level to the first receiving
 * cell, and each subsequent wire step loses one. The queue is seeded in
 * descending power order, so a cell is
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
    const component = board.components.get(key)
    const outgoing = powerAt(power, key) - (component?.kind === 'wire' ? 1 : 0)
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
 * These are the three that cost a tick. Everything else resolves inside the
 * sweep.
 *
 * The comparator is the third, and it is the one this set was written for. The
 * bound below is TIGHT rather than generous specifically so that adding a
 * delayed component and forgetting this line shows up — and the day arrived:
 * a comparator reads `previous` at its rear and at both sides, so a chain of
 * them costs one tick each, and a bound that had not learned about them would
 * call a stable comparator chain a clock.
 */
const DELAYED_KINDS: ReadonlySet<ComponentKind> = new Set<ComponentKind>([
  'torch',
  'repeater',
  'comparator',
])

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
 * The strongest level arriving at a cell from a neighbour that DRIVES it.
 *
 * The qualification is the whole content of this function, and it is the second
 * time this repository has paid for getting it wrong. `isLit` used to ask "does
 * any adjacent cell carry power", and a lamp is in `RECEIVES_POWER` — a lit lamp
 * holds its own decayed level — so litness travelled exactly one lamp further
 * than power did: two lamps in a row both lit, the third did not.
 * `propagateTick` was never wrong about it; a lamp is not in `CONDUCTS_POWER`
 * and the second lamp's power really was 0. The leak was in the accessor, one
 * layer above the sweep (DN-RS-5 §5-1).
 *
 * So the question is asked ONCE, here, through `conductsInto` — the same
 * function the sweep uses — and every consumer that needs "is this thing
 * powered" asks it rather than looking at a map entry. `isLit` is one such
 * consumer. So is a dispenser deciding whether it has just seen a rising edge,
 * and a hopper deciding whether it is locked: neither is in `RECEIVES_POWER`, so
 * neither has a map entry to be misled by, and this is where they get their
 * answer instead.
 *
 * Not "the cell's own level > 0", which would be shorter and wrong at the tail
 * of a wire run: a wire at level 1 has nothing left to give (`outgoing` is 0) so
 * the cell beside it holds 0, and in vanilla the lamp there is lit.
 */
export const drivenPowerAt = (
  board: CircuitBoard,
  power: PowerMap,
  key: PositionKey,
): PowerLevel => {
  let strongest = 0
  for (const neighbour of neighboursOf(board, key)) {
    const level = powerAt(power, neighbour)
    if (level > strongest && conductsInto(board, neighbour).includes(key)) {
      strongest = level
    }
  }
  return strongest
}

/**
 * A lamp is lit when a cell that DRIVES it carries power.
 *
 * The kind check is not redundant with `drivenPowerAt`: a wire in the middle of
 * a run is driven by its neighbour and is not "lit", and a caller who confused
 * the two would light every cell on the board. `test/power-graph.test.ts` pins
 * that separately.
 */
export const isLit = (board: CircuitBoard, power: PowerMap, key: PositionKey): boolean =>
  board.components.get(key)?.kind === 'lamp' && drivenPowerAt(board, power, key) > 0

/**
 * Whether an actuator has power arriving at it.
 *
 * For components that act on power without carrying it — a dispenser
 * fires on the rising edge of this, a hopper is LOCKED while it is true
 * (`domain/hopper.ts`; note the inversion) — and for `redstone:effects`, which
 * has to ask the same question about a piston.
 *
 * Deliberately NOT restricted by kind, unlike `isLit`. "Is power arriving here"
 * is a question about a cell. A piston is a `ComponentKind` so the runtime can
 * detect powered transitions, but it remains non-conducting here; movement is
 * planned separately by `domain/piston.ts`.
 */
export const isPowered = (board: CircuitBoard, power: PowerMap, key: PositionKey): boolean =>
  drivenPowerAt(board, power, key) > 0
