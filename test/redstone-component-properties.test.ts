import { describe, expect, it } from '@effect/vitest'
import * as fc from 'fast-check'
import { Effect, Ref, Result, Schema } from 'effect'
import { BlockPositionSchema, DimensionIdSchema } from '@nerima-games/mc-kernel'
import {
  MAX_POWER_LEVEL,
  emptyPowerMap,
  isLit,
  powerAt,
  propagateTick,
  propagateTickState,
  propagateTickWithProvenance,
  type CircuitBoard,
  type Component,
  type ComponentKind,
  type PowerTickBlockLevels,
  type PowerTickContext,
} from '../src/domain/power-graph'
import { advanceTimedCircuit, emptyTimedCircuitState } from '../src/domain/power-timing'
import type { ComparatorMode } from '../src/domain/comparator'
import { observeChanges } from '../src/domain/observer'
import { HEAVY_PLATE_CAPACITY, LIGHT_PLATE_CAPACITY, plateSignal } from '../src/domain/pressure-plate'
import { targetSignal } from '../src/domain/target-block'
import {
  PistonPositionSchema,
  planPistonTransition,
  type BlockCapabilityLookup,
  type PistonFacing,
  type PistonKind,
  type PistonWorldView,
  type PistonState,
} from '../src/domain/piston'
import {
  collectPistonTransitions,
  collectPoweredComponentTransitions,
  collectTriggerEvents,
  makeRedstoneWorldState,
  syncRedstoneSnapshot,
  type RedstoneComponentSnapshot,
  type RedstoneWorldState,
} from '../src/application/world-runtime'

const signalLevel = fc.integer({ min: 0, max: MAX_POWER_LEVEL })
const line = (cells: ReadonlyArray<readonly [string, Component]>): CircuitBoard => {
  const adjacency = new Map<string, ReadonlyArray<string>>()
  for (const [index, [key]] of cells.entries()) {
    const neighbours = [cells[index - 1]?.[0], cells[index + 1]?.[0]].filter(
      (candidate): candidate is string => candidate !== undefined,
    )
    adjacency.set(key, neighbours)
  }
  return { adjacency, components: new Map(cells) }
}

const graph = (
  cells: ReadonlyArray<readonly [string, Component]>,
  edges: ReadonlyArray<readonly [string, string]>,
): CircuitBoard => {
  const adjacency = new Map<string, Array<string>>(cells.map(([key]) => [key, []]))
  for (const [from, to] of edges) {
    adjacency.get(from)?.push(to)
    adjacency.get(to)?.push(from)
  }
  return { adjacency, components: new Map(cells) }
}

const comparatorPower = (rear: number, sidePowers: ReadonlyArray<number>, mode: ComparatorMode): number => {
  const sides = sidePowers.map((power, index) => ({ key: `side-${index}`, power }))
  const sideKeys = sides.map(({ key }) => key)
  const board = graph(
    [
      ['rear', { kind: 'wire' }],
      ...sideKeys.map((key) => [key, { kind: 'wire' }] as const),
      ['comparator', { inputFrom: 'rear', kind: 'comparator', mode, outputTo: 'output', sideInputs: sideKeys }],
      ['output', { kind: 'wire' }],
    ],
    [
      ['rear', 'comparator'],
      ...sideKeys.map((key) => [key, 'comparator'] as const),
      ['comparator', 'output'],
    ],
  )
  const previous = new Map([
    ['rear', rear],
    ...sides.map(({ key, power }) => [key, power] as const),
  ])

  return powerAt(propagateTick(board, previous), 'comparator')
}

const sortedPower = (power: ReadonlyMap<string, number>) =>
  [...power].sort(([left], [right]) => left.localeCompare(right))

const tiedBlockBoard = (leftPower: number, rightPower: number, reverse: boolean): {
  readonly board: CircuitBoard
  readonly context: PowerTickContext
} => {
  const cells: ReadonlyArray<readonly [string, Component]> = [
    ['left-source', { active: true, emits: leftPower, kind: 'lever', strongPowerTo: 'left-block' }],
    ['right-source', { active: true, emits: rightPower, kind: 'lever', strongPowerTo: 'right-block' }],
    ['wire', { kind: 'wire' }],
  ]
  const entries = reverse ? [...cells].reverse() : cells
  const board: CircuitBoard = {
    adjacency: new Map(entries.map(([key]) => [key, []])),
    components: new Map(entries),
  }
  const neighbours = new Map<string, ReadonlyArray<string>>([
    ['left-source', ['left-block']],
    ['right-source', ['right-block']],
    ['left-block', ['left-source', 'wire']],
    ['right-block', ['right-source', 'wire']],
    ['wire', ['left-block', 'right-block']],
  ])
  const context: PowerTickContext = {
    faceNeighboursOf: (key) => neighbours.get(key) ?? [],
    isRedstoneConductiveAt: (key) => key === 'left-block' || key === 'right-block',
  }
  return { board, context }
}

