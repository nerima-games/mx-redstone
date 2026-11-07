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
import { type ComparatorMode, comparatorOutput } from './comparator.js'
import { MAX_POWER_LEVEL, type PowerLevel } from './signal-level.js'
import type { PositionKey } from './position-key.js'

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
  | 'target'
  | 'piston'
  | 'hopper'
  | 'dispenser'
  | 'dropper'
  | 'note-block'
  | 'powered-rail'
  | 'door'
  | 'trapdoor'

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
   * Levers, buttons, observers, pressure plates and targets: whether it is currently on.
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
  /** Levers, buttons, pressure plates and torches: the solid block this component strongly powers. */
  readonly strongPowerTo?: PositionKey
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
  /** Optional runtime index. Literal boards fall back to a complete component scan. */
  readonly componentKeysByKind?: ReadonlyMap<ComponentKind, ReadonlyArray<PositionKey>>
}

export type PowerMap = ReadonlyMap<PositionKey, PowerLevel>

export type PowerTickBlockLevels = {
  readonly strongLevel: PowerLevel
  readonly weakLevel: PowerLevel
}

const EMPTY_BLOCK_POWER: ReadonlyMap<PositionKey, PowerTickBlockLevels> = new Map()

export type PowerTickState = {
  readonly power: PowerMap
  readonly blockPower: ReadonlyMap<PositionKey, PowerTickBlockLevels>
}

export type PowerTickContext = {
  readonly faceBlockNeighboursOf?: (key: PositionKey) => ReadonlyArray<PositionKey>
  readonly faceComponentNeighboursOf?: (key: PositionKey) => ReadonlyArray<PositionKey>
  readonly faceNeighboursOf?: (key: PositionKey) => ReadonlyArray<PositionKey>
  readonly faceWireNeighboursOf?: ((key: PositionKey) => ReadonlyArray<PositionKey>) | undefined
  readonly faceLampNeighboursOf?: ((key: PositionKey) => ReadonlyArray<PositionKey>) | undefined
  readonly faceSupportBlockNeighbourOf?: (key: PositionKey) => PositionKey | null
  readonly hasLampReceivers?: boolean
  readonly retainBlockPower?: boolean
  readonly isRedstoneConductiveAt?: (key: PositionKey) => boolean
  readonly previousBlockPower?: ReadonlyMap<PositionKey, PowerTickBlockLevels>
}

const EMPTY_POWER_TICK_CONTEXT: PowerTickContext = {}

export type PowerProvenanceCandidate = {
  readonly source: PositionKey
  readonly predecessor: PositionKey | null
  readonly sourceLevel: PowerLevel
  readonly attenuation: PowerLevel
}

export type PowerTickWithProvenance = {
  readonly power: PowerMap
  readonly blockPower: ReadonlyMap<PositionKey, PowerTickBlockLevels>
  readonly provenance: ReadonlyMap<PositionKey, ReadonlyArray<PowerProvenanceCandidate>>
}

export const emptyPowerMap: PowerMap = new Map<PositionKey, PowerLevel>()

const EXTERNAL_SOURCE_KINDS: ReadonlySet<ComponentKind> = new Set<ComponentKind>([
  'lever',
  'button',
  'observer',
  'pressure-plate',
  'target',
])

const SOURCE_KINDS: ReadonlySet<ComponentKind> = new Set<ComponentKind>([
  ...EXTERNAL_SOURCE_KINDS,
  'torch',
  'repeater',
  'comparator',
])

/** The power level meaning "unpowered". */
const NO_POWER_LEVEL: PowerLevel = 0
const NO_POSITION_KEYS: ReadonlyArray<PositionKey> = []

export const powerAt = (map: PowerMap, key: PositionKey): PowerLevel => map.get(key) ?? NO_POWER_LEVEL

/** Scans every component on the board. Used when no per-kind index was supplied. */
const allComponentEntries = function* allComponentEntries(
  board: CircuitBoard,
  kinds: ReadonlySet<ComponentKind>,
  overrides?: ReadonlyMap<PositionKey, Component>,
): IterableIterator<readonly [PositionKey, Component]> {
  for (const [key, boardComponent] of board.components) {
    const component = overrides?.get(key) ?? boardComponent
    if (kinds.has(component.kind)) {
      yield [key, component] as const
    }
  }
}

/** Looks components up through `board.componentKeysByKind`. Used when that index was supplied. */
const indexedComponentEntries = function* indexedComponentEntries(
  board: CircuitBoard,
  kinds: ReadonlySet<ComponentKind>,
  overrides?: ReadonlyMap<PositionKey, Component>,
): IterableIterator<readonly [PositionKey, Component]> {
  for (const kind of kinds) {
    for (const key of board.componentKeysByKind?.get(kind) ?? []) {
      const component = overrides?.get(key) ?? board.components.get(key)
      if (component) {
        yield [key, component] as const
      }
    }
  }
}

export const componentEntriesForKinds = function* componentEntriesForKinds(
  board: CircuitBoard,
  kinds: ReadonlySet<ComponentKind>,
  overrides?: ReadonlyMap<PositionKey, Component>,
): IterableIterator<readonly [PositionKey, Component]> {
  if (board.componentKeysByKind) {
    yield* indexedComponentEntries(board, kinds, overrides)
    return
  }
  yield* allComponentEntries(board, kinds, overrides)
}

/** Resolves the component at `key`, preferring an override over the board's own record. */
const resolveComponent = (
  board: CircuitBoard,
  key: PositionKey,
  overrides?: ReadonlyMap<PositionKey, Component>,
): Component | undefined => overrides?.get(key) ?? board.components.get(key)

/** `powerAt(previous, key)`, or `NO_POWER_LEVEL` when the optional cell reference is absent. */
const inputPowerAt = (
  previous: PowerMap,
  key: PositionKey | undefined,
  previousBlockPower?: ReadonlyMap<PositionKey, PowerTickBlockLevels>,
): PowerLevel => {
  if (key) {
    const block = previousBlockPower?.get(key)
    return Math.max(powerAt(previous, key), block?.strongLevel ?? NO_POWER_LEVEL, block?.weakLevel ?? NO_POWER_LEVEL)
  }
  return NO_POWER_LEVEL
}

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
const torchShouldEmit = (component: Component, inputPower: PowerLevel): boolean =>
  inputPower === NO_POWER_LEVEL && component.active !== false

