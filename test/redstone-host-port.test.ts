/**
 * Coverage for the host boundary moved here from mc-compose (§5.3 W1-L4').
 *
 * Two suites go beyond fixture-based unit coverage, per this task's
 * verification-depth directive:
 *
 *   - `describe('invariant: ...')` — enumerates every block string this
 *     repository classifies plus a set of unknown ones, at distinct
 *     positions, and checks a structural invariant holds for the whole
 *     enumeration rather than for one fixture.
 *   - `describe('determinism / replay')` — runs the same block snapshot and
 *     the same tick sequence through two independently constructed runtimes
 *     and asserts the two host-port call recordings are identical, the same
 *     guarantee docs/testing.md §5 states for the power graph itself, now
 *     checked across this file's own seam (snapshot-from-host through
 *     drain-to-host).
 */
import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { DeltaTimeSecs, type StageRegistration } from '@nerima-games/mc-kernel'
import {
  applyRedstoneHostEvents,
  componentForBlock,
  kernelPistonCapabilities,
  redstoneSnapshotFromRealm,
  type RedstoneHostBlock,
  type RedstoneHostLookup,
  type RedstoneHostRealm,
  type RedstoneHostWritePort,
} from '../src/application/redstone-host-port'
import {
  RedstoneWorldRuntime,
  RedstoneWorldRuntimeLayer,
  type RedstoneComponentSnapshot,
} from '../src/application/world-runtime'
import { makeRuntimeRedstoneStages } from '../src/stages/registration'
import { REDSTONE_STAGE_IDS } from '../src/stages/stage-ids'
// eslint-disable-next-line sort-imports
import { FrameServicesLayer } from './frame-services'

const ORIGIN_X = 0
const ORIGIN_Y = 0
const ORIGIN_Z = 0
const TICKS_TO_SETTLE_A_HOPPER = 4

const missingLookup: RedstoneHostLookup = {
  isLeverActive: () => false,
  isPoweredRailPowered: () => false,
  readContainerSlots: () => undefined,
  readPistonCell: () => ({ kind: 'missing' }),
}

const noopPort: RedstoneHostWritePort = {
  applyDispenserTrigger: () => undefined,
  applyDoorTransition: () => undefined,
  applyDropperTrigger: () => undefined,
  applyHopperTransfer: () => undefined,
  applyLampTransition: () => undefined,
  applyPoweredRailTransition: () => undefined,
  commitPistonPlan: () => undefined,
}

const block = (name: string | null): RedstoneHostBlock => ({
  block: name,
  position: { x: ORIGIN_X, y: ORIGIN_Y, z: ORIGIN_Z },
})