const sortedBlockPower = (blockPower: ReadonlyMap<string, PowerTickBlockLevels>) =>
  [...blockPower].sort(([left], [right]) => left.localeCompare(right))

describe('component properties', () => {
  it('keeps wire power independent of source and component insertion order', () => {
    // Fails if source insertion order changes the strongest power reaching a wire.
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: MAX_POWER_LEVEL }),
        fc.integer({ min: 1, max: MAX_POWER_LEVEL }),
        fc.integer({ min: 1, max: 16 }),
        (leftPower, rightPower, wireCount) => {
          const cells: Array<readonly [string, Component]> = [
            ['left', { active: true, emits: leftPower, kind: 'target' }],
            ...Array.from({ length: wireCount }, (_, index) => [`wire-${index}`, { kind: 'wire' }] as const),
            ['right', { active: true, emits: rightPower, kind: 'target' }],
          ]
          const forward = propagateTick(line(cells), emptyPowerMap)
          const reverse = propagateTick(line([...cells].reverse()), emptyPowerMap)

          expect(sortedPower(forward)).toStrictEqual(sortedPower(reverse))
          for (let index = 0; index < wireCount; index += 1) {
            const expected = Math.max(0, leftPower - index, rightPower - (wireCount - index - 1))
            expect(powerAt(forward, `wire-${index}`)).toBe(expected)
          }
        },
      ),
    )
  })

  it('keeps strong block power independent of source insertion order', () => {
    // Fails if Map insertion order changes the strongest level delivered through a conductive block.
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: MAX_POWER_LEVEL }),
        fc.integer({ min: 1, max: MAX_POWER_LEVEL }),
        (leftPower, rightPower) => {
          const forward = tiedBlockBoard(leftPower, rightPower, false)
          const reverse = tiedBlockBoard(leftPower, rightPower, true)
          const forwardState = propagateTickState(forward.board, emptyPowerMap, { context: forward.context })
          const reverseState = propagateTickState(reverse.board, emptyPowerMap, { context: reverse.context })

          expect(sortedPower(forwardState.power)).toStrictEqual(sortedPower(reverseState.power))
          expect(sortedBlockPower(forwardState.blockPower)).toStrictEqual(sortedBlockPower(reverseState.blockPower))
          expect(powerAt(forwardState.power, 'wire')).toBe(Math.max(leftPower, rightPower))
        },
      ),
    )
  })

  it('keeps normal and provenance traversal power equal through blocks', () => {
    // Fails if provenance tie handling changes component or strong/weak block levels.
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: MAX_POWER_LEVEL }),
        fc.integer({ min: 1, max: MAX_POWER_LEVEL }),
        (leftPower, rightPower) => {
          const scene = tiedBlockBoard(leftPower, rightPower, false)
          const normal = propagateTickState(scene.board, emptyPowerMap, { context: scene.context })
          const observed = propagateTickWithProvenance(scene.board, emptyPowerMap, { context: scene.context })

          expect(sortedPower(observed.power)).toStrictEqual(sortedPower(normal.power))
          expect(sortedBlockPower(observed.blockPower)).toStrictEqual(sortedBlockPower(normal.blockPower))
        },
      ),
    )
  })

  it('keeps every propagated power level within 0–15', () => {
    // Fails if wire decay or source propagation creates an invalid signal level.
    fc.assert(
      fc.property(signalLevel, fc.integer({ min: 1, max: 20 }), (emits, wireCount) => {
        const cells: Array<readonly [string, Component]> = [
          ['source', { active: true, emits, kind: 'lever' }],
          ...Array.from({ length: wireCount }, (_, index) => [`wire-${index}`, { kind: 'wire' }] as const),
        ]
        const power = propagateTick(line(cells), emptyPowerMap)
        const observed = cells.map(([key]) => powerAt(power, key))

        expect(observed).toHaveLength(wireCount + 1)
        for (const level of observed) {
          expect(Number.isInteger(level)).toBe(true)
          expect(level).toBeGreaterThanOrEqual(0)
          expect(level).toBeLessThanOrEqual(MAX_POWER_LEVEL)
        }
      }),
    )
  })

  it('lets a lamp receive power without passing it to the next wire', () => {
    // Fails if a powered lamp relays its input into the wire beyond it.
    fc.assert(
      fc.property(fc.integer({ min: 1, max: MAX_POWER_LEVEL }), (emits) => {
        const board = line([
          ['source', { active: true, emits, kind: 'lever' }],
          ['lamp', { kind: 'lamp' }],
          ['after-lamp', { kind: 'wire' }],
        ])
        const power = propagateTick(board, emptyPowerMap)

        expect(isLit(board, power, 'lamp')).toBe(true)
        expect(powerAt(power, 'after-lamp')).toBe(0)
      }),
    )
  })

  it('makes a repeater drive only its configured output neighbour', () => {
    // Fails if a repeater powers its rear or flank instead of only outputTo.
    fc.assert(
      fc.property(signalLevel, (inputPower) => {
        const board = graph(
          [
            ['rear', { kind: 'wire' }],
            ['repeater', { inputFrom: 'rear', kind: 'repeater', outputTo: 'output' }],
            ['output', { kind: 'wire' }],
            ['flank', { kind: 'wire' }],
          ],
          [['rear', 'repeater'], ['repeater', 'output'], ['repeater', 'flank']],
        )
        const power = propagateTick(board, new Map([['rear', inputPower]]))
        const expectedOutput = inputPower > 0 ? MAX_POWER_LEVEL : 0

        expect(powerAt(power, 'repeater')).toBe(expectedOutput)
        expect(powerAt(power, 'output')).toBe(expectedOutput)
        expect(powerAt(power, 'rear')).toBe(0)
        expect(powerAt(power, 'flank')).toBe(0)
      }),
    )
  })

  it('applies comparator compare and subtract rules to generated rear and side levels', () => {
    // Fails if comparator mode mishandles the rear-versus-strongest-side relation.
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 14 }), signalLevel, signalLevel, (rear, left, right) => {
        const leftBelow = Math.min(left, rear - 1)
        const rightBelow = Math.min(right, rear - 1)
        const belowRear = [leftBelow, rightBelow]
        const belowOrEqualRear = [leftBelow, rear]
        const aboveRear = [rear + 1, leftBelow]
        const lowerSide = leftBelow
        const nextSide = lowerSide + 1

        expect(comparatorPower(rear, belowRear, 'compare')).toBe(rear)
        expect(comparatorPower(rear, belowOrEqualRear, 'compare')).toBe(rear)
        expect(comparatorPower(rear, aboveRear, 'compare')).toBe(0)
        expect(comparatorPower(rear, aboveRear, 'compare')).toBe(
          comparatorPower(rear, [...aboveRear].reverse(), 'compare'),
        )

        const lowerOutput = comparatorPower(rear, [lowerSide, lowerSide], 'subtract')
        const nextOutput = comparatorPower(rear, [nextSide, lowerSide], 'subtract')
        expect(lowerOutput).toBe(nextOutput + 1)
        expect(comparatorPower(rear, [rear, rear], 'subtract')).toBe(0)
      }),
    )
  })

  it('inverts a torch when its configured support cell is powered', () => {
    // Fails if torch output stops being the inverse of previous support-cell power.
    fc.assert(
      fc.property(signalLevel, (supportPower) => {
        const board = graph(
          [
            ['support', { kind: 'wire' }],
            ['torch', { invertedBy: 'support', kind: 'torch' }],
            ['output', { kind: 'wire' }],
          ],
          [['support', 'torch'], ['torch', 'output']],
        )
        const state = advanceTimedCircuit(board, {
          ...emptyTimedCircuitState,
          power: new Map([['support', supportPower]]),
        })
        const expected = supportPower === 0 ? MAX_POWER_LEVEL : 0

        expect(state.torches?.get('torch')?.output).toBe(supportPower === 0)
        expect(powerAt(state.power, 'torch')).toBe(expected)
        expect(powerAt(state.power, 'output')).toBe(expected)
        expect(powerAt(state.power, 'support')).toBe(0)
      }),
    )
  })

  it('turns a lever into a source only while it is active', () => {
    // Fails if a lever ignores its active flag or emits while switched off.
    fc.assert(
      fc.property(fc.boolean(), (active) => {
        const power = propagateTick(line([
          ['lever', { active, kind: 'lever' }],
          ['wire', { kind: 'wire' }],
        ]), emptyPowerMap)
        const expected = active ? MAX_POWER_LEVEL : 0

        expect(powerAt(power, 'lever')).toBe(expected)
        expect(powerAt(power, 'wire')).toBe(expected)
      }),
    )
  })

  it('releases a button after its configured pulse and does not retrigger while held', () => {
    // Fails if a held button retriggers or its pulse length differs from its configured ticks.
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), (pulseTicks) => {
        const makeButton = (active: boolean) => line([
          ['button', { active, kind: 'button', pulseTicks }],
        ])
        let state = advanceTimedCircuit(makeButton(false), emptyTimedCircuitState)
        const pressed = makeButton(true)

        for (let tick = 0; tick < pulseTicks; tick += 1) {
          state = advanceTimedCircuit(pressed, state)
          expect(powerAt(state.power, 'button')).toBe(MAX_POWER_LEVEL)
        }
        state = advanceTimedCircuit(pressed, state)
        expect(powerAt(state.power, 'button')).toBe(0)

        state = advanceTimedCircuit(makeButton(false), state)
        state = advanceTimedCircuit(pressed, state)
        expect(powerAt(state.power, 'button')).toBe(MAX_POWER_LEVEL)
      }),
    )
  })

  it('fires an observer once for a changed sighting after arming', () => {
    // Fails if an observer fires on first sighting or repeats the same change edge.
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 12 }), (values) => {
        const initial = new Map(values.map((value, index) => [`observer-${index}`, `block-${value}`]))
        const changed = new Map(values.map((value, index) => [`observer-${index}`, `block-${value + 1001}`]))
        const armed = observeChanges(initial, new Map())
        const fired = observeChanges(changed, armed.seen)
        const held = observeChanges(changed, fired.seen)

        expect(armed.fired).toStrictEqual([])
        expect(fired.fired).toStrictEqual([...initial.keys()].sort())
        expect(held.fired).toStrictEqual([])
      }),
    )
  })

  it('keeps pressure-plate signal monotone and within the power range', () => {
    // Fails if a plate decreases, exceeds power 15, or rounds a weighted hit to zero.
    fc.assert(
      fc.property(fc.constantFrom(LIGHT_PLATE_CAPACITY, HEAVY_PLATE_CAPACITY), fc.integer({ min: 1, max: 10 }), (capacity, occupants) => {
        const weighing = { capacity, kind: 'weighted' as const }
        const current = plateSignal(occupants, weighing)
        const next = plateSignal(occupants + 1, weighing)

        expect(next).toBeGreaterThanOrEqual(current)
        expect(current).toBeGreaterThanOrEqual(0)
        expect(current).toBeLessThanOrEqual(MAX_POWER_LEVEL)
        expect(current).toBeGreaterThanOrEqual(1)
        expect(plateSignal(capacity, weighing)).toBe(MAX_POWER_LEVEL)
      }),
    )
  })

  it('keeps weighted plate power independent of component insertion order and replay', () => {
    // Fails if inserting or replaying a weighted plate changes its signal or wire decay.
    for (let occupants = 0; occupants <= HEAVY_PLATE_CAPACITY; occupants += 1) {
      const signal = plateSignal(occupants, { capacity: HEAVY_PLATE_CAPACITY, kind: 'weighted' })
      const cells: ReadonlyArray<readonly [string, Component]> = [
        ['plate', { active: signal > 0, emits: signal, kind: 'pressure-plate' }],
        ['left', { kind: 'wire' }],
        ['left-far', { kind: 'wire' }],
        ['right', { kind: 'wire' }],
        ['right-far', { kind: 'wire' }],
      ]
      const edges: ReadonlyArray<readonly [string, string]> = [
        ['plate', 'left'],
        ['left', 'left-far'],
        ['plate', 'right'],
        ['right', 'right-far'],
      ]
      const forward = propagateTick(graph(cells, edges), emptyPowerMap)
      const reversed = propagateTick(graph([...cells].reverse(), [...edges].reverse()), emptyPowerMap)
      const replay = propagateTick(graph(cells, edges), emptyPowerMap)
      const expectedFarWirePower = Math.max(0, signal - 1)

      expect(sortedPower(reversed)).toStrictEqual(sortedPower(forward))
      expect(sortedPower(replay)).toStrictEqual(sortedPower(forward))
      expect(powerAt(forward, 'plate')).toBe(signal)
      expect(powerAt(forward, 'left')).toBe(signal)
      expect(powerAt(forward, 'right')).toBe(signal)
      expect(powerAt(forward, 'left-far')).toBe(expectedFarWirePower)
      expect(powerAt(forward, 'right-far')).toBe(expectedFarWirePower)
    }
  })

  it('keeps target strength symmetric under face-local axis swaps and reflections', () => {
    // Fails if target strength is constant or changes under axis swaps and reflections.
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 0, max: 5000 }),
        fc.integer({ min: 0, max: 5000 }),
        (horizontal, vertical, distance, step) => {
          const hit = { horizontal: horizontal / 10_000, vertical: vertical / 10_000 }
          const strength = targetSignal(hit)
          const fartherFromCentre = 0.5 - distance / 10_000
          const closerToCentre = 0.5 - Math.max(0, distance - step) / 10_000

          expect(strength).toBe(targetSignal({ horizontal: hit.vertical, vertical: hit.horizontal }))
          expect(strength).toBe(targetSignal({ horizontal: 1 - hit.horizontal, vertical: 1 - hit.vertical }))
          expect(strength).toBeGreaterThanOrEqual(1)
          expect(strength).toBeLessThanOrEqual(MAX_POWER_LEVEL)
          expect(targetSignal({ horizontal: 0.5, vertical: closerToCentre })).toBeGreaterThanOrEqual(
            targetSignal({ horizontal: 0.5, vertical: fartherFromCentre }),
          )
          expect(targetSignal({ horizontal: 0.5, vertical: 0.5 })).toBe(MAX_POWER_LEVEL)
          expect(targetSignal({ horizontal: 0.5, vertical: 0 })).toBe(1)
        },
      ),
    )
  })

  it('pulls the block two cells ahead into the head cell on sticky retraction', () => {
    // Fails if sticky retraction uses the wrong facing or pulls from the wrong distance.
    const facings: ReadonlyArray<PistonFacing> = ['down', 'east', 'north', 'south', 'up', 'west']
    const origin = Schema.decodeUnknownSync(PistonPositionSchema)({ x: 3, y: -2, z: 5 })
    const offsets: Readonly<Record<PistonFacing, readonly [number, number, number]>> = {
      down: [0, -1, 0],
      east: [1, 0, 0],
      north: [0, 0, -1],
      south: [0, 0, 1],
      up: [0, 1, 0],
      west: [-1, 0, 0],
    }
    const movable: BlockCapabilityLookup = { pistonImmovable: () => Result.succeed(false) }

    fc.assert(
      fc.property(fc.constantFrom(...facings), (facing) => {
        const [dx, dy, dz] = offsets[facing]
        const source = Schema.decodeUnknownSync(PistonPositionSchema)({
          x: origin.x + dx * 2,
          y: origin.y + dy * 2,
          z: origin.z + dz * 2,
        })
        const head = Schema.decodeUnknownSync(PistonPositionSchema)({
          x: origin.x + dx,
          y: origin.y + dy,
          z: origin.z + dz,
        })
        const world: PistonWorldView = {
          read: (position) =>
            position.x === source.x && position.y === source.y && position.z === source.z
              ? { block: 'STONE', kind: 'block' }
              : { kind: 'empty' },
        }
        const outcome = planPistonTransition(
          { facing, kind: 'sticky', piston: origin, powered: false, state: 'extended' },
          world,
          movable,
        )

        expect(outcome).toMatchObject({
          kind: 'move',
          plan: { fromState: 'extended', kind: 'sticky', moves: [{ block: 'STONE', from: source, to: head }], toState: 'retracted' },
        })
      }),
    )
  })
})