const externalSourceLevel = (component: Component): PowerLevel => {
  // The components whose truth is declared from outside. `emits` lets a
  // Weighted plate report a count and a target report hit accuracy;
  // Everything else omits it and gets full power.
  if (component.active === true) {
    return component.emits ?? MAX_POWER_LEVEL
  }
  return NO_POWER_LEVEL
}

const torchSourceLevel = (
  component: Component,
  previous: PowerMap,
  previousBlockPower?: ReadonlyMap<PositionKey, PowerTickBlockLevels>,
): PowerLevel => {
  // Inversion, delayed by one tick. A torch with no attachment burns
  // Permanently, which is the standard way to write a constant source.
  const inputPower = inputPowerAt(previous, component.invertedBy, previousBlockPower)
  if (torchShouldEmit(component, inputPower)) {
    return MAX_POWER_LEVEL
  }
  return NO_POWER_LEVEL
}

const repeaterSourceLevel = (
  component: Component,
  previous: PowerMap,
  previousBlockPower?: ReadonlyMap<PositionKey, PowerTickBlockLevels>,
): PowerLevel => {
  // Repeaters restore FULL power rather than passing the level through:
  // That is what lets a signal cross more wire than one run reaches (14
  // Cells — see `MAX_POWER_LEVEL`). Where that full power GOES is
  // `conductsInto`'s business, not this function's: `sourcesOf` says a cell
  // Generates, never who it generates into.
  const inputPower = inputPowerAt(previous, component.inputFrom, previousBlockPower)
  if (inputPower > NO_POWER_LEVEL) {
    return MAX_POWER_LEVEL
  }
  return NO_POWER_LEVEL
}

/**
 * A raw board repeater never carries `active` — `domain/power-timing.ts` is
 * the one caller that sets it, on the override it builds after its own timer
 * has already resolved this tick's output from a delayed `inputFrom` read
 * that override does not repeat. Trusting that resolved value the same way
 * `externalSourceLevel` trusts an observer's is what lets the override omit
 * `inputFrom` entirely: recomputing from `previous` here would read the
 * CURRENT tick's raw input and discard the delay `advanceOrHoldRepeater`
 * just spent ticks counting down.
 */
const resolvedOrLiveRepeaterSourceLevel = (
  component: Component,
  previous: PowerMap,
  previousBlockPower?: ReadonlyMap<PositionKey, PowerTickBlockLevels>,
): PowerLevel => {
  if (typeof component.active === 'boolean') {
    return externalSourceLevel(component)
  }
  return repeaterSourceLevel(component, previous, previousBlockPower)
}

const comparatorSourceLevel = (
  component: Component,
  previous: PowerMap,
  previousBlockPower?: ReadonlyMap<PositionKey, PowerTickBlockLevels>,
): PowerLevel => {
  // The rear is either a container's reading or the cell behind, never
  // Both: in the world that cell holds one or the other. Both are read from
  // OUTSIDE the current sweep — `previous` for the wire, the world owner's
  // Statement for the container — which is what makes a comparator a delay
  // Element like a repeater (`DELAYED_KINDS`).
  const rear = component.containerSignal ?? inputPowerAt(previous, component.inputFrom, previousBlockPower)
  const sides = (component.sideInputs ?? []).map((side) => powerAt(previous, side))
  return comparatorOutput(rear, sides, component.mode ?? 'compare')
}

/**
 * The level a single component generates this tick, before any wire propagation.
 * `NO_POWER_LEVEL` means "does not generate" and is the single signal `sourcesOf`
 * uses to decide whether to record an entry — which is what lets the four kinds
 * below share one caller instead of each carrying its own `continue`.
 */
const sourceLevelFor = (
  component: Component,
  previous: PowerMap,
  previousBlockPower?: ReadonlyMap<PositionKey, PowerTickBlockLevels>,
): PowerLevel => {
  if (EXTERNAL_SOURCE_KINDS.has(component.kind)) {
    return externalSourceLevel(component)
  }
  if (component.kind === 'torch') {
    return torchSourceLevel(component, previous, previousBlockPower)
  }
  if (component.kind === 'repeater') {
    return resolvedOrLiveRepeaterSourceLevel(component, previous, previousBlockPower)
  }
  if (component.kind === 'comparator') {
    return comparatorSourceLevel(component, previous, previousBlockPower)
  }

  // `wire`, `lamp`, `hopper` and `dispenser` generate nothing, so they need no
  // Branch.
  //
  // An if-chain rather than a `switch`, deliberately: a `switch` over a closed
  // Union needs a `default` clause to satisfy oxlint's `default-case`, and
  // That clause is unreachable — an uncoverable branch sitting permanently in
  // The report, which is exactly the kind of noise that makes a coverage
  // Threshold something people learn to ignore.
  return NO_POWER_LEVEL
}

type SourceOptions = {
  readonly overrides?: ReadonlyMap<PositionKey, Component> | undefined
  readonly previousBlockPower?: ReadonlyMap<PositionKey, PowerTickBlockLevels> | undefined
}

const sourcesOfWithOptions = (
  board: CircuitBoard,
  previous: PowerMap,
  options: SourceOptions,
): PowerMap => {
  const sources = new Map<PositionKey, PowerLevel>()

  for (const [key, component] of componentEntriesForKinds(board, SOURCE_KINDS, options.overrides)) {
    const level = sourceLevelFor(component, previous, options.previousBlockPower)
    if (level > NO_POWER_LEVEL) {
      sources.set(key, level)
    }
  }

  return sources
}