describe('componentForBlock', () => {
  const cases: ReadonlyArray<{
    readonly block: string
    readonly kind: RedstoneComponentSnapshot['kind']
  }> = [
    { block: 'hopper', kind: 'hopper' },
    { block: 'dispenser', kind: 'dispenser' },
    { block: 'dropper', kind: 'dropper' },
    { block: 'redstone_torch', kind: 'torch' },
    { block: 'redstone_wire', kind: 'wire' },
    { block: 'redstone_lamp', kind: 'lamp' },
    { block: 'redstone_lamp_lit', kind: 'lamp' },
    { block: 'door', kind: 'door' },
    { block: 'door_open', kind: 'door' },
  ]

  for (const testCase of cases) {
    it.effect(`classifies '${testCase.block}' as kind '${testCase.kind}'`, () =>
      Effect.sync(() => {
        const position = { x: ORIGIN_X, y: ORIGIN_Y, z: ORIGIN_Z }
        expect(componentForBlock(missingLookup, testCase.block, position)).toMatchObject({
          kind: testCase.kind,
          position,
        })
      }),
    )
  }

  it.effect('REGRESSION: an unrecognised block classifies to no component, not a guess', () =>
    Effect.sync(() => {
      expect(componentForBlock(missingLookup, 'unrecognised_block_xyz', { x: 0, y: 0, z: 0 })).toBeUndefined()
      expect(componentForBlock(missingLookup, null, { x: 0, y: 0, z: 0 })).toBeUndefined()
    }),
  )

  it.effect('a powered rail asks the host lookup, not a fixed default', () =>
    Effect.sync(() => {
      const poweredLookup: RedstoneHostLookup = { ...missingLookup, isPoweredRailPowered: () => true }
      expect(componentForBlock(poweredLookup, 'powered_rail', { x: 0, y: 0, z: 0 })).toMatchObject({
        kind: 'powered-rail',
        powered: true,
      })
      expect(componentForBlock(missingLookup, 'powered_rail', { x: 0, y: 0, z: 0 })).toMatchObject({
        kind: 'powered-rail',
        powered: false,
      })
    }),
  )

  it.effect('a lever asks the host lookup, not a fixed default', () =>
    Effect.sync(() => {
      const activeLookup: RedstoneHostLookup = { ...missingLookup, isLeverActive: () => true }
      expect(componentForBlock(activeLookup, 'lever', { x: 0, y: 0, z: 0 })).toMatchObject({
        active: true,
        kind: 'lever',
      })
      expect(componentForBlock(missingLookup, 'lever', { x: 0, y: 0, z: 0 })).toMatchObject({
        active: false,
        kind: 'lever',
      })
    }),
  )

  it.effect(
    'a comparator reads its rear cell for container slots and derives inputFrom/outputTo/sideInputs',
    () =>
      Effect.sync(() => {
        const position = { x: 2, y: 0, z: 0 }
        const withSlots: RedstoneHostLookup = {
          ...missingLookup,
          readContainerSlots: (readAt) => {
            expect(readAt).toStrictEqual({ x: 2, y: 0, z: 1 })
            return [{ count: 32, maxStack: 64 }]
          },
        }
        expect(componentForBlock(withSlots, 'comparator', position)).toStrictEqual({
          containerSlots: [{ count: 32, maxStack: 64 }],
          inputFrom: { x: 2, y: 0, z: 1 },
          kind: 'comparator',
          mode: 'compare',
          outputTo: { x: 2, y: 0, z: -1 },
          position,
          sideInputs: [
            { x: 1, y: 0, z: 0 },
            { x: 3, y: 0, z: 0 },
          ],
        })
      }),
  )

  it.effect('a comparator omits containerSlots entirely when the host has no reading, rather than an empty array', () =>
    Effect.sync(() => {
      const component = componentForBlock(missingLookup, 'comparator', { x: 0, y: 0, z: 0 })
      expect(component).toBeDefined()
      expect(Object.keys(component ?? {})).not.toContain('containerSlots')
    }),
  )

  it.effect('a piston reads its head cell: extended when it holds piston_head, retracted otherwise', () =>
    Effect.sync(() => {
      const extended: RedstoneHostLookup = {
        ...missingLookup,
        readPistonCell: () => ({ block: 'piston_head', kind: 'block' }),
      }
      const retractedBlock: RedstoneHostLookup = {
        ...missingLookup,
        readPistonCell: () => ({ block: 'stone', kind: 'block' }),
      }
      const retractedEmpty: RedstoneHostLookup = {
        ...missingLookup,
        readPistonCell: () => ({ kind: 'empty' }),
      }

      expect(componentForBlock(extended, 'piston', { x: 0, y: 0, z: 0 })).toMatchObject({
        pistonFacing: 'north',
        pistonKind: 'sticky',
        pistonState: 'extended',
      })
      expect(componentForBlock(retractedBlock, 'piston', { x: 0, y: 0, z: 0 })).toMatchObject({
        pistonState: 'retracted',
      })
      expect(componentForBlock(retractedEmpty, 'piston', { x: 0, y: 0, z: 0 })).toMatchObject({
        pistonState: 'retracted',
      })
      expect(componentForBlock(missingLookup, 'piston', { x: 0, y: 0, z: 0 })).toMatchObject({
        pistonState: 'retracted',
      })
    }),
  )
})

describe('kernelPistonCapabilities', () => {
  it.effect('reads mc-kernel’s own pistonImmovable capability rather than a local roster', () =>
    Effect.sync(() => {
      // bedrock/dirt are asserted against mc-kernel's PUBLISHED capability
      // table, not invented here (DN-RS-1) — see docs/responsibility.md §2.
      expect(kernelPistonCapabilities.pistonImmovable('bedrock')).toBe(true)
      expect(kernelPistonCapabilities.pistonImmovable('dirt')).toBe(false)
    }),
  )

  it.effect('REGRESSION: a string mc-kernel does not recognise as a block type is never immovable', () =>
    Effect.sync(() => {
      expect(kernelPistonCapabilities.pistonImmovable('not_a_real_block_xyz')).toBe(false)
    }),
  )
})