const worldDimension = Schema.decodeUnknownSync(DimensionIdSchema)('overworld')
const blockPosition = (x: number) => Schema.decodeUnknownSync(BlockPositionSchema)({ x, y: 0, z: 0 })

type RuntimeEdgeEvents = {
  readonly piston: ReadonlyArray<{ readonly facing: PistonFacing; readonly kind: PistonKind; readonly powered: boolean; readonly state: PistonState }>
  readonly powered: ReadonlyArray<{ readonly kind: 'powered-rail' | 'door' | 'trapdoor'; readonly powered: boolean }>
  readonly trigger: ReadonlyArray<{ readonly kind: 'dispenser' | 'dropper' | 'note-block' }>
}

const runRuntimeSequence = (
  kind: ComponentKind,
  states: ReadonlyArray<boolean>,
  pistonFacing: PistonFacing = 'north',
  pistonKind: PistonKind = 'normal',
): RuntimeEdgeEvents =>
  Effect.runSync(
    Effect.gen(function* () {
      const state = yield* makeRedstoneWorldState
      const events: { piston: Array<RuntimeEdgeEvents['piston'][number]>; powered: Array<RuntimeEdgeEvents['powered'][number]>; trigger: Array<RuntimeEdgeEvents['trigger'][number]> } = {
        piston: [],
        powered: [],
        trigger: [],
      }
      let pistonState: PistonState = 'retracted'

      for (const active of states) {
        const target: RedstoneComponentSnapshot = {
          kind,
          position: blockPosition(1),
          ...(kind === 'piston' ? { pistonFacing, pistonKind, pistonState } : {}),
        }
        yield* installPowerFixture(state, [
          { active, kind: 'lever', position: blockPosition(0) },
          target,
        ])
        yield* collectPistonTransitions(state)
        yield* collectTriggerEvents(state)
        yield* collectPoweredComponentTransitions(state)
        const piston = yield* Ref.getAndSet(state.pendingPistonTransitions, [])
        const trigger = yield* Ref.getAndSet(state.pendingTriggerEvents, [])
        const powered = yield* Ref.getAndSet(state.pendingPoweredComponentTransitions, [])
        events.piston.push(...piston)
        events.trigger.push(...trigger)
        events.powered.push(...powered)
        for (const transition of piston) {
          pistonState = transition.powered ? 'extended' : 'retracted'
        }
      }

      return events
    }),
  )

