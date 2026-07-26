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
 */
import type { PositionKey } from './position-key'

/** Redstone power runs 0–15; a wire loses one level per cell. */
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
  /** Levers and buttons: whether the player has switched it on. */
  readonly active?: boolean
  /**
   * Torches: the cell whose power inverts this torch. In the world this is the
   * block the torch is attached to.
   */
  readonly invertedBy?: PositionKey
  /** Repeaters: the cell read as input. */
  readonly inputFrom?: PositionKey
  /**
   * Repeaters: delay in redstone ticks (vanilla 1–4). A repeater restores full
   * power, which is how a signal travels further than 15 cells.
   */
  readonly delayTicks?: number
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
      // that is what lets a signal cross more than 15 cells.
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
    const kind = board.components.get(key)?.kind
    if (kind === undefined || !CONDUCTS_POWER.has(kind)) {
      continue
    }

    const outgoing = powerAt(power, key) - 1
    if (outgoing <= 0) {
      continue
    }

    for (const neighbour of neighboursOf(board, key)) {
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
 * Upper bound on iterations in `settle`.
 *
 * A redstone clock NEVER settles — that is its purpose. Any fixpoint search over
 * a circuit therefore needs a cap, and the cap must be a documented answer
 * ("this circuit is oscillating") rather than a hang. Two more than the longest
 * possible wire run is enough for every acyclic circuit.
 */
export const SETTLE_TICK_LIMIT = MAX_POWER_LEVEL + 2

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
 * Tick until the power map stops changing, or until `SETTLE_TICK_LIMIT`.
 *
 * For tests and for the preview's "step to stable" button. The frame stage does
 * NOT call this: the game runs one tick per redstone tick, because the
 * intermediate states are the thing the player is watching.
 */
export const settle = (
  board: CircuitBoard,
  options: { readonly from?: PowerMap; readonly limit?: number } = {},
): SettleResult => {
  const limit = options.limit ?? SETTLE_TICK_LIMIT
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

/** A lamp is lit when any adjacent cell carries power. */
export const isLit = (board: CircuitBoard, power: PowerMap, key: PositionKey): boolean =>
  board.components.get(key)?.kind === 'lamp' &&
  neighboursOf(board, key).some((neighbour) => powerAt(power, neighbour) > 0)
