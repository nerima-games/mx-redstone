import { describe, expect, it } from '@effect/vitest'
import { BlockAddressSchema, type BlockAddress } from '@nerima-games/mc-kernel'
import type { ContainerKind } from '@nerima-games/mc-sim'
import { Effect, Result, Schema } from 'effect'
import {
  emptyPowerMap,
  powerAt,
  propagateTick,
  type CircuitBoard,
  type Component,
  type PowerTickContext,
} from '../src/domain/power-graph'
import { comparatorOutput, type ComparatorMode } from '../src/domain/comparator'
import {
  plateSignal,
  type PlateWeighing,
} from '../src/domain/pressure-plate'
import {
  advanceTimedCircuit,
  advanceTimedCircuitWithContext,
  emptyTimedCircuitState,
  type TimedCircuitState,
  type TorchTimer,
} from '../src/domain/power-timing'
import { observeChanges, type Sightings } from '../src/domain/observer'
import {
  PistonPositionSchema,
  planPistonTransition,
  type BlockCapabilityLookup,
  type PistonFacing,
  type PistonState,
  type PistonTransitionRequest,
} from '../src/domain/piston'
import { selectHopperTransferCandidates } from '../src/domain/hopper'

const SIGNAL_LEVELS = Array.from({ length: 16 }, (_, level) => level)
const COMPARATOR_MODES: ReadonlyArray<ComparatorMode> = ['compare', 'subtract']
const BOOLEAN_STATES: ReadonlyArray<boolean> = [false, true]
// Java Edition burns a torch out after more than eight forced-off changes in the last 60 game ticks.
// One redstone tick is two game ticks. Source: https://minecraft.wiki/w/Redstone_Torch
const JAVA_TORCH_FORCED_OFF_CHANGE_LIMIT = 8
const JAVA_TORCH_BURNOUT_WINDOW_GAME_TICKS = 60
const GAME_TICKS_PER_REDSTONE_TICK = 2
const JAVA_TORCH_BURNOUT_WINDOW_REDSTONE_TICKS =
  JAVA_TORCH_BURNOUT_WINDOW_GAME_TICKS / GAME_TICKS_PER_REDSTONE_TICK
const PISTON_FACINGS: ReadonlyArray<{
  readonly facing: PistonFacing
  readonly offset: Readonly<{ x: number; y: number; z: number }>
}> = [
  { facing: 'down', offset: { x: 0, y: -1, z: 0 } },
  { facing: 'east', offset: { x: 1, y: 0, z: 0 } },
  { facing: 'north', offset: { x: 0, y: 0, z: -1 } },
  { facing: 'south', offset: { x: 0, y: 0, z: 1 } },
  { facing: 'up', offset: { x: 0, y: 1, z: 0 } },
  { facing: 'west', offset: { x: -1, y: 0, z: 0 } },
]
const PISTON_STATES: ReadonlyArray<PistonState> = ['extended', 'retracted']
const CONTAINER_KINDS: ReadonlyArray<ContainerKind> = ['chest', 'shulker_box', 'dispenser', 'dropper', 'hopper']
const CONTAINER_CAPACITIES: Readonly<Record<ContainerKind, number>> = {
  chest: 27,
  shulker_box: 27,
  dispenser: 9,
  dropper: 9,
  hopper: 5,
}

const pistonPosition = (x: number, y: number, z: number) =>
  Schema.decodeUnknownSync(PistonPositionSchema)({ x, y, z })

const blockAddress = (x: number, y: number, z: number): BlockAddress =>
  Schema.decodeUnknownSync(BlockAddressSchema)({
    dimension: 'overworld',
    position: { x, y, z },
  })

const hopperAddress = blockAddress(0, 64, 0)
const hopperDestinations: ReadonlyArray<Readonly<{ address: BlockAddress; kind: ContainerKind }>> =
  CONTAINER_KINDS.map((kind, index) => ({
    address: blockAddress(index + 1, 64, 0),
    kind,
  }))
const hopperSources: ReadonlyArray<Readonly<{ address: BlockAddress; kind: ContainerKind }>> =
  CONTAINER_KINDS.map((kind, index) => ({
    address: blockAddress(index + 1, 65, 0),
    kind,
  }))

type HopperCellChoice =
  | Readonly<{ readonly kind: 'none' }>
  | Readonly<{ readonly kind: 'container'; readonly address: BlockAddress; readonly containerKind: ContainerKind }>