const installPowerFixture = (
  state: RedstoneWorldState,
  components: ReadonlyArray<RedstoneComponentSnapshot>,
) =>
  Effect.gen(function* () {
    yield* syncRedstoneSnapshot(state, { components, dimension: worldDimension })
    const board = yield* Ref.get(state.board)
    yield* Ref.set(state.power, propagateTick(board, emptyPowerMap))
  })

const edgeSequence = fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }).map((toggles) => {
  let active = true
  return [active, ...toggles.map((toggle) => {
    if (toggle) active = !active
    return active
  })]
})

describe('component edge properties', () => {
  it('emits piston requests only when the powered state changes', () => {
    // Fails if piston events repeat while powered or lose a transition edge.
    fc.assert(
      fc.property(edgeSequence, fc.constantFrom('up', 'down', 'east', 'west', 'north', 'south'), fc.constantFrom('normal', 'sticky'), (states, facing, kind) => {
        const events = runRuntimeSequence('piston', states, facing, kind)
        const changes = states.filter((active, index) => active !== (index === 0 ? false : states[index - 1]))
        let previousState: PistonState = 'retracted'
        const previousStates = changes.map((active) => {
          const before = previousState
          previousState = active ? 'extended' : 'retracted'
          return before
        })

        expect(events.piston.map(({ powered }) => powered)).toStrictEqual(changes)
        expect(events.piston.map(({ state }) => state)).toStrictEqual(previousStates)
        expect(events.piston.every((event) => event.facing === facing && event.kind === kind)).toBe(true)
      }),
    )
  })

  it('fires droppers and note blocks once on each rising power edge', () => {
    // Fails if a held dropper or note block emits duplicate trigger events.
    fc.assert(
      fc.property(edgeSequence, (states) => {
        const rising = states.filter((active, index) => active && (index === 0 || !states[index - 1]))
        for (const kind of ['dropper', 'note-block'] as const) {
          const events = runRuntimeSequence(kind, states)
          expect(events.trigger.map((event) => event.kind)).toStrictEqual(Array.from({ length: rising.length }, () => kind))
        }
      }),
    )
  })

  it('reports rising and falling transitions for rails, doors, and trapdoors', () => {
    // Fails if a continuously powered component omits a falling or rising transition.
    fc.assert(
      fc.property(edgeSequence, (states) => {
        const changes = states.filter((active, index) => active !== (index === 0 ? false : states[index - 1]))
        for (const kind of ['powered-rail', 'door', 'trapdoor'] as const) {
          const events = runRuntimeSequence(kind, states)
          expect(events.powered.map((event) => event.powered)).toStrictEqual(changes)
          expect(events.powered.every((event) => event.kind === kind)).toBe(true)
        }
      }),
    )
  })
})