describe('redstoneSnapshotFromRealm', () => {
  const realm: RedstoneHostRealm = { dimension: 'overworld', lookup: missingLookup, port: noopPort }

  it.effect('carries the realm’s dimension and skips every block with no component', () =>
    Effect.sync(() => {
      const snapshot = redstoneSnapshotFromRealm(realm, [
        block('hopper'),
        block('unrecognised_block_xyz'),
        block(null),
        block('redstone_wire'),
      ])
      expect(snapshot.dimension).toBe('overworld')
      expect(snapshot.components.map((component) => component.kind)).toStrictEqual(['hopper', 'wire'])
    }),
  )

  it.effect('an empty block list produces an empty, not missing, component list', () =>
    Effect.sync(() => {
      expect(redstoneSnapshotFromRealm(realm, [])).toStrictEqual({ components: [], dimension: 'overworld' })
    }),
  )
})

describe('invariant: never more components than blocks offered, over the whole known/unknown enumeration', () => {
  const KNOWN_BLOCKS = [
    'hopper',
    'dispenser',
    'dropper',
    'redstone_torch',
    'redstone_wire',
    'powered_rail',
    'lever',
    'comparator',
    'redstone_lamp',
    'redstone_lamp_lit',
    'door',
    'door_open',
    'piston',
  ]
  const UNKNOWN_BLOCKS: ReadonlyArray<string | null> = ['stone', 'dirt', 'air', 'chest', null]
  const ALL_BLOCKS: ReadonlyArray<string | null> = [...KNOWN_BLOCKS, ...UNKNOWN_BLOCKS]

  it.effect(
    'REGRESSION: every known block yields exactly one component at its own position, every unknown block yields none',
    () =>
      Effect.sync(() => {
        // Enumerated rather than sampled from one fixture: every block string
        // this repository recognises, crossed with a handful it does not,
        // each at a DISTINCT position so a leaked or duplicated position
        // would be visible.
        const positioned: ReadonlyArray<RedstoneHostBlock> = ALL_BLOCKS.map((name, index) => ({
          block: name,
          position: { x: index, y: 0, z: 0 },
        }))
        const realm: RedstoneHostRealm = { dimension: 'overworld', lookup: missingLookup, port: noopPort }

        const snapshot = redstoneSnapshotFromRealm(realm, positioned)

        // Invariant 1: never more components than blocks offered.
        expect(snapshot.components.length).toBeLessThanOrEqual(positioned.length)
        // Invariant 2: exactly the known ones — none dropped, none invented.
        expect(snapshot.components.length).toBe(KNOWN_BLOCKS.length)
        // Invariant 3: every emitted component's position traces back to a
        // KNOWN block at that exact x — no cross-contamination between
        // enumerated entries.
        for (const component of snapshot.components) {
          const source = positioned.find((candidate) => candidate.position.x === component.position.x)
          expect(source).toBeDefined()
          expect(KNOWN_BLOCKS).toContain(source?.block)
        }
      }),
  )
})

const runFrame = (stages: ReadonlyArray<StageRegistration>): Effect.Effect<void> =>
  Effect.gen(function* runFrameGenerator() {
    const power = stages.find((stage) => stage.id === REDSTONE_STAGE_IDS.power)
    const effects = stages.find((stage) => stage.id === REDSTONE_STAGE_IDS.effects)
    if (typeof power !== 'undefined') {
      yield* power.run(DeltaTimeSecs(0.1)).pipe(Effect.provide(FrameServicesLayer))
    }
    if (typeof effects !== 'undefined') {
      yield* effects.run(DeltaTimeSecs(0.1)).pipe(Effect.provide(FrameServicesLayer))
    }
  })

type RecordedCall =
  | { readonly kind: 'hopper'; readonly position: RedstoneHostBlock['position'] }
  | { readonly kind: 'dispenser'; readonly position: RedstoneHostBlock['position'] }
  | { readonly kind: 'dropper'; readonly position: RedstoneHostBlock['position'] }
  | { readonly kind: 'lamp'; readonly lit: boolean; readonly position: RedstoneHostBlock['position'] }
  | { readonly kind: 'door'; readonly open: boolean; readonly position: RedstoneHostBlock['position'] }
  | { readonly kind: 'powered-rail'; readonly position: RedstoneHostBlock['position']; readonly powered: boolean }
  | { readonly kind: 'commit-piston'; readonly piston: RedstoneHostBlock['position'] }