const hopperCellChoice = (address: BlockAddress, containerKind: ContainerKind): HopperCellChoice => ({
  kind: 'container',
  address,
  containerKind,
})

const hopperCellChoices: ReadonlyArray<HopperCellChoice> = [
  { kind: 'none' },
  ...hopperSources.map(({ address, kind }) => hopperCellChoice(address, kind)),
]

const hopperDestinationChoices: ReadonlyArray<HopperCellChoice> = [
  { kind: 'none' },
  ...hopperDestinations.map(({ address, kind }) => hopperCellChoice(address, kind)),
]

const MOVABLE_PISTON_BLOCKS: BlockCapabilityLookup = {
  pistonImmovable: () => Result.succeed(false),
}

describe('finite redstone states', () => {
  it.effect('every signal strength from 0 through 15 is preserved at its source', () =>
    Effect.sync(() => {
      // This fails if any legal signal level is dropped, shifted, or exceeds the redstone range.
      for (const level of SIGNAL_LEVELS) {
        const board: CircuitBoard = {
          components: new Map<string, Component>([
            ['plate', { kind: 'pressure-plate', active: true, emits: level }],
          ]),
          adjacency: new Map([['plate', []]]),
        }

        expect(powerAt(propagateTick(board, emptyPowerMap), 'plate'), `power=${level}`).toBe(level)
      }
    }),
  )

  it.effect('wire decay covers every source level across all sixteen wire positions', () =>
    Effect.sync(() => {
      // This catches dust that gains, loses, or carries power beyond the sixteenth wire.
      for (const sourceLevel of SIGNAL_LEVELS) {
        const components = new Map<string, Component>([
          ['source', { kind: 'lever', active: sourceLevel > 0, emits: sourceLevel }],
        ])
        const adjacency = new Map<string, ReadonlyArray<string>>([['source', ['wire-0']]])

        for (let wireIndex = 0; wireIndex < 16; wireIndex += 1) {
          const key = `wire-${wireIndex}`
          const neighbours: Array<string> = []
          if (wireIndex === 0) neighbours.push('source')
          if (wireIndex > 0) neighbours.push(`wire-${wireIndex - 1}`)
          if (wireIndex < 15) neighbours.push(`wire-${wireIndex + 1}`)
          components.set(key, { kind: 'wire' })
          adjacency.set(key, neighbours)
        }

        const power = propagateTick({ components, adjacency }, emptyPowerMap)
        for (let wireIndex = 0; wireIndex < 16; wireIndex += 1) {
          const expected = Math.max(0, sourceLevel - wireIndex)
          expect(powerAt(power, `wire-${wireIndex}`), `source=${sourceLevel}, wire=${wireIndex + 1}`).toBe(expected)
        }
      }
    }),
  )

  it.effect('repeater, comparator, and torch read every previous block channel level', () =>
    Effect.sync(() => {
      // This catches timer and comparator inputs that ignore either weak or strong power on the prior block.
      const board: CircuitBoard = {
        components: new Map<string, Component>([
          ['repeater', { kind: 'repeater', inputFrom: 'repeater-rear' }],
          ['comparator', { kind: 'comparator', inputFrom: 'comparator-rear' }],
          ['torch', { kind: 'torch', invertedBy: 'torch-support' }],
        ]),
        adjacency: new Map([['repeater', []], ['comparator', []], ['torch', []]]),
      }

      for (const level of SIGNAL_LEVELS) {
        const channelLevels = [
          { strongLevel: level, weakLevel: 0 },
          { strongLevel: 0, weakLevel: level },
        ]
        for (const channels of channelLevels) {
          const previousBlockPower = new Map([
            ['repeater-rear', channels],
            ['comparator-rear', channels],
            ['torch-support', channels],
          ])
          const context: PowerTickContext = { previousBlockPower }
          const next = advanceTimedCircuitWithContext({ board, previous: emptyTimedCircuitState, pressedButtons: new Set(), context })

          expect(powerAt(next.power, 'repeater'), `repeater level=${level}`).toBe(level > 0 ? 15 : 0)
          expect(powerAt(next.power, 'comparator'), `comparator level=${level}`).toBe(level)
          expect(powerAt(next.power, 'torch'), `torch level=${level}`).toBe(level === 0 ? 15 : 0)
        }
      }
    }),
  )

  it.effect('all torch input levels, outputs, and rolling burnout states obey inversion', () =>
    Effect.sync(() => {
      // This catches torches that ignore an input level, prior output, or remaining cooldown tick.
      const board: CircuitBoard = {
        components: new Map<string, Component>([
          ['input', { kind: 'lever', active: false }],
          ['torch', { kind: 'torch', invertedBy: 'input' }],
        ]),
        adjacency: new Map([['input', []], ['torch', []]]),
      }

      for (const inputLevel of SIGNAL_LEVELS) {
        const requestedOutput = inputLevel === 0
        for (const previousOutput of BOOLEAN_STATES) {
          const previous: TimedCircuitState = {
            ...emptyTimedCircuitState,
            power: new Map([
              ['input', inputLevel],
              ['torch', previousOutput ? 15 : 0],
            ]),
            torches: new Map([[
              'torch',
              { burnedOut: false, output: previousOutput, recentOffTicks: [] },
            ]]),
          }
          const next = advanceTimedCircuit(board, previous)
          const expectedTimer = {
            burnedOut: false,
            output: requestedOutput,
            recentOffTicks: previousOutput && !requestedOutput ? [0] : [],
          }
          expect(next.torches?.get('torch'), `input=${inputLevel}, previousOutput=${previousOutput}`).toStrictEqual(expectedTimer)
          expect(powerAt(next.power, 'torch'), `input=${inputLevel}, previousOutput=${previousOutput}`).toBe(
            requestedOutput ? 15 : 0,
          )
        }

      }

      const recentToggles = Array.from({ length: JAVA_TORCH_FORCED_OFF_CHANGE_LIMIT }, () => 0)
      const oneExpiringToggle = [
        ...Array.from({ length: JAVA_TORCH_FORCED_OFF_CHANGE_LIMIT - 1 }, () => 0),
        JAVA_TORCH_BURNOUT_WINDOW_REDSTONE_TICKS - 1,
      ]
      const burnoutCases: ReadonlyArray<Readonly<{
        inputLevel: number
        previous: TorchTimer
        expected: TorchTimer
      }>> = [
        {
          inputLevel: 1,
          previous: { burnedOut: false, output: true, recentOffTicks: recentToggles },
          expected: { burnedOut: true, output: false, recentOffTicks: [...recentToggles.map((age) => age + 1), 0] },
        },
        {
          inputLevel: 0,
          previous: { burnedOut: true, output: false, recentOffTicks: recentToggles },
          expected: { burnedOut: true, output: false, recentOffTicks: recentToggles.map((age) => age + 1) },
        },
        {
          inputLevel: 0,
          previous: { burnedOut: true, output: false, recentOffTicks: oneExpiringToggle },
          expected: {
            burnedOut: false,
            output: true,
            recentOffTicks: Array.from({ length: JAVA_TORCH_FORCED_OFF_CHANGE_LIMIT - 1 }, () => 1),
          },
        },
      ]
      for (const { expected, inputLevel, previous: torch } of burnoutCases) {
        const previous: TimedCircuitState = {
          ...emptyTimedCircuitState,
          power: new Map([['input', inputLevel], ['torch', torch.output ? 15 : 0]]),
          torches: new Map([['torch', torch]]),
        }
        const next = advanceTimedCircuit(board, previous)
        expect(next.torches?.get('torch'), `input=${inputLevel}, recent=${torch.recentOffTicks.length}`).toStrictEqual(expected)
        expect(powerAt(next.power, 'torch')).toBe(expected.output ? 15 : 0)
      }
    }),
  )

  it.effect('all default button input, press, and remaining-pulse states advance once', () =>
    Effect.sync(() => {
      // This catches a missed press, a retrigger while held, or an off-by-one pulse countdown.
      const adjacency = new Map([['button', []]])

      for (const active of BOOLEAN_STATES) {
        for (const priorInputActive of BOOLEAN_STATES) {
          for (let remainingTicks = 0; remainingTicks <= 10; remainingTicks += 1) {
            for (const externallyPressed of BOOLEAN_STATES) {
              const previous: TimedCircuitState = {
                ...emptyTimedCircuitState,
                buttons: new Map([['button', { inputActive: priorInputActive, remainingTicks }]]),
              }
              const currentBoard: CircuitBoard = {
                components: new Map([['button', { kind: 'button', active }]]),
                adjacency,
              }
              const next = advanceTimedCircuit(
                currentBoard,
                previous,
                externallyPressed ? new Set(['button']) : new Set(),
              )
              const risingEdge = active && !priorInputActive
              const availableTicks = risingEdge || externallyPressed ? 10 : remainingTicks
              const expectedActive = availableTicks > 0
              const expectedRemaining = Math.max(0, availableTicks - 1)
              const context =
                `active=${active}, priorInput=${priorInputActive}, remaining=${remainingTicks}, ` +
                `externalPress=${externallyPressed}`

              expect(next.buttons.get('button'), context).toStrictEqual({
                inputActive: active,
                remainingTicks: expectedRemaining,
              })
              expect(powerAt(next.power, 'button'), context).toBe(expectedActive ? 15 : 0)
            }
          }
        }
      }
    }),
  )

  it.effect('observer state pairs cover first sighting, equality, change, and removal', () =>
    Effect.sync(() => {
      // This catches a first-sighting pulse, a missed changed block, or stale memory after removal.
      const observations: ReadonlyArray<string | null> = [null, 'STONE', 'DIRT']
      const makeSightings = (block: string | null): Sightings =>
        block === null ? new Map() : new Map([['observer', block]])

      for (const previousBlock of observations) {
        for (const currentBlock of observations) {
          const sweep = observeChanges(makeSightings(currentBlock), makeSightings(previousBlock))
          const changed = previousBlock !== null && currentBlock !== null && previousBlock !== currentBlock
          const expectedSeen = currentBlock === null ? new Map() : new Map([['observer', currentBlock]])

          expect(sweep.fired, `previous=${previousBlock}, current=${currentBlock}`).toStrictEqual(
            changed ? ['observer'] : [],
          )
          expect(sweep.seen, `previous=${previousBlock}, current=${currentBlock}`).toStrictEqual(expectedSeen)
        }
      }
    }),
  )

  it.effect('all normal-piston facings and state/power pairs reach the requested state', () =>
    Effect.sync(() => {
      // This catches facing or boolean-state combinations that extend, retract, or no-op incorrectly.
      const piston = pistonPosition(0, 0, 0)
      for (const { facing } of PISTON_FACINGS) {
        for (const state of PISTON_STATES) {
          for (const powered of BOOLEAN_STATES) {
            const request: PistonTransitionRequest = { piston, facing, kind: 'normal', state, powered }
            const targetState: PistonState = powered ? 'extended' : 'retracted'
            const outcome = planPistonTransition(request, { read: () => ({ kind: 'empty' }) }, MOVABLE_PISTON_BLOCKS)

            if (state === targetState) {
              expect(outcome, `${facing}, state=${state}, powered=${powered}`).toStrictEqual({ kind: 'noop', state })
            } else {
              expect(outcome, `${facing}, state=${state}, powered=${powered}`).toStrictEqual({
                kind: 'move',
                plan: { piston, facing, kind: 'normal', fromState: state, toState: targetState, moves: [] },
              })
            }
          }
        }
      }
    }),
  )

  it.effect('all sticky-piston facings and pull-cell outcomes obey the finite transition rules', () =>
    Effect.sync(() => {
      // This catches sticky pistons pulling more than one block, pulling an immovable block, or losing a facing.
      const piston = pistonPosition(0, 0, 0)
      const immovableStone: BlockCapabilityLookup = {
        pistonImmovable: (block) => Result.succeed(block === 'STONE'),
      }

      for (const { facing, offset } of PISTON_FACINGS) {
        for (const state of PISTON_STATES) {
          for (const powered of BOOLEAN_STATES) {
            const request: PistonTransitionRequest = { piston, facing, kind: 'sticky', state, powered }
            const targetState: PistonState = powered ? 'extended' : 'retracted'
            const outcome = planPistonTransition(request, { read: () => ({ kind: 'empty' }) }, MOVABLE_PISTON_BLOCKS)

            if (state === targetState) {
              expect(outcome, `${facing}, state=${state}, powered=${powered}`).toStrictEqual({ kind: 'noop', state })
            } else {
              expect(outcome, `${facing}, state=${state}, powered=${powered}`).toStrictEqual({
                kind: 'move',
                plan: { piston, facing, kind: 'sticky', fromState: state, toState: targetState, moves: [] },
              })
            }
          }
        }

        const source = pistonPosition(offset.x * 2, offset.y * 2, offset.z * 2)
        const head = pistonPosition(offset.x, offset.y, offset.z)
        const retraction: PistonTransitionRequest = { piston, facing, kind: 'sticky', state: 'extended', powered: false }
        const movablePull = planPistonTransition(
          retraction,
          { read: (position) => position.x === source.x && position.y === source.y && position.z === source.z
            ? { kind: 'block', block: 'STONE' }
            : { kind: 'empty' } },
          MOVABLE_PISTON_BLOCKS,
        )
        const immovablePull = planPistonTransition(
          retraction,
          { read: (position) => position.x === source.x && position.y === source.y && position.z === source.z
            ? { kind: 'block', block: 'STONE' }
            : { kind: 'empty' } },
          immovableStone,
        )

        expect(movablePull, `movable pull, facing=${facing}`).toStrictEqual({
          kind: 'move',
          plan: {
            piston, facing, kind: 'sticky', fromState: 'extended', toState: 'retracted',
            moves: [{ block: 'STONE', from: source, to: head }],
          },
        })
        expect(immovablePull, `immovable pull, facing=${facing}`).toStrictEqual({
          kind: 'move',
          plan: { piston, facing, kind: 'sticky', fromState: 'extended', toState: 'retracted', moves: [] },
        })

        const unavailableKinds: ReadonlyArray<'missing' | 'out-of-world'> = ['missing', 'out-of-world']
        for (const unavailable of unavailableKinds) {
          const outcome = planPistonTransition(
            retraction,
            { read: (position) => position.x === source.x && position.y === source.y && position.z === source.z
              ? { kind: unavailable }
              : { kind: 'empty' } },
            MOVABLE_PISTON_BLOCKS,
          )
          expect(outcome, `unavailable=${unavailable}, facing=${facing}`).toStrictEqual({
            kind: 'refused',
            refusal: { reason: unavailable, position: source },
          })
        }
      }
    }),
  )

  it.effect('all hopper power and optional source/destination kind combinations enumerate rule-ordered slots', () =>
    Effect.sync(() => {
      // This catches omitted container kinds, slot pairs, directions, or powered-lock handling.
      const hopperCapacity = CONTAINER_CAPACITIES.hopper
      for (const powered of BOOLEAN_STATES) {
        for (const sourceChoice of hopperCellChoices) {
          for (const destinationChoice of hopperDestinationChoices) {
            const sourceAbove = sourceChoice.kind === 'none'
              ? null
              : { address: sourceChoice.address, kind: sourceChoice.containerKind }
            const destinationFacing = destinationChoice.kind === 'none'
              ? null
              : { address: destinationChoice.address, kind: destinationChoice.containerKind }
            const expectedCandidates: Array<unknown> = []

            if (destinationChoice.kind === 'container') {
              for (let sourceSlot = 0; sourceSlot < hopperCapacity; sourceSlot += 1) {
                for (
                  let destinationSlot = 0;
                  destinationSlot < CONTAINER_CAPACITIES[destinationChoice.containerKind];
                  destinationSlot += 1
                ) {
                  expectedCandidates.push({
                    direction: 'push',
                    source: { _tag: 'Container', address: hopperAddress, slot: sourceSlot },
                    destination: { _tag: 'Container', address: destinationChoice.address, slot: destinationSlot },
                  })
                }
              }
            }

            if (sourceChoice.kind === 'container') {
              for (let sourceSlot = 0; sourceSlot < CONTAINER_CAPACITIES[sourceChoice.containerKind]; sourceSlot += 1) {
                for (let destinationSlot = 0; destinationSlot < hopperCapacity; destinationSlot += 1) {
                  expectedCandidates.push({
                    direction: 'pull',
                    source: { _tag: 'Container', address: sourceChoice.address, slot: sourceSlot },
                    destination: { _tag: 'Container', address: hopperAddress, slot: destinationSlot },
                  })
                }
              }
            }

            const outcome = selectHopperTransferCandidates({
              powered,
              hopperAddress,
              sourceAbove,
              destinationFacing,
            })
            const context =
              `powered=${powered}, source=${sourceChoice.kind === 'container' ? sourceChoice.containerKind : 'none'}, ` +
              `destination=${destinationChoice.kind === 'container' ? destinationChoice.containerKind : 'none'}`

            if (powered) {
              expect(outcome, context).toStrictEqual({ _tag: 'Locked' })
            } else if (expectedCandidates.length === 0) {
              expect(outcome, context).toStrictEqual({ _tag: 'NoCandidates' })
            } else {
              expect(outcome, context).toStrictEqual({ _tag: 'Candidates', candidates: expectedCandidates })
            }
          }
        }
      }
    }),
  )

  it.effect('all comparator rear, side, and mode combinations follow the two vanilla rules', () =>
    Effect.sync(() => {
      // This fails if compare mishandles equality or subtract crosses either zero or the rear level.
      for (const rear of SIGNAL_LEVELS) {
        for (const side of SIGNAL_LEVELS) {
          for (const mode of COMPARATOR_MODES) {
            const expected =
              mode === 'compare'
                ? side > rear
                  ? 0
                  : rear
                : rear > side
                  ? rear - side
                  : 0

            expect(comparatorOutput(rear, [side], mode), `rear=${rear}, side=${side}, mode=${mode}`).toBe(expected)
          }
        }
      }
    }),
  )

  it.effect('all repeater delays and rear/flank power combinations obey delay and lock rules', () =>
    Effect.sync(() => {
      // This fails if a powered flank fails to hold the output or an input changes it before its selected delay.
      for (const delayTicks of [1, 2, 3, 4]) {
        for (const rearPower of SIGNAL_LEVELS) {
          for (const leftPower of [0, 1]) {
            for (const rightPower of [0, 1]) {
              for (const previousOutput of [false, true]) {
                const components = new Map<string, Component>([
                  ['rear', { kind: 'lever', active: rearPower > 0, emits: rearPower }],
                  ['left', { kind: 'lever', active: leftPower > 0, emits: leftPower }],
                  ['right', { kind: 'lever', active: rightPower > 0, emits: rightPower }],
                  [
                    'repeater',
                    { kind: 'repeater', inputFrom: 'rear', sideInputs: ['left', 'right'], delayTicks },
                  ],
                ])
                const board: CircuitBoard = {
                  components,
                  adjacency: new Map([
                    ['rear', []],
                    ['left', []],
                    ['right', []],
                    ['repeater', []],
                  ]),
                }
                let state: TimedCircuitState = {
                  ...emptyTimedCircuitState,
                  power: new Map([
                    ['rear', rearPower],
                    ['left', leftPower],
                    ['right', rightPower],
                    ['repeater', previousOutput ? 15 : 0],
                  ]),
                  repeaters: new Map([
                    ['repeater', { output: previousOutput, remainingTicks: 0 }],
                  ]),
                }
                const requestedOutput = rearPower > 0
                const flankIsPowered = leftPower > 0 || rightPower > 0

                state = advanceTimedCircuit(board, state)
                const expectedOutput =
                  flankIsPowered || requestedOutput === previousOutput || delayTicks > 1
                    ? previousOutput
                    : requestedOutput
                const context =
                  `delay=${delayTicks}, rear=${rearPower}, left=${leftPower}, right=${rightPower}, ` +
                  `previousOutput=${previousOutput}, elapsed=1`

                expect(powerAt(state.power, 'repeater'), context).toBe(expectedOutput ? 15 : 0)
              }
            }
          }
        }
      }
    }),
  )

  it.effect('pressure plates report the values immediately around each kind threshold or capacity', () =>
    Effect.sync(() => {
      const cases: ReadonlyArray<{
        readonly name: string
        readonly occupants: number
        readonly weighing: PlateWeighing
        readonly expected: number
      }> = [
        { name: 'binary threshold=1 occupants=0', occupants: 0, weighing: { kind: 'binary' }, expected: 0 },
        { name: 'binary threshold=1 occupants=1', occupants: 1, weighing: { kind: 'binary' }, expected: 15 },
        {
          name: 'light capacity=15 occupants=14',
          occupants: 14,
          weighing: { kind: 'weighted', capacity: 15 },
          expected: 14,
        },
        {
          name: 'light capacity=15 occupants=15',
          occupants: 15,
          weighing: { kind: 'weighted', capacity: 15 },
          expected: 15,
        },
        {
          name: 'light capacity=15 occupants=16',
          occupants: 16,
          weighing: { kind: 'weighted', capacity: 15 },
          expected: 15,
        },
        {
          name: 'heavy capacity=150 occupants=149',
          occupants: 149,
          weighing: { kind: 'weighted', capacity: 150 },
          expected: 15,
        },
        {
          name: 'heavy capacity=150 occupants=150',
          occupants: 150,
          weighing: { kind: 'weighted', capacity: 150 },
          expected: 15,
        },
        {
          name: 'heavy capacity=150 occupants=151',
          occupants: 151,
          weighing: { kind: 'weighted', capacity: 150 },
          expected: 15,
        },
      ]

      // This fails if an empty plate powers or a kind's activation/capacity boundary shifts.
      for (const { name, occupants, weighing, expected } of cases) {
        expect(plateSignal(occupants, weighing), name).toBe(expected)
      }
    }),
  )
})