export const sourcesOf = (
  board: CircuitBoard,
  previous: PowerMap,
  overrides?: ReadonlyMap<PositionKey, Component>,
): PowerMap => {
  if (overrides) {
    return sourcesOfWithOptions(board, previous, { overrides })
  }
  return sourcesOfWithOptions(board, previous, {})
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
  'target',
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
const conductsInto = (
  board: CircuitBoard,
  key: PositionKey,
  overrides?: ReadonlyMap<PositionKey, Component>,
): ReadonlyArray<PositionKey> => {
  const component = resolveComponent(board, key, overrides)
  if (!component || !CONDUCTS_POWER.has(component.kind)) {
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

const drivesInto = (board: CircuitBoard, key: PositionKey, target: PositionKey): boolean => {
  const component = board.components.get(key)
  if (!component || !CONDUCTS_POWER.has(component.kind)) {
    return false
  }

  if (!neighboursOf(board, key).includes(target)) {
    return false
  }

  if (
    component.kind === 'repeater' ||
    component.kind === 'comparator' ||
    component.kind === 'observer'
  ) {
    return component.outputTo === target
  }

  return component.kind !== 'torch' || component.invertedBy !== target
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
/** How much a signal loses crossing one wire cell — redstone dust decays by exactly this much per hop. */
const SIGNAL_DECAY_PER_BLOCK: PowerLevel = 1

const orderedSources = (
  board: CircuitBoard,
  previous: PowerMap,
  options: SourceOptions,
): ReadonlyArray<Readonly<{ component: Component; key: PositionKey; level: PowerLevel }>> => {
  const sources: Array<Readonly<{ component: Component; key: PositionKey; level: PowerLevel }>> = []
  for (const [key, component] of componentEntriesForKinds(board, SOURCE_KINDS, options.overrides)) {
    const level = sourceLevelFor(component, previous, options.previousBlockPower)
    if (level > NO_POWER_LEVEL) {
      sources.push({ component, key, level })
    }
  }
  return sources.sort((left, right) => right.level - left.level)
}

type ComponentQueue = Array<PositionKey>

const enqueueComponent = (queue: ComponentQueue, key: PositionKey): void => {
  queue.push(key)
}

const EMPTY_POWER_PROVENANCE_CANDIDATES: ReadonlyArray<PowerProvenanceCandidate> = []

const candidatesForSource = (key: PositionKey, level: PowerLevel): ReadonlyArray<PowerProvenanceCandidate> =>
  [{ attenuation: NO_POWER_LEVEL, predecessor: null, source: key, sourceLevel: level }]

type SourceSeedInput = {
  readonly board: CircuitBoard
  readonly options: SourceOptions
  readonly previous: PowerMap
}

type SeededPower = {
  readonly power: Map<PositionKey, PowerLevel>
  readonly queue: ComponentQueue
}

const provenanceMapForTick = (
  collectProvenance: boolean,
): Map<PositionKey, ReadonlyArray<PowerProvenanceCandidate>> | null => {
  if (collectProvenance) {
    return new Map()
  }
  return null
}

const seedSourceEntries = (input: Readonly<{
  sources: ReadonlyArray<Readonly<{ key: PositionKey; level: PowerLevel }>>
  power: Map<PositionKey, PowerLevel>
  provenance: Map<PositionKey, ReadonlyArray<PowerProvenanceCandidate>> | null
  queue: ComponentQueue
}>): void => {
  const { power, provenance, queue, sources } = input
  for (const { key, level } of sources) {
    power.set(key, level)
    if (provenance) {
      provenance.set(key, candidatesForSource(key, level))
    }
    enqueueComponent(queue, key)
  }
}

/** The BFS queue and its power map, seeded from this tick's sources in descending power order. */
function seedFromSources(input: SourceSeedInput & { readonly collectProvenance: true }): SeededPower & {
  readonly provenance: Map<PositionKey, ReadonlyArray<PowerProvenanceCandidate>>
}
function seedFromSources(input: SourceSeedInput & { readonly collectProvenance: false }): SeededPower & {
  readonly provenance: null
}
function seedFromSources(input: SourceSeedInput & { readonly collectProvenance: boolean }): SeededPower & {
  readonly provenance: Map<PositionKey, ReadonlyArray<PowerProvenanceCandidate>> | null
} {
  const { board, collectProvenance, options, previous } = input
  const power = new Map<PositionKey, PowerLevel>()
  const provenance = provenanceMapForTick(collectProvenance)
  const queue: ComponentQueue = []
  const sources = orderedSources(board, previous, options)
  seedSourceEntries({ power, provenance, queue, sources })
  return { power, provenance, queue }
}

/** The level `key` still has left to give after this tick's decay, if any. */
const outgoingPowerFrom = (level: PowerLevel, kind: ComponentKind | undefined): PowerLevel => {
  if (kind === 'wire') {
    return level - SIGNAL_DECAY_PER_BLOCK
  }
  return level
}

const candidateAfter = (
  candidate: PowerProvenanceCandidate,
  predecessor: PositionKey,
  attenuation: PowerLevel,
): PowerProvenanceCandidate => ({
  attenuation: candidate.attenuation + attenuation,
  predecessor,
  source: candidate.source,
  sourceLevel: candidate.sourceLevel,
})

const appendMissingCandidates = (
  incoming: ReadonlyArray<PowerProvenanceCandidate>,
  candidates: Array<PowerProvenanceCandidate>,
  step: { readonly predecessor: PositionKey; readonly attenuation: PowerLevel },
): boolean => {
  let addedCandidate = false
  for (const candidate of incoming) {
    const exists = candidates.some((existing) => existing.source === candidate.source)
    if (!exists) {
      candidates.push(candidateAfter(candidate, step.predecessor, step.attenuation))
      addedCandidate = true
    }
  }
  return addedCandidate
}

type MutableBlockPower = {
  strongLevel: PowerLevel
  weakLevel: PowerLevel
}

// Non-retaining ticks route each channel directly to receivers and never write this shared map.
const EMPTY_MUTABLE_BLOCK_POWER: Map<PositionKey, MutableBlockPower> = new Map()

type MutableBlockProvenance = {
  strongCandidates: ReadonlyArray<PowerProvenanceCandidate>
  weakCandidates: ReadonlyArray<PowerProvenanceCandidate>
}

type PowerTickOptions = {
  readonly context?: PowerTickContext | undefined
  readonly overrides?: ReadonlyMap<PositionKey, Component> | undefined
}

type MutablePropagationState = {
  readonly board: CircuitBoard
  readonly overrides: ReadonlyMap<PositionKey, Component> | undefined
  readonly context: PowerTickContext | undefined
  readonly blockPowerContext: BlockPowerContext | null
  readonly power: Map<PositionKey, PowerLevel>
  readonly blockPower: Map<PositionKey, MutableBlockPower>
  readonly queue: ComponentQueue
}

type MutablePropagation =
  | (MutablePropagationState & {
      readonly collectProvenance: true
      readonly provenance: Map<PositionKey, ReadonlyArray<PowerProvenanceCandidate>>
      readonly blockProvenance: Map<PositionKey, MutableBlockProvenance>
    })
  | (MutablePropagationState & {
      readonly collectProvenance: false
      readonly provenance: null
      readonly blockProvenance: null
    })

type BlockPowerContext = {
  readonly faceBlockNeighboursOf: (key: PositionKey) => ReadonlyArray<PositionKey>
  readonly faceComponentNeighboursOf: (key: PositionKey) => ReadonlyArray<PositionKey>
  readonly faceSupportBlockNeighbourOf?: ((key: PositionKey) => PositionKey | null) | undefined
  readonly faceWireNeighboursOf?: ((key: PositionKey) => ReadonlyArray<PositionKey>) | undefined
  readonly faceLampNeighboursOf?: ((key: PositionKey) => ReadonlyArray<PositionKey>) | undefined
  readonly hasLampReceivers?: boolean | undefined
  readonly isRedstoneConductiveAt: (key: PositionKey) => boolean
  readonly retainBlockPower: boolean
  readonly answers: Map<PositionKey, boolean>
}

type BlockPowerChannel = 'strong' | 'weak' | 'none'

type DirectionalStrongBlockSource = Component & {
  readonly kind: 'lever' | 'button' | 'pressure-plate' | 'observer' | 'repeater' | 'comparator'
}

const isDirectionalStrongBlockSource = (component: Component): component is DirectionalStrongBlockSource =>
  component.kind === 'lever' ||
  component.kind === 'button' ||
  component.kind === 'pressure-plate' ||
  component.kind === 'observer' ||
  component.kind === 'repeater' ||
  component.kind === 'comparator'

const strongBlockPowerTarget = (component: DirectionalStrongBlockSource): PositionKey | null => {
  if (component.kind === 'lever' || component.kind === 'button' || component.kind === 'pressure-plate') {
    return component.strongPowerTo ?? null
  }
  return component.outputTo ?? null
}

const torchBlockPowerChannelFor = (component: Component, neighbour: PositionKey): BlockPowerChannel => {
  if (component.invertedBy === neighbour) {
    return 'none'
  }
  if (component.strongPowerTo === neighbour) {
    return 'strong'
  }
  return 'weak'
}

const blockPowerChannelFor = (component: Component, neighbour: PositionKey): BlockPowerChannel => {
  if (component.kind === 'torch') {
    return torchBlockPowerChannelFor(component, neighbour)
  }
  if (component.kind === 'wire') {
    return 'weak'
  }
  if (isDirectionalStrongBlockSource(component) && strongBlockPowerTarget(component) === neighbour) {
    return 'strong'
  }
  return 'none'
}

const blockPowerSource = (component: Component): boolean =>
  component.kind === 'lever' ||
  component.kind === 'button' ||
  component.kind === 'pressure-plate' ||
  component.kind === 'observer' ||
  component.kind === 'repeater' ||
  component.kind === 'comparator' ||
  component.kind === 'torch' ||
  component.kind === 'wire'

const blockStateAt = (propagation: MutablePropagation, key: PositionKey): MutableBlockPower => {
  const current = propagation.blockPower.get(key)
  if (current) {
    return current
  }
  const state: MutableBlockPower = {
    strongLevel: NO_POWER_LEVEL,
    weakLevel: NO_POWER_LEVEL,
  }
  propagation.blockPower.set(key, state)
  return state
}

const blockProvenanceAt = (
  provenance: Map<PositionKey, MutableBlockProvenance>,
  key: PositionKey,
): MutableBlockProvenance => {
  const current = provenance.get(key)
  if (current) {
    return current
  }
  const state: MutableBlockProvenance = {
    strongCandidates: EMPTY_POWER_PROVENANCE_CANDIDATES,
    weakCandidates: EMPTY_POWER_PROVENANCE_CANDIDATES,
  }
  provenance.set(key, state)
  return state
}

const setCandidatesForBlockChannel = (
  state: MutableBlockProvenance,
  channel: 'strong' | 'weak',
  candidates: ReadonlyArray<PowerProvenanceCandidate>,
): void => {
  if (channel === 'strong') {
    state.strongCandidates = candidates
  } else {
    state.weakCandidates = candidates
  }
}

const candidatesForBlockChannel = (
  state: MutableBlockProvenance,
  channel: 'strong' | 'weak',
): ReadonlyArray<PowerProvenanceCandidate> => {
  if (channel === 'strong') {
    return state.strongCandidates
  }
  return state.weakCandidates
}

const componentCandidatesAfter = (
  incomingCandidates: ReadonlyArray<PowerProvenanceCandidate>,
  predecessor: PositionKey,
  attenuation: PowerLevel,
): ReadonlyArray<PowerProvenanceCandidate> =>
  incomingCandidates.map((candidate) =>
    candidateAfter(candidate, predecessor, attenuation),
  )

type ComponentPowerUpdate = {
  propagation: MutablePropagation
  key: PositionKey
  level: PowerLevel
  predecessor: PositionKey
  attenuation: PowerLevel
  incomingCandidates: ReadonlyArray<PowerProvenanceCandidate>
}

const seedComponentPower = (input: ComponentPowerUpdate): void => {
  const { attenuation, incomingCandidates, key, level, predecessor, propagation } = input
  propagation.power.set(key, level)
  const { provenance } = propagation
  if (provenance) {
    provenance.set(key, componentCandidatesAfter(
      incomingCandidates,
      predecessor,
      attenuation,
    ))
  }
  enqueueComponent(propagation.queue, key)
}

const replaceComponentPower = (input: ComponentPowerUpdate): void => {
  const { attenuation, incomingCandidates, key, level, predecessor, propagation } = input
  propagation.power.set(key, level)
  const { provenance } = propagation
  if (provenance) {
    provenance.set(key, componentCandidatesAfter(
      incomingCandidates,
      predecessor,
      attenuation,
    ))
  }
  enqueueComponent(propagation.queue, key)
}

/** @internal */
export const appendTiedComponentPower = (input: Readonly<{
  provenance: Map<PositionKey, ReadonlyArray<PowerProvenanceCandidate>>
  queue: ComponentQueue
  key: PositionKey
  predecessor: PositionKey
  attenuation: PowerLevel
  incomingCandidates: ReadonlyArray<PowerProvenanceCandidate>
}>): void => {
  const { attenuation, incomingCandidates, key, predecessor, provenance, queue } = input
  // Positive component entries receive provenance before queueing, so tied updates always have a prior candidate list.
  const candidates = [...(provenance.get(key) ?? EMPTY_POWER_PROVENANCE_CANDIDATES)]
  if (appendMissingCandidates(incomingCandidates, candidates, { attenuation, predecessor })) {
    provenance.set(key, candidates)
    enqueueComponent(queue, key)
  }
}

const updateComponentPower = (input: ComponentPowerUpdate): void => {
  const { attenuation, incomingCandidates, key, level, predecessor, propagation } = input
  const current = propagation.power.get(key)
  if (typeof current === 'undefined') {
    seedComponentPower(input)
    return
  }
  if (current < level) {
    replaceComponentPower(input)
    return
  }
  if (current === level && propagation.provenance && level > NO_POWER_LEVEL) {
    appendTiedComponentPower({
      attenuation,
      incomingCandidates,
      key,
      predecessor,
      provenance: propagation.provenance,
      queue: propagation.queue,
    })
  }
}

const replaceBlockCandidates = (params: {
  readonly state: MutableBlockProvenance
  readonly channel: 'strong' | 'weak'
  readonly incomingCandidates: ReadonlyArray<PowerProvenanceCandidate>
  readonly source: PositionKey
}): void => {
  const { state, channel, incomingCandidates, source } = params
  const candidates = incomingCandidates.map((candidate) =>
    candidateAfter(candidate, source, NO_POWER_LEVEL),
  )
  setCandidatesForBlockChannel(state, channel, candidates)
}

const blockChannelLevel = (state: MutableBlockPower, channel: 'strong' | 'weak'): PowerLevel => {
  if (channel === 'strong') {
    return state.strongLevel
  }
  return state.weakLevel
}

const setBlockChannelLevel = (
  state: MutableBlockPower,
  channel: 'strong' | 'weak',
  level: PowerLevel,
): void => {
  if (channel === 'strong') {
    state.strongLevel = level
  } else {
    state.weakLevel = level
  }
}

const appendBlockChannelProvenance = (params: {
  readonly state: MutableBlockProvenance
  readonly channel: 'strong' | 'weak'
  readonly incomingCandidates: ReadonlyArray<PowerProvenanceCandidate>
  readonly source: PositionKey
}): boolean => {
  const { state, channel, incomingCandidates, source } = params
  const candidates = [...candidatesForBlockChannel(state, channel)]
  const added = appendMissingCandidates(incomingCandidates, candidates, {
    attenuation: NO_POWER_LEVEL,
    predecessor: source,
  })
  if (added) {
    setCandidatesForBlockChannel(state, channel, candidates)
  }
  return added
}

type BlockPowerLevelUpdate = Readonly<{
  propagation: MutablePropagation
  key: PositionKey
  state: MutableBlockPower
  source: PositionKey
  channel: 'strong' | 'weak'
  level: PowerLevel
  incomingCandidates: ReadonlyArray<PowerProvenanceCandidate>
}>

const setBlockPowerLevel = (input: BlockPowerLevelUpdate): void => {
  const { channel, incomingCandidates, key, level, propagation, source, state } = input
  setBlockChannelLevel(state, channel, level)
  if (propagation.blockProvenance) {
    replaceBlockCandidates({
      channel,
      incomingCandidates,
      source,
      state: blockProvenanceAt(propagation.blockProvenance, key),
    })
  }
}

const updateTiedBlockPower = (params: {
  readonly state: MutableBlockProvenance
  readonly source: PositionKey
  readonly channel: 'strong' | 'weak'
  readonly level: PowerLevel
  readonly incomingCandidates: ReadonlyArray<PowerProvenanceCandidate>
}): boolean => {
  const { state, source, channel, incomingCandidates } = params
  return appendBlockChannelProvenance({ channel, incomingCandidates, source, state })
}

type BlockChannelUpdate = Readonly<{
  propagation: MutablePropagation
  key: PositionKey
  source: PositionKey
  channel: 'strong' | 'weak'
  level: PowerLevel
  incomingCandidates: ReadonlyArray<PowerProvenanceCandidate>
}>

const updateTiedBlockChannel = (input: BlockChannelUpdate & {
  readonly current: PowerLevel
  readonly state: MutableBlockPower
  readonly provenance: Map<PositionKey, MutableBlockProvenance> | null
}): MutableBlockPower | null => {
  const { channel, current, incomingCandidates, key, level, provenance, source, state } = input
  if (current !== level || !provenance) {
    return null
  }
  const candidateState = blockProvenanceAt(provenance, key)
  if (!updateTiedBlockPower({ channel, incomingCandidates, level, source, state: candidateState })) {
    return null
  }
  return state
}

const updateBlockChannel = (input: BlockChannelUpdate): MutableBlockPower | null => {
  const { channel, incomingCandidates, key, level, propagation, source } = input
  const state = blockStateAt(propagation, key)
  const current = blockChannelLevel(state, channel)
  if (current < level) {
    setBlockPowerLevel({ channel, incomingCandidates, key, level, propagation, source, state })
    return state
  }
  return updateTiedBlockChannel({
    channel,
    current,
    incomingCandidates,
    key,
    level,
    propagation,
    provenance: propagation.blockProvenance,
    source,
    state,
  })
}

const blockPowerLevelForComponent = (
  state: MutableBlockPower,
  componentKind: ComponentKind,
): PowerLevel => {
  if (componentKind === 'wire') {
    return state.strongLevel
  }
  return Math.max(state.strongLevel, state.weakLevel)
}

const blockPowerCandidatesForComponent = (
  state: MutableBlockPower,
  provenance: MutableBlockProvenance | undefined,
  componentKind: ComponentKind,
): ReadonlyArray<PowerProvenanceCandidate> => {
  if (!provenance) {
    return EMPTY_POWER_PROVENANCE_CANDIDATES
  }
  if (componentKind === 'wire' || state.strongLevel > state.weakLevel) {
    return provenance.strongCandidates
  }
  if (state.weakLevel > state.strongLevel) {
    return provenance.weakCandidates
  }
  return [...provenance.strongCandidates, ...provenance.weakCandidates]
}

const queryConductivity = (context: BlockPowerContext, key: PositionKey): boolean => {
  const cached = context.answers.get(key)
  if (typeof cached === 'boolean') {
    return cached
  }
  const conductive = context.isRedstoneConductiveAt(key)
  context.answers.set(key, conductive)
  return conductive
}

const queryUnobservedWireSupport = (context: BlockPowerContext, key: PositionKey): void => {
  const support = context.faceSupportBlockNeighbourOf?.(key)
  if (typeof support === 'string') {
    queryConductivity(context, support)
    return
  }
  if (context.faceSupportBlockNeighbourOf) {
    return
  }
  for (const neighbour of context.faceBlockNeighboursOf(key)) {
    queryConductivity(context, neighbour)
  }
}

type BlockPowerReceiverInput = Readonly<{
  propagation: MutablePropagation
  key: PositionKey
  state: MutableBlockPower
  faceNeighboursOf: (key: PositionKey) => ReadonlyArray<PositionKey>
}>

const receiveBlockPowerFromNeighbour = (input: BlockPowerReceiverInput, neighbour: PositionKey): void => {
  const { key, propagation, state } = input
  const component = resolveComponent(propagation.board, neighbour, propagation.overrides)
  if (component && RECEIVES_POWER.has(component.kind)) {
    const level = blockPowerLevelForComponent(state, component.kind)
    if (level > NO_POWER_LEVEL) {
      updateComponentPower({
        attenuation: NO_POWER_LEVEL,
        incomingCandidates: blockPowerCandidatesForComponent(
          state,
          propagation.blockProvenance?.get(key),
          component.kind,
        ),
        key: neighbour,
        level,
        predecessor: key,
        propagation,
      })
    }
  }
}

const receiveBlockPowerFromNeighbours = (
  input: BlockPowerReceiverInput,
  neighbours: ReadonlyArray<PositionKey>,
): void => {
  for (const neighbour of neighbours) {
    receiveBlockPowerFromNeighbour(input, neighbour)
  }
}

const receiveBlockPowerFromTypedNeighbours = (
  input: BlockPowerReceiverInput,
  wireNeighbours: ReadonlyArray<PositionKey>,
  lampNeighbours: ReadonlyArray<PositionKey>,
): void => {
  if (input.state.strongLevel > NO_POWER_LEVEL) {
    receiveBlockPowerFromNeighbours(input, wireNeighbours)
  }
  // UpdateBlockChannel only returns a block after raising a positive channel.
  receiveBlockPowerFromNeighbours(input, lampNeighbours)
}

const receiveBlockPower = (input: BlockPowerReceiverInput): void => {
  const { faceNeighboursOf, key, propagation } = input
  const wireNeighboursOf = propagation.blockPowerContext?.faceWireNeighboursOf
  const lampNeighboursOf = propagation.blockPowerContext?.faceLampNeighboursOf
  if (!wireNeighboursOf || !lampNeighboursOf) {
    receiveBlockPowerFromNeighbours(input, faceNeighboursOf(key))
    return
  }
  receiveBlockPowerFromTypedNeighbours(input, wireNeighboursOf(key), lampNeighboursOf(key))
}

type DirectBlockPowerReceivers = Readonly<{
  wires: ReadonlyArray<PositionKey>
  lamps: ReadonlyArray<PositionKey>
}>

const directBlockPowerReceiversFor = (
  context: BlockPowerContext,
  channel: Exclude<BlockPowerChannel, 'none'>,
  neighbour: PositionKey,
): DirectBlockPowerReceivers | null => {
  if (context.retainBlockPower || !context.faceWireNeighboursOf || !context.faceLampNeighboursOf) {
    return null
  }
  let wires: ReadonlyArray<PositionKey> = NO_POSITION_KEYS
  if (channel === 'strong') {
    wires = context.faceWireNeighboursOf(neighbour)
  }
  return { lamps: context.faceLampNeighboursOf(neighbour), wires }
}

const updateDirectBlockPowerReceivers = (input: Readonly<{
  propagation: MutablePropagation
  source: PositionKey
  sourcePower: PowerLevel
  incomingCandidates: ReadonlyArray<PowerProvenanceCandidate>
  neighbour: PositionKey
  receivers: DirectBlockPowerReceivers
}>): void => {
  const { incomingCandidates, neighbour, propagation, receivers, source, sourcePower } = input
  const update: ComponentPowerUpdate = {
    attenuation: NO_POWER_LEVEL,
    incomingCandidates,
    key: neighbour,
    level: sourcePower,
    predecessor: source,
    propagation,
  }
  for (const receiver of receivers.wires) {
    update.key = receiver
    updateComponentPower(update)
  }
  for (const receiver of receivers.lamps) {
    update.key = receiver
    updateComponentPower(update)
  }
}

type EmitBlockPowerNeighbourInput = Readonly<{
  propagation: MutablePropagation
  blockPowerContext: BlockPowerContext
  component: Component
  key: PositionKey
  sourcePower: PowerLevel
  incomingCandidates: ReadonlyArray<PowerProvenanceCandidate>
  neighbour: PositionKey
}>

const emitDirectBlockPowerToNeighbour = (
  input: EmitBlockPowerNeighbourInput,
  receivers: DirectBlockPowerReceivers,
): void => {
  const { blockPowerContext, incomingCandidates, key, neighbour, propagation, sourcePower } = input
  if (!queryConductivity(blockPowerContext, neighbour)) {
    return
  }
  if (receivers.wires.length === NO_POWER_LEVEL && receivers.lamps.length === NO_POWER_LEVEL) {
    return
  }
  updateDirectBlockPowerReceivers({
    incomingCandidates,
    neighbour,
    propagation,
    receivers,
    source: key,
    sourcePower,
  })
}

const emitRetainedBlockPowerToNeighbour = (
  input: EmitBlockPowerNeighbourInput,
  channel: Exclude<BlockPowerChannel, 'none'>,
): void => {
  const { blockPowerContext, incomingCandidates, key, neighbour, propagation, sourcePower } = input
  if (!queryConductivity(blockPowerContext, neighbour)) {
    return
  }
  const state = updateBlockChannel({
    channel,
    incomingCandidates,
    key: neighbour,
    level: sourcePower,
    propagation,
    source: key,
  })
  if (state) {
    receiveBlockPower({
      faceNeighboursOf: blockPowerContext.faceComponentNeighboursOf,
      key: neighbour,
      propagation,
      state,
    })
  }
}

const emitBlockPowerToNeighbour = (input: EmitBlockPowerNeighbourInput): void => {
  const { blockPowerContext, component, neighbour, propagation } = input
  const channel = blockPowerChannelFor(component, neighbour)
  if (channel === 'none' || resolveComponent(propagation.board, neighbour, propagation.overrides)) {
    return
  }
  const receivers = directBlockPowerReceiversFor(blockPowerContext, channel, neighbour)
  if (receivers) {
    emitDirectBlockPowerToNeighbour(input, receivers)
    return
  }
  emitRetainedBlockPowerToNeighbour(input, channel)
}

const emitBlockPower = (input: Readonly<{
  propagation: MutablePropagation
  component: Component
  key: PositionKey
  sourcePower: PowerLevel
  incomingCandidates: ReadonlyArray<PowerProvenanceCandidate>
}>): void => {
  const { component, incomingCandidates, key, propagation, sourcePower } = input
  const { blockPowerContext } = propagation
  if (!blockPowerContext || !blockPowerSource(component)) {
    return
  }
  // Without block-power readers, query the resting support but do not build discarded channels.
  if (!blockPowerContext.retainBlockPower &&
    blockPowerContext.hasLampReceivers === false &&
    component.kind === 'wire') {
    queryUnobservedWireSupport(blockPowerContext, key)
    return
  }
  for (const neighbour of blockPowerContext.faceBlockNeighboursOf(key)) {
    emitBlockPowerToNeighbour({
      blockPowerContext,
      component,
      incomingCandidates,
      key,
      neighbour,
      propagation,
      sourcePower,
    })
  }
}

const tickStateResult = (propagation: MutablePropagation): PowerTickState => {
  const { blockPower, blockPowerContext, power } = propagation
  if (blockPowerContext?.retainBlockPower === true) {
    return { blockPower, power }
  }
  return { blockPower: EMPTY_BLOCK_POWER, power }
}

const propagateComponentPower = (input: Readonly<{
  propagation: MutablePropagation
  key: PositionKey
  sourcePower: PowerLevel
  incomingCandidates: ReadonlyArray<PowerProvenanceCandidate>
  outgoing: PowerLevel
}>): void => {
  const { incomingCandidates, key, outgoing, propagation, sourcePower } = input
  const { board, overrides } = propagation
  const update: ComponentPowerUpdate = {
    attenuation: sourcePower - outgoing,
    incomingCandidates,
    key,
    level: outgoing,
    predecessor: key,
    propagation,
  }
  for (const neighbour of conductsInto(board, key, overrides)) {
    const receiver = resolveComponent(board, neighbour, overrides)
    if (receiver && RECEIVES_POWER.has(receiver.kind)) {
      update.key = neighbour
      updateComponentPower(update)
    }
  }
}

const propagateComponentQueueEntry = (
  propagation: MutablePropagation,
  key: PositionKey,
  level: PowerLevel,
): void => {
  const component = resolveComponent(propagation.board, key, propagation.overrides)
  const outgoing = outgoingPowerFrom(level, component?.kind)
  const incomingCandidates = propagation.provenance?.get(key) ?? EMPTY_POWER_PROVENANCE_CANDIDATES
  if (outgoing > NO_POWER_LEVEL) {
    propagateComponentPower({ incomingCandidates, key, outgoing, propagation, sourcePower: level })
  }
  if (component && propagation.blockPowerContext) {
    emitBlockPower({ component, incomingCandidates, key, propagation, sourcePower: level })
  }
}

const propagateQueueEntry = (propagation: MutablePropagation, key: PositionKey, level: PowerLevel): void =>
  propagateComponentQueueEntry(propagation, key, level)

/** @internal */
export const visitPoweredQueueEntries = <Context>(input: Readonly<{
  context: Context
  queue: ReadonlyArray<PositionKey>
  power: ReadonlyMap<PositionKey, PowerLevel>
  visit: (context: Context, key: PositionKey, level: PowerLevel) => void
}>): void => {
  for (const key of input.queue) {
    const level = input.power.get(key)
    if (typeof level === 'number') {
      input.visit(input.context, key, level)
    }
  }
}

const sourceOptionsFor = (options: PowerTickOptions): SourceOptions => ({
  overrides: options.overrides,
  previousBlockPower: options.context?.previousBlockPower,
})

const blockPowerContextFor = (options: PowerTickOptions, collectProvenance: boolean): BlockPowerContext | null => {
  const faceNeighboursOf = options.context?.faceNeighboursOf
  const faceBlockNeighboursOf = options.context?.faceBlockNeighboursOf ?? faceNeighboursOf
  const faceComponentNeighboursOf = options.context?.faceComponentNeighboursOf ?? faceNeighboursOf
  const faceWireNeighboursOf = options.context?.faceWireNeighboursOf
  const faceLampNeighboursOf = options.context?.faceLampNeighboursOf
  const isRedstoneConductiveAt = options.context?.isRedstoneConductiveAt
  if (!faceBlockNeighboursOf || !faceComponentNeighboursOf || !isRedstoneConductiveAt) {
    return null
  }
  const canRouteWithoutRetaining = options.context?.retainBlockPower === false &&
    typeof faceWireNeighboursOf !== 'undefined' &&
    typeof faceLampNeighboursOf !== 'undefined'
  return {
    answers: new Map<PositionKey, boolean>(),
    faceBlockNeighboursOf,
    faceComponentNeighboursOf,
    faceLampNeighboursOf,
    faceSupportBlockNeighbourOf: options.context?.faceSupportBlockNeighbourOf,
    faceWireNeighboursOf,
    hasLampReceivers: options.context?.hasLampReceivers,
    isRedstoneConductiveAt,
    retainBlockPower: collectProvenance || !canRouteWithoutRetaining,
  }
}

type PropagationInputState = {
  readonly board: CircuitBoard
  readonly options: PowerTickOptions
  readonly previous: PowerMap
}

type PropagationInput = PropagationInputState & (
  | { readonly collectProvenance: true }
  | { readonly collectProvenance: false }
)

const blockPowerForTick = (retainBlockPower: boolean): Map<PositionKey, MutableBlockPower> => {
  if (!retainBlockPower) {
    return EMPTY_MUTABLE_BLOCK_POWER
  }
  return new Map<PositionKey, MutableBlockPower>()
}

function propagationForTick(input: PropagationInputState & { readonly collectProvenance: true }): Extract<MutablePropagation, { readonly collectProvenance: true }>
function propagationForTick(input: PropagationInputState & { readonly collectProvenance: false }): Extract<MutablePropagation, { readonly collectProvenance: false }>
function propagationForTick(input: PropagationInput): MutablePropagation {
  const { board, options, previous } = input
  const sourceOptions = sourceOptionsFor(options)
  const blockPowerContext = blockPowerContextFor(options, input.collectProvenance)
  const retainBlockPower = input.collectProvenance || blockPowerContext?.retainBlockPower === true
  const blockPower = blockPowerForTick(retainBlockPower)
  if (input.collectProvenance) {
    const seeded = seedFromSources({ board, collectProvenance: true, options: sourceOptions, previous })
    return {
      blockPower,
      blockPowerContext,
      blockProvenance: new Map(),
      board,
      collectProvenance: true,
      context: options.context,
      overrides: options.overrides,
      power: seeded.power,
      provenance: seeded.provenance,
      queue: seeded.queue,
    }
  }
  const seeded = seedFromSources({ board, collectProvenance: false, options: sourceOptions, previous })
  return {
    blockPower,
    blockPowerContext,
    blockProvenance: null,
    board,
    collectProvenance: false,
    context: options.context,
    overrides: options.overrides,
    power: seeded.power,
    provenance: null,
    queue: seeded.queue,
  }
}

const propagationForNormalTick = (input: Readonly<{
  board: CircuitBoard
  previous: PowerMap
  overrides: ReadonlyMap<PositionKey, Component> | undefined
}>): Extract<MutablePropagation, { readonly collectProvenance: false }> => {
  const { board, overrides, previous } = input
  const seeded = seedFromSources({ board, collectProvenance: false, options: { overrides }, previous })
  return {
    blockPower: EMPTY_MUTABLE_BLOCK_POWER,
    blockPowerContext: null,
    blockProvenance: null,
    board,
    collectProvenance: false,
    context: EMPTY_POWER_TICK_CONTEXT,
    overrides,
    power: seeded.power,
    provenance: null,
    queue: seeded.queue,
  }
}

const propagateComponentsInQueue = (propagation: MutablePropagation): void => {
  visitPoweredQueueEntries({
    context: propagation,
    power: propagation.power,
    queue: propagation.queue,
    visit: propagateQueueEntry,
  })
}

const propagateQueue = (propagation: MutablePropagation): PowerTickState => {
  propagateComponentsInQueue(propagation)
  return tickStateResult(propagation)
}

function propagateTickCore(params: PropagationInput & { readonly collectProvenance: true }): PowerTickWithProvenance
function propagateTickCore(params: PropagationInput & { readonly collectProvenance: false }): PowerTickState
function propagateTickCore(params: PropagationInput): PowerTickWithProvenance | PowerTickState {
  if (params.collectProvenance) {
    const propagation = propagationForTick(params)
    const state = propagateQueue(propagation)
    return { ...state, provenance: propagation.provenance }
  }
  return propagateQueue(propagationForTick(params))
}

const propagatePowerQueue = (propagation: MutablePropagation): PowerMap => {
  propagateComponentsInQueue(propagation)
  return propagation.power
}

export const propagateTickState = (
  board: CircuitBoard,
  previous: PowerMap,
  options: PowerTickOptions = {},
): PowerTickState => propagateTickCore({ board, collectProvenance: false, options, previous })

export const propagateTick = (
  board: CircuitBoard,
  previous: PowerMap,
  overrides?: ReadonlyMap<PositionKey, Component>,
): PowerMap => propagatePowerQueue(propagationForNormalTick({
  board,
  overrides,
  previous,
}))

export const propagateTickWithProvenance = (
  board: CircuitBoard,
  previous: PowerMap,
  options: PowerTickOptions = {},
): PowerTickWithProvenance => propagateTickCore({ board, collectProvenance: true, options, previous })

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
/** One tick to produce the final map, plus one to observe that it did not change. */
const SETTLE_TICK_OVERHEAD = 2

export const settleTickLimitFor = (board: CircuitBoard): number =>
  [...componentEntriesForKinds(board, DELAYED_KINDS)].length + SETTLE_TICK_OVERHEAD

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

  for (let tick = 1; tick <= limit; tick++) {
    const next = propagateTick(board, power)
    if (samePower(power, next)) {
      return { oscillating: false, power: next, ticks: tick }
    }
    power = next
  }

  return { oscillating: true, power, ticks: limit }
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
export type PowerReadContext = {
  readonly blockPower: ReadonlyMap<PositionKey, PowerTickBlockLevels>
  readonly faceNeighboursOf: (key: PositionKey) => ReadonlyArray<PositionKey>
}

type PowerReadInput = PositionKey | Readonly<{
  key: PositionKey
  context?: PowerReadContext | undefined
}>

const powerReadInputFor = (input: PowerReadInput): Readonly<{
  key: PositionKey
  context?: PowerReadContext | undefined
}> => {
  if (typeof input === 'string') {
    return { key: input }
  }
  return input
}

const blockPowerLevelFor = (
  componentKind: ComponentKind | undefined,
  channels: PowerTickBlockLevels,
): PowerLevel => {
  if (componentKind === 'wire') {
    return channels.strongLevel
  }
  return Math.max(channels.strongLevel, channels.weakLevel)
}

const componentDrivenPowerAt = (params: {
  readonly board: CircuitBoard
  readonly power: PowerMap
  readonly key: PositionKey
}): PowerLevel => {
  const { board, power, key } = params
  let strongest = NO_POWER_LEVEL
  for (const neighbour of neighboursOf(board, key)) {
    const level = powerAt(power, neighbour)
    if (level > strongest && drivesInto(board, neighbour, key)) {
      strongest = level
    }
  }
  return strongest
}

const blockPowerAtNeighbours = (params: {
  readonly key: PositionKey
  readonly kind: ComponentKind | undefined
  readonly context: PowerReadContext
}): PowerLevel => {
  const { key, kind, context } = params
  let strongest = NO_POWER_LEVEL
  for (const neighbour of context.faceNeighboursOf(key)) {
    const channels = context.blockPower.get(neighbour)
    if (channels) {
      const level = blockPowerLevelFor(kind, channels)
      if (level > strongest) {
        strongest = level
      }
    }
  }
  return strongest
}

const blockDrivenPowerAt = (params: {
  readonly board: CircuitBoard
  readonly key: PositionKey
  readonly context?: PowerReadContext | undefined
}): PowerLevel => {
  const { board, key, context } = params
  if (!context) {
    return NO_POWER_LEVEL
  }
  return blockPowerAtNeighbours({ context, key, kind: board.components.get(key)?.kind })
}

export const drivenPowerAt = (
  board: CircuitBoard,
  power: PowerMap,
  input: PowerReadInput,
): PowerLevel => {
  const { key, context } = powerReadInputFor(input)
  const componentPower = componentDrivenPowerAt({ board, key, power })
  const blockPower = blockDrivenPowerAt({ board, context, key })
  return Math.max(componentPower, blockPower)
}

/**
 * A lamp is lit when a cell that DRIVES it carries power.
 *
 * The kind check is not redundant with `drivenPowerAt`: a wire in the middle of
 * a run is driven by its neighbour and is not "lit", and a caller who confused
 * the two would light every cell on the board. `test/power-graph.test.ts` pins
 * that separately.
 */
export const isLit = (
  board: CircuitBoard,
  power: PowerMap,
  input: PowerReadInput,
): boolean => {
  const { key } = powerReadInputFor(input)
  return board.components.get(key)?.kind === 'lamp' && drivenPowerAt(board, power, input) > NO_POWER_LEVEL
}

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
export const isPowered = (
  board: CircuitBoard,
  power: PowerMap,
  input: PowerReadInput,
): boolean => drivenPowerAt(board, power, input) > NO_POWER_LEVEL