const recordingRealm = (
  dimension: string,
  lookup: RedstoneHostLookup,
): { readonly calls: Array<RecordedCall>; readonly realm: RedstoneHostRealm } => {
  const calls: Array<RecordedCall> = []
  const port: RedstoneHostWritePort = {
    applyDispenserTrigger: (position) => calls.push({ kind: 'dispenser', position }),
    applyDoorTransition: (position, open) => calls.push({ kind: 'door', open, position }),
    applyDropperTrigger: (position) => calls.push({ kind: 'dropper', position }),
    applyHopperTransfer: (position) => calls.push({ kind: 'hopper', position }),
    applyLampTransition: (position, lit) => calls.push({ kind: 'lamp', lit, position }),
    applyPoweredRailTransition: (position, powered) => calls.push({ kind: 'powered-rail', position, powered }),
    commitPistonPlan: (plan) => calls.push({ kind: 'commit-piston', piston: plan.piston }),
  }
  return { calls, realm: { dimension, lookup, port } }
}

/**
 * A board exercising every drained event kind at once. Every actuator sits
 * directly adjacent to the lever — one per face — the same pattern
 * `test/world-runtime.test.ts` uses for a single piston, so each gets power
 * without routing through another actuator (actuators do not conduct). The
 * hopper is placed far away, disconnected: its transfer is driven by being
 * UNPOWERED, not by adjacency.
 */
const mixedComponentsSnapshot: ReadonlyArray<RedstoneComponentSnapshot> = [
  { active: true, kind: 'lever', position: { x: 0, y: 0, z: 0 } },
  { kind: 'wire', position: { x: 1, y: 0, z: 0 } },
  { kind: 'lamp', position: { x: 2, y: 0, z: 0 } },
  { kind: 'dispenser', position: { x: -1, y: 0, z: 0 } },
  { kind: 'dropper', position: { x: 0, y: 1, z: 0 } },
  { kind: 'door', position: { x: 0, y: -1, z: 0 } },
  { kind: 'powered-rail', position: { x: 0, y: 0, z: 1 } },
  {
    kind: 'piston',
    pistonFacing: 'south',
    pistonKind: 'normal',
    pistonState: 'retracted',
    position: { x: 0, y: 0, z: -1 },
  },
  { kind: 'hopper', position: { x: 10, y: 10, z: 10 } },
]

/** Every scan cell reads as empty, so any piston extension plans a bare push into free space. */
const alwaysEmptyPistonLookup: RedstoneHostLookup = {
  ...missingLookup,
  readPistonCell: () => ({ kind: 'empty' }),
}

describe('applyRedstoneHostEvents', () => {
  it.effect('applies lamp, trigger, powered-component, hopper and piston drains through the matching realm', () =>
    Effect.gen(function* () {
      const runtime = yield* RedstoneWorldRuntime
      const stages = yield* makeRuntimeRedstoneStages
      const { calls, realm } = recordingRealm('overworld', alwaysEmptyPistonLookup)

      yield* runtime.syncSnapshot({ components: mixedComponentsSnapshot, dimension: 'overworld' })

      for (let tick = 0; tick < TICKS_TO_SETTLE_A_HOPPER; tick += 1) {
        yield* runFrame(stages)
      }
      yield* applyRedstoneHostEvents(runtime, [realm])

      expect(calls).toContainEqual({ kind: 'lamp', lit: true, position: { x: 2, y: 0, z: 0 } })
      expect(calls).toContainEqual({ kind: 'dispenser', position: { x: -1, y: 0, z: 0 } })
      expect(calls).toContainEqual({ kind: 'dropper', position: { x: 0, y: 1, z: 0 } })
      expect(calls).toContainEqual({ kind: 'hopper', position: { x: 10, y: 10, z: 10 } })
      expect(calls).toContainEqual({ kind: 'door', open: true, position: { x: 0, y: -1, z: 0 } })
      expect(calls).toContainEqual({ kind: 'powered-rail', position: { x: 0, y: 0, z: 1 }, powered: true })
      expect(calls).toContainEqual({ kind: 'commit-piston', piston: { x: 0, y: 0, z: -1 } })
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )

  it.effect('REGRESSION: an event for a dimension with no matching realm is dropped, not thrown', () =>
    Effect.gen(function* () {
      const runtime = yield* RedstoneWorldRuntime
      const stages = yield* makeRuntimeRedstoneStages
      const { calls, realm } = recordingRealm('nether', missingLookup)

      yield* runtime.syncSnapshot({ components: mixedComponentsSnapshot, dimension: 'overworld' })
      for (let tick = 0; tick < TICKS_TO_SETTLE_A_HOPPER; tick += 1) {
        yield* runFrame(stages)
      }

      yield* applyRedstoneHostEvents(runtime, [realm])
      expect(calls).toStrictEqual([])
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )

  it.effect(
    "REGRESSION: a 'note-block' trigger and a 'trapdoor' transition are drained but produce no host call",
    () =>
      Effect.gen(function* () {
        const runtime = yield* RedstoneWorldRuntime
        const stages = yield* makeRuntimeRedstoneStages
        const { calls, realm } = recordingRealm('overworld', missingLookup)

        // These two component kinds have no `componentForBlock` case that
        // ever produces them (see the file header on redstone-host-port.ts);
        // building the snapshot by hand is the only way to drive the drain
        // queues into the state this regression is about.
        yield* runtime.syncSnapshot({
          components: [
            { active: true, kind: 'lever', position: { x: 0, y: 0, z: 0 } },
            { kind: 'note-block', position: { x: 0, y: 1, z: 0 } },
            { kind: 'trapdoor', position: { x: 0, y: -1, z: 0 } },
          ],
          dimension: 'overworld',
        })
        yield* runFrame(stages)
        yield* applyRedstoneHostEvents(runtime, [realm])

        expect(calls).toStrictEqual([])

        // And draining again produces nothing further — the events were
        // consumed, not left stuck behind the unhandled kinds.
        yield* applyRedstoneHostEvents(runtime, [realm])
        expect(calls).toStrictEqual([])
      }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )

  it.effect('REGRESSION: a piston transition planPistonTransition refuses is never committed', () =>
    Effect.gen(function* () {
      const runtime = yield* RedstoneWorldRuntime
      const stages = yield* makeRuntimeRedstoneStages
      // `readPistonCell` reports every cell missing, which makes
      // `planPistonTransition`'s extension scan refuse immediately (`outcome.kind`
      // is `'refused'`, never `'move'`) — `commitPistonPlan` must never fire.
      const { calls, realm } = recordingRealm('overworld', missingLookup)

      yield* runtime.syncSnapshot({
        components: [
          { active: true, kind: 'lever', position: { x: 0, y: 0, z: 0 } },
          {
            kind: 'piston',
            pistonFacing: 'east',
            pistonKind: 'normal',
            pistonState: 'retracted',
            position: { x: 1, y: 0, z: 0 },
          },
        ],
        dimension: 'overworld',
      })
      yield* runFrame(stages)
      yield* applyRedstoneHostEvents(runtime, [realm])

      expect(calls.filter((call) => call.kind === 'commit-piston')).toStrictEqual([])
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )
})

describe('determinism / replay', () => {
  it.effect(
    'REGRESSION: the same block snapshot and the same tick sequence, replayed through two independent runtimes, recorded the identical host-call sequence',
    () =>
      Effect.gen(function* () {
        const replay = () =>
          Effect.gen(function* replayGenerator() {
            const runtime = yield* RedstoneWorldRuntime
            const stages = yield* makeRuntimeRedstoneStages
            const { calls, realm } = recordingRealm('overworld', missingLookup)

            const snapshot = redstoneSnapshotFromRealm(realm, [
              { block: 'lever', position: { x: 0, y: 0, z: 0 } },
              { block: 'redstone_wire', position: { x: 1, y: 0, z: 0 } },
              { block: 'redstone_lamp', position: { x: 2, y: 0, z: 0 } },
              { block: 'hopper', position: { x: 0, y: 1, z: 0 } },
            ])
            // A lever's `active` state has to come from the host lookup, not
            // from `componentForBlock`'s classification alone, so patch it in
            // exactly as a real host's `isLeverActive` would answer.
            const withLever = {
              ...snapshot,
              components: snapshot.components.map((component) =>
                component.kind === 'lever' ? { ...component, active: true } : component,
              ),
            }
            yield* runtime.syncSnapshot(withLever)

            for (let tick = 0; tick < TICKS_TO_SETTLE_A_HOPPER + 1; tick += 1) {
              yield* runFrame(stages)
              yield* applyRedstoneHostEvents(runtime, [realm])
            }
            return calls
          }).pipe(Effect.provide(RedstoneWorldRuntimeLayer))

        const first = yield* replay()
        const second = yield* replay()

        expect(first.length).toBeGreaterThan(0)
        expect(second).toStrictEqual(first)
      }),
  )
})
