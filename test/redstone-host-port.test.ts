/**
 * Coverage for the host boundary moved here from mc-compose.
 *
 * The invariant suite enumerates each component block and representative
 * kernel block names with no redstone component at distinct positions. The
 * replay suite runs the same snapshot and tick sequence through independent
 * runtimes, then compares the recorded host requests at the snapshot-to-commit
 * seam.
 */
import { describe, expect, it } from '@effect/vitest'
import { Deferred, Effect, Fiber, Option, Result, Schema, Stream } from 'effect'
import {
  BlockAddressSchema,
  blockIdOf,
  BlockPositionSchema,
  DeltaTimeSecs,
  DimensionIdSchema,
  DimensionRevisionSchema,
  DomainEventSchema,
  SimulationTickSchema,
  WorldIdSchema,
  WorldRevisionSchema,
  WorldWriteBatchSchema,
  type BlockAddress,
  type BlockPosition,
  type StageRegistration,
} from '@nerima-games/mc-kernel'
import {
  CONTAINER_STORAGE_SNAPSHOT_VERSION,
  HOPPER_REPLICATED_OWNER_ID,
  ReplicatedOwnerIdSchema,
  WorldCommitEmptyRequest,
  type HopperCooldownPlanRequest,
  type HopperServiceSnapshot,
  type HopperTransferOutcome,
  type HopperTransferTickPlanState,
  type DomainEvent,
  type DomainEventBusApi,
  type WorldCommitPlanFragment,
  type WorldCommitPlanSnapshot,
  type WorldCommitRequest,
} from '@nerima-games/mc-sim'
import {
  applyRedstoneHostEvents,
  componentForBlock,
  kernelPistonCapabilities,
  redstoneSnapshotFromRealm,
  RedstoneHostBlockTypeSchema,
  type RedstoneHostBlock,
  type RedstoneHostBlockType,
  type RedstoneHostLookup,
  type RedstoneHostRealm,
  type RedstoneHostWritePort,
} from '../src/application/redstone-host-port'
import {
  RedstoneEventBatchSchema,
  RedstoneWorldRuntime,
  RedstoneWorldRuntimeLayer,
  type HopperTransferEvent,
  type RedstoneComponentSnapshot,
  type RedstoneEventBatch,
} from '../src/application/world-runtime'
import { makeRuntimeRedstoneStages } from '../src/stages/registration'
import { REDSTONE_STAGE_IDS } from '../src/stages/stage-ids'
// eslint-disable-next-line sort-imports
import { FrameServicesLayer } from './frame-services'
import { PISTON_PUSH_LIMIT, type PistonMovementPlan } from '../src/domain/piston'
import { ContainerSlotSchema } from '../src/domain/comparator'

type RedstoneDimensionId = BlockAddress['dimension']

const testWorldId = Schema.decodeUnknownSync(WorldIdSchema)('redstone-host-test-world')
const HOPPER_BLOCK_ID = Option.getOrThrow(blockIdOf('hopper'))
const STONE_BLOCK_ID = Option.getOrThrow(blockIdOf('stone'))

const dimensionId = (value: string): RedstoneDimensionId =>
  Schema.decodeUnknownSync(DimensionIdSchema)(value)

const blockPosition = (x: number, y = 0, z = 0): BlockPosition =>
  Schema.decodeUnknownSync(BlockPositionSchema)({ x, y, z })

const hopperTransferEvent = (
  dimension: RedstoneDimensionId,
  position: BlockPosition,
  elapsedRedstoneTicks = 4,
  powered = false,
): HopperTransferEvent => {
  const [event] = Schema.decodeUnknownSync(RedstoneEventBatchSchema)({
    hopper: [{ dimension, position, elapsedRedstoneTicks, powered }],
    lamp: [],
    piston: [],
    powered: [],
    trigger: [],
  }).hopper
  if (event === undefined) {
    throw new Error('Expected a decoded hopper transfer event')
  }
  return event
}

const blockAddress = (dimension: string, x: number, y = 0, z = 0): BlockAddress =>
  Schema.decodeUnknownSync(BlockAddressSchema)({ dimension, position: { x, y, z } })

const successValue = <Value, Failure>(result: Result.Result<Value, Failure>): Value => {
  if (Result.isFailure(result)) {
    throw new Error('Expected a successful Result')
  }
  return result.success
}

const componentValue = (
  lookup: RedstoneHostLookup,
  name: RedstoneHostBlockType | null,
  position: BlockPosition,
) => successValue(componentForBlock(lookup, name, position))

const snapshotValue = (realm: RedstoneHostRealm, blocks: ReadonlyArray<RedstoneHostBlock>) =>
  successValue(redstoneSnapshotFromRealm(realm, blocks))

const emptyEvents = (overrides: Partial<RedstoneEventBatch> = {}): RedstoneEventBatch => ({
  hopper: [],
  lamp: [],
  piston: [],
  powered: [],
  trigger: [],
  ...overrides,
})

const missingLookup: RedstoneHostLookup = {
  isLeverActive: () => false,
  isPoweredRailPowered: () => false,
  readHopperBlockId: () => HOPPER_BLOCK_ID,
  readHopperTransferContext: () => ({ powered: false, sourceAbove: null, destinationFacing: null }),
  readContainerSlots: () => undefined,
  readPistonCell: () => ({ kind: 'missing' }),
  readPistonFacing: () => 'north',
}

const block = (name: RedstoneHostBlockType | null, x = 0, y = 0, z = 0): RedstoneHostBlock => ({
  address: blockAddress('overworld', x, y, z),
  block: name,
})

type RecordedCall =
  | {
      readonly kind: 'build'
      readonly events: RedstoneEventBatch
      readonly pistonPlans: ReadonlyArray<PistonMovementPlan>
    }
  | { readonly kind: 'commit'; readonly request: WorldCommitRequest }
  | { readonly kind: 'publish'; readonly event: DomainEvent }
  | {
      readonly kind: 'hopper-cooldown-plan'
      readonly snapshot: WorldCommitPlanSnapshot<HopperServiceSnapshot>
      readonly request: HopperCooldownPlanRequest
    }
  | {
      readonly kind: 'hopper-plan'
      readonly snapshot: WorldCommitPlanSnapshot<HopperTransferTickPlanState>
      readonly elapsedTicks: number
      readonly powered: boolean
    }

const buildCallsOf = (calls: ReadonlyArray<RecordedCall>) =>
  calls.filter((call): call is Extract<RecordedCall, { readonly kind: 'build' }> => call.kind === 'build')

const commitCallsOf = (calls: ReadonlyArray<RecordedCall>) =>
  calls.filter((call): call is Extract<RecordedCall, { readonly kind: 'commit' }> => call.kind === 'commit')

const hopperCooldownPlanCallsOf = (calls: ReadonlyArray<RecordedCall>) =>
  calls.filter((call): call is Extract<RecordedCall, { readonly kind: 'hopper-cooldown-plan' }> => call.kind === 'hopper-cooldown-plan')

const hopperPlanCallsOf = (calls: ReadonlyArray<RecordedCall>) =>
  calls.filter((call): call is Extract<RecordedCall, { readonly kind: 'hopper-plan' }> => call.kind === 'hopper-plan')

const eventCount = (events: RedstoneEventBatch): number =>
  events.hopper.length + events.lamp.length + events.piston.length + events.powered.length + events.trigger.length

const blockChangedByWorldEvent: DomainEvent = {
  _tag: 'BlockChangedByWorld',
  address: blockAddress('overworld', 20, 0, 0),
  cause: 'fire',
  tick: Schema.decodeUnknownSync(SimulationTickSchema)(1),
}

const postCommitEventPort = (
  port: RedstoneHostWritePort,
  event: DomainEvent,
  eventBus?: DomainEventBusApi,
  includeOwnerChange = true,
): RedstoneHostWritePort => {
  const { planAdvanceCooldown } = port.hopperService
  return {
    ...port,
    ...(eventBus === undefined ? {} : { eventBus }),
    hopperService: {
      ...port.hopperService,
      planAdvanceCooldown: (snapshot, request) =>
        planAdvanceCooldown(snapshot, request).pipe(Effect.map((fragment) => ({
          ...fragment,
          changes: includeOwnerChange ? [{ ownerId: HOPPER_REPLICATED_OWNER_ID, state: snapshot.state }] : [],
          postCommitEvents: [event],
        }))),
    },
  }
}

const recordingRealm = (
  dimension: RedstoneDimensionId,
  lookup: RedstoneHostLookup,
): {
  readonly calls: Array<RecordedCall>
  readonly realm: RedstoneHostRealm
  readonly port: RedstoneHostWritePort
} => {
  const calls: Array<RecordedCall> = []
  const revisionBatch = Schema.decodeUnknownSync(WorldWriteBatchSchema)({
    world: testWorldId,
    expectedWorldRevision: 5,
    dimension: String(dimension),
    expectedDimensionRevision: 2,
    edits: [{ position: { x: 100, y: 0, z: 0 }, block: 1 }],
  })
  const transferRejected: HopperTransferOutcome = {
    _tag: 'TransferRejected',
    transfer: { _tag: 'ContainerMove', outcome: { _tag: 'EmptySource' } },
  }
  const port: RedstoneHostWritePort = {
    buildCommitRequest: (events, pistonPlans) => {
      calls.push({ kind: 'build', events, pistonPlans })
      const blockWrite = Schema.decodeUnknownSync(WorldWriteBatchSchema)({
        world: testWorldId,
        expectedWorldRevision: 5,
        dimension: String(dimension),
        expectedDimensionRevision: 2,
        edits: [{ position: { x: 100, y: 0, z: 0 }, block: 1 }],
      })
      const request: WorldCommitRequest = {
        expectedRevision: blockWrite.expectedWorldRevision,
        expectedDimensions: [{ dimension: blockWrite.dimension, expectedRevision: blockWrite.expectedDimensionRevision }],
        changes: [
          {
            ownerId: Schema.decodeUnknownSync(ReplicatedOwnerIdSchema)('redstone-host-test-owner'),
            state: { eventCount: eventCount(events), pistonPlanCount: pistonPlans.length },
          },
        ],
        blockWrite,
      }
      return Result.succeed(request)
    },
    buildHopperBlockWrite: (event, blockId, revisions) =>
      Result.succeed(Schema.decodeUnknownSync(WorldWriteBatchSchema)({
        world: testWorldId,
        expectedWorldRevision: revisions.expectedRevision,
        dimension: event.dimension,
        expectedDimensionRevision: revisions.expectedDimensionRevision,
        edits: [{ position: event.position, block: blockId }],
      })),
    coordinator: {
      worldId: testWorldId,
      revision: Effect.succeed(revisionBatch.expectedWorldRevision),
      dimensionRevision: () => Effect.succeed(revisionBatch.expectedDimensionRevision),
      snapshot: (ownerId, schema) => {
        const state = ownerId === HOPPER_REPLICATED_OWNER_ID
          ? { hoppers: [] }
          : { version: CONTAINER_STORAGE_SNAPSHOT_VERSION, containers: [] }
        return Schema.decodeUnknownEffect(schema)(state).pipe(
          Effect.map((decodedState) => ({
            world: testWorldId,
            revision: revisionBatch.expectedWorldRevision,
            state: decodedState,
          })),
        )
      },
      commit: (request) =>
        Effect.sync(() => {
          calls.push({ kind: 'commit', request })
          return {
            world: request.blockWrite?.world ?? testWorldId,
            revision: request.expectedRevision,
            changes: [],
            blockChanges: [],
          }
        }),
    },
    hopperService: {
      planAdvanceCooldown: (snapshot, request) =>
        Effect.sync(() => {
          calls.push({ kind: 'hopper-cooldown-plan', snapshot, request })
          return {
            world: snapshot.world,
            expectedRevision: snapshot.expectedRevision,
            expectedDimensions: [],
            changes: [],
            result: { _tag: 'NoChange' },
            postCommitEvents: [],
          }
        }),
      planTransferTick: (snapshot, elapsedTicks, powered) =>
        Effect.sync(() => {
          calls.push({ kind: 'hopper-plan', snapshot, elapsedTicks, powered })
          return {
            world: snapshot.world,
            expectedRevision: snapshot.expectedRevision,
            expectedDimensions: snapshot.expectedDimensions,
            changes: [],
            blockEdits: snapshot.state.intent.blockEdits,
            result: transferRejected,
            postCommitEvents: [],
          }
        }),
    },
  }
  return { calls, port, realm: { dimension, lookup } }
}

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

const TICKS_TO_SETTLE_A_HOPPER = 4

describe('componentForBlock', () => {
  const cases: ReadonlyArray<{
    readonly block: RedstoneHostBlockType
    readonly kind: RedstoneComponentSnapshot['kind']
  }> = [
    { block: 'hopper', kind: 'hopper' },
    { block: 'dispenser', kind: 'dispenser' },
    { block: 'dropper', kind: 'dropper' },
    { block: 'note_block', kind: 'note-block' },
    { block: 'redstone_torch', kind: 'torch' },
    { block: 'redstone_wire', kind: 'wire' },
    { block: 'redstone_lamp', kind: 'lamp' },
    { block: 'redstone_lamp_lit', kind: 'lamp' },
    { block: 'door', kind: 'door' },
    { block: 'door_open', kind: 'door' },
    { block: 'trapdoor', kind: 'trapdoor' },
  ]

  for (const testCase of cases) {
    it.effect(`classifies '${testCase.block}' as kind '${testCase.kind}'`, () =>
      Effect.sync(() => {
        const position = blockPosition(0, 0, 0)
        expect(componentValue(missingLookup, testCase.block, position)).toMatchObject({
          kind: testCase.kind,
          position,
        })
      }),
    )
  }

  it.effect('a block without a component classifies to no component, not a guess', () =>
    Effect.sync(() => {
      expect(componentValue(missingLookup, 'dirt', blockPosition(0, 0, 0))).toBeUndefined()
      expect(componentValue(missingLookup, null, blockPosition(0, 0, 0))).toBeUndefined()
    }),
  )

  it.effect('a powered rail asks the host lookup, not a fixed default', () =>
    Effect.sync(() => {
      const poweredLookup: RedstoneHostLookup = { ...missingLookup, isPoweredRailPowered: () => true }
      expect(componentValue(poweredLookup, 'powered_rail', blockPosition(0, 0, 0))).toMatchObject({
        kind: 'powered-rail',
        powered: true,
      })
      expect(componentValue(missingLookup, 'powered_rail', blockPosition(0, 0, 0))).toMatchObject({
        kind: 'powered-rail',
        powered: false,
      })
    }),
  )

  it.effect('a lever asks the host lookup, not a fixed default', () =>
    Effect.sync(() => {
      const activeLookup: RedstoneHostLookup = { ...missingLookup, isLeverActive: () => true }
      expect(componentValue(activeLookup, 'lever', blockPosition(0, 0, 0))).toMatchObject({
        active: true,
        kind: 'lever',
      })
      expect(componentValue(missingLookup, 'lever', blockPosition(0, 0, 0))).toMatchObject({
        active: false,
        kind: 'lever',
      })
    }),
  )

  it.effect(
    'a comparator reads its rear cell for container slots and derives inputFrom/outputTo/sideInputs',
    () =>
      Effect.sync(() => {
        const position = blockPosition(2, 0, 0)
        const withSlots: RedstoneHostLookup = {
          ...missingLookup,
          readContainerSlots: (readAt) => {
            expect(readAt).toStrictEqual(blockPosition(2, 0, 1))
            return [Schema.decodeUnknownSync(ContainerSlotSchema)({ count: 32, maxStack: 64 })]
          },
        }
        expect(componentValue(withSlots, 'comparator', position)).toStrictEqual({
          containerSlots: [Schema.decodeUnknownSync(ContainerSlotSchema)({ count: 32, maxStack: 64 })],
          inputFrom: blockPosition(2, 0, 1),
          kind: 'comparator',
          mode: 'compare',
          outputTo: blockPosition(2, 0, -1),
          position,
          sideInputs: [
            blockPosition(1, 0, 0),
            blockPosition(3, 0, 0),
          ],
        })
      }),
  )

  it.effect('a comparator omits containerSlots entirely when the host has no reading, rather than an empty array', () =>
    Effect.sync(() => {
      const component = componentValue(missingLookup, 'comparator', blockPosition(0, 0, 0))
      expect(component).toBeDefined()
      expect(Object.keys(component ?? {})).not.toContain('containerSlots')
    }),
  )

  it.effect('a piston uses its actual facing and normal kind to read the head cell', () =>
    Effect.sync(() => {
      const readPositions: Array<BlockPosition> = []
      const extended: RedstoneHostLookup = {
        ...missingLookup,
        readPistonFacing: () => 'east',
        readPistonCell: (position) => {
          readPositions.push(position)
          return { block: 'piston_head', kind: 'block' }
        },
      }
      const stickyFacingSouth: RedstoneHostLookup = {
        ...missingLookup,
        readPistonFacing: () => 'south',
        readPistonCell: (position) => {
          readPositions.push(position)
          return { kind: 'empty' }
        },
      }

      expect(componentValue(extended, 'piston', blockPosition(0, 0, 0))).toMatchObject({
        pistonFacing: 'east',
        pistonKind: 'normal',
        pistonState: 'extended',
      })
      expect(componentValue(stickyFacingSouth, 'sticky_piston', blockPosition(0, 0, 0))).toMatchObject({
        pistonFacing: 'south',
        pistonKind: 'sticky',
        pistonState: 'retracted',
      })
      expect(readPositions).toStrictEqual([blockPosition(1, 0, 0), blockPosition(0, 0, 1)])
    }),
  )

  it.effect('REGRESSION: derived comparator and piston neighbors report typed range failures', () =>
    Effect.sync(() => {
      const headReads: Array<BlockPosition> = []
      const edgeLookup: RedstoneHostLookup = {
        ...missingLookup,
        readPistonFacing: () => 'east',
        readPistonCell: (position) => {
          headReads.push(position)
          return { kind: 'empty' }
        },
      }
      const edge = blockPosition(Number.MAX_SAFE_INTEGER, 0, 0)

      expect(componentForBlock(edgeLookup, 'comparator', edge)).toStrictEqual(
        Result.fail({ _tag: 'RedstoneHostPositionOutOfRange' }),
      )
      expect(componentForBlock(edgeLookup, 'piston', edge)).toStrictEqual(
        Result.fail({ _tag: 'RedstoneHostPositionOutOfRange' }),
      )
      expect(headReads).toStrictEqual([])
    }),
  )
})

describe('kernelPistonCapabilities', () => {
  it.effect('reads mc-kernel’s own pistonImmovable capability rather than a local roster', () =>
    Effect.sync(() => {
      // bedrock/dirt are asserted against mc-kernel's PUBLISHED capability
      // table, not invented here (DN-RS-1) — see docs/responsibility.md §2.
      expect(kernelPistonCapabilities.pistonImmovable('bedrock')).toStrictEqual(Result.succeed(true))
      expect(kernelPistonCapabilities.pistonImmovable('dirt')).toStrictEqual(Result.succeed(false))
    }),
  )

  it.effect('REGRESSION: a string mc-kernel does not recognise as a block type is never immovable', () =>
    Effect.sync(() => {
      expect(kernelPistonCapabilities.pistonImmovable('not_a_real_block_xyz')).toStrictEqual(Result.succeed(false))
    }),
  )
})

describe('redstoneSnapshotFromRealm', () => {
  const realm: RedstoneHostRealm = { dimension: dimensionId('overworld'), lookup: missingLookup }

  it.effect('carries the realm’s dimension and skips every block with no component', () =>
    Effect.sync(() => {
      const snapshot = snapshotValue(realm, [
        block('hopper'),
        block('dirt'),
        block(null),
        block('redstone_wire'),
      ])
      expect(snapshot.dimension).toBe(dimensionId('overworld'))
      expect(snapshot.components.map((component) => component.kind)).toStrictEqual(['hopper', 'wire'])
    }),
  )

  it.effect('an empty block list produces an empty, not missing, component list', () =>
    Effect.sync(() => {
      expect(snapshotValue(realm, [])).toStrictEqual({ components: [], dimension: dimensionId('overworld') })
    }),
  )

  it.effect('returns the typed range failure instead of omitting a comparator at an unrepresentable neighbor', () =>
    Effect.sync(() => {
      const testRealm: RedstoneHostRealm = { dimension: dimensionId('overworld'), lookup: missingLookup }
      expect(redstoneSnapshotFromRealm(testRealm, [block('comparator', Number.MAX_SAFE_INTEGER)])).toStrictEqual(
        Result.fail({ _tag: 'RedstoneHostPositionOutOfRange' }),
      )
    }),
  )
})

describe('invariant: component snapshots only include blocks with redstone behavior', () => {
  const KNOWN_BLOCKS: ReadonlyArray<RedstoneHostBlockType> = [
    'hopper',
    'dispenser',
    'dropper',
    'note_block',
    'redstone_torch',
    'redstone_wire',
    'powered_rail',
    'lever',
    'comparator',
    'redstone_lamp',
    'redstone_lamp_lit',
    'door',
    'door_open',
    'trapdoor',
    'piston',
  ]
  const NON_COMPONENT_BLOCKS: ReadonlyArray<RedstoneHostBlockType | null> = ['stone', 'dirt', 'air', 'chest', null]
  const ALL_BLOCKS: ReadonlyArray<RedstoneHostBlockType | null> = [...KNOWN_BLOCKS, ...NON_COMPONENT_BLOCKS]

  it.effect(
    'every redstone block yields exactly one component, and non-component blocks yield none',
    () =>
      Effect.sync(() => {
        // Enumerated rather than sampled from one fixture: every redstone block
        // this repository handles, crossed with blocks that have no component,
        // each at a DISTINCT position so a leaked or duplicated position
        // would be visible.
        const positioned: ReadonlyArray<RedstoneHostBlock> = ALL_BLOCKS.map((name, index) => ({
          block: name,
          address: blockAddress('overworld', index),
        }))
        const realm: RedstoneHostRealm = { dimension: dimensionId('overworld'), lookup: missingLookup }

        const snapshot = snapshotValue(realm, positioned)

        // Invariant 1: never more components than blocks offered.
        expect(snapshot.components.length).toBeLessThanOrEqual(positioned.length)
        // Invariant 2: exactly the blocks with redstone components, none dropped or invented.
        expect(snapshot.components.length).toBe(KNOWN_BLOCKS.length)
        // Invariant 3: every emitted component's position traces back to a
        // KNOWN block at that exact x — no cross-contamination between
        // enumerated entries.
        for (const component of snapshot.components) {
          const source = positioned.find((candidate) => candidate.address.position.x === component.position.x)
          expect(source).toBeDefined()
          expect(KNOWN_BLOCKS).toContain(source?.block)
        }
      }),
  )
})

/**
 * A board exercising every drained event kind at once. Every actuator sits
 * directly adjacent to the lever — one per face — the same pattern
 * `test/world-runtime.test.ts` uses for a single piston, so each gets power
 * without routing through another actuator (actuators do not conduct). The
 * hopper is placed far away, disconnected: its transfer is driven by being
 * UNPOWERED, not by adjacency.
 */
const mixedComponentsSnapshot: ReadonlyArray<RedstoneComponentSnapshot> = [
  { active: true, kind: 'lever', position: blockPosition(0, 0, 0) },
  { kind: 'wire', position: blockPosition(1, 0, 0) },
  { kind: 'lamp', position: blockPosition(2, 0, 0) },
  { kind: 'dispenser', position: blockPosition(-1, 0, 0) },
  { kind: 'dropper', position: blockPosition(0, 1, 0) },
  { kind: 'door', position: blockPosition(0, -1, 0) },
  { kind: 'powered-rail', position: blockPosition(0, 0, 1) },
  {
    kind: 'piston',
    pistonFacing: 'south',
    pistonKind: 'normal',
    pistonState: 'retracted',
    position: blockPosition(0, 0, -1),
  },
  { kind: 'hopper', position: blockPosition(10, 10, 10) },
]

/** Every scan cell reads as empty, so any piston extension plans a bare push into free space. */
const alwaysEmptyPistonLookup: RedstoneHostLookup = {
  ...missingLookup,
  readPistonCell: () => ({ kind: 'empty' }),
}

describe('applyRedstoneHostEvents', () => {
  it.effect('plans the full drained batch before one WCC commit', () =>
    Effect.gen(function* () {
      const runtime = yield* RedstoneWorldRuntime
      const stages = yield* makeRuntimeRedstoneStages
      const { calls, port, realm } = recordingRealm(dimensionId('overworld'), alwaysEmptyPistonLookup)

      yield* runtime.syncSnapshot({ components: mixedComponentsSnapshot, dimension: dimensionId('overworld') })

      for (let tick = 0; tick < TICKS_TO_SETTLE_A_HOPPER; tick += 1) {
        yield* runFrame(stages)
      }
      yield* applyRedstoneHostEvents(runtime, [realm], port)

      expect(buildCallsOf(calls)).toHaveLength(1)
      expect(commitCallsOf(calls)).toHaveLength(1)
      const [build] = buildCallsOf(calls)
      const [commit] = commitCallsOf(calls)
      expect(build?.events.lamp).toContainEqual({ dimension: dimensionId('overworld'), lit: true, position: blockPosition(2, 0, 0) })
      expect(build?.events.trigger).toContainEqual({ dimension: dimensionId('overworld'), kind: 'dispenser', position: blockPosition(-1, 0, 0) })
      expect(build?.events.trigger).toContainEqual({ dimension: dimensionId('overworld'), kind: 'dropper', position: blockPosition(0, 1, 0) })
      expect(build?.events.hopper).toStrictEqual([])
      expect(build?.events.powered).toContainEqual({ dimension: dimensionId('overworld'), kind: 'door', powered: true, position: blockPosition(0, -1, 0) })
      expect(build?.events.powered).toContainEqual({ dimension: dimensionId('overworld'), kind: 'powered-rail', powered: true, position: blockPosition(0, 0, 1) })
      expect(build?.pistonPlans).toHaveLength(1)
      expect(commit?.request.changes).toHaveLength(1)
      expect(commit?.request.blockWrite?.edits).toHaveLength(1)
      expect(hopperCooldownPlanCallsOf(calls)).toHaveLength(TICKS_TO_SETTLE_A_HOPPER)
      expect(hopperCooldownPlanCallsOf(calls).map(({ request }) => request.ticks)).toStrictEqual([2, 2, 2, 2])
      expect(hopperPlanCallsOf(calls)).toStrictEqual([])
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )

  it.effect('converts elapsed redstone ticks to game ticks and plans selected endpoints', () =>
    Effect.gen(function* () {
      const runtime = yield* RedstoneWorldRuntime
      const hopperPosition = blockPosition(10, 10, 10)
      const sourceAddress = blockAddress('overworld', 10, 11, 10)
      const hopperLookup: RedstoneHostLookup = {
        ...missingLookup,
        readHopperTransferContext: () => ({
          powered: false,
          sourceAbove: { address: sourceAddress, kind: 'hopper' },
          destinationFacing: null,
        }),
      }
      const { calls, port, realm } = recordingRealm(dimensionId('overworld'), hopperLookup)
      const event = hopperTransferEvent(dimensionId('overworld'), hopperPosition, 4)
      yield* runtime.restoreEvents(emptyEvents({ hopper: [event] }))
      yield* applyRedstoneHostEvents(runtime, [realm], port)

      expect(hopperPlanCallsOf(calls).length).toBeGreaterThan(0)
      const plan = hopperPlanCallsOf(calls)[0]
      expect(plan?.elapsedTicks).toBe(8)
      expect(plan?.snapshot.state.intent).toMatchObject({
        destination: { _tag: 'Container', address: blockAddress('overworld', 10, 10, 10), slot: 0 },
        hopperAddress: blockAddress('overworld', 10, 10, 10),
        source: { _tag: 'Container', address: sourceAddress, slot: 0 },
      })
      expect(plan?.snapshot.state.intent.blockEdits.edits).toStrictEqual([
        { block: HOPPER_BLOCK_ID, position: hopperPosition },
      ])
      expect(commitCallsOf(calls)).toHaveLength(1)
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )

  it.effect('rejects invalid elapsed hopper ticks and invalid selection context', () =>
    Effect.gen(function* () {
      const runtime = yield* RedstoneWorldRuntime
      const malformedEvent = hopperTransferEvent(dimensionId('overworld'), blockPosition(10, 10, 10))
      Object.defineProperty(malformedEvent, 'elapsedRedstoneTicks', { value: -1 })
      yield* runtime.restoreEvents(emptyEvents({ hopper: [malformedEvent] }))
      const first = recordingRealm(dimensionId('overworld'), missingLookup)

      const invalidDue = yield* Effect.result(applyRedstoneHostEvents(runtime, [first.realm], first.port))

      expect(invalidDue).toMatchObject({ _tag: 'Failure', failure: { _tag: 'SchemaError' } })
      expect(first.calls).toStrictEqual([])
      expect(yield* runtime.drainHopperTransferEvents).toStrictEqual([malformedEvent])

      const contextWithUnexpectedProperty = {
        powered: false,
        sourceAbove: null,
        destinationFacing: null,
        unexpected: true,
      }
      const invalidContextLookup: RedstoneHostLookup = {
        ...missingLookup,
        readHopperTransferContext: () => contextWithUnexpectedProperty,
      }
      const validEvent = hopperTransferEvent(dimensionId('overworld'), blockPosition(10, 10, 10))
      yield* runtime.restoreEvents(emptyEvents({ hopper: [validEvent] }))
      const second = recordingRealm(dimensionId('overworld'), invalidContextLookup)

      const invalidSelection = yield* Effect.result(applyRedstoneHostEvents(runtime, [second.realm], second.port))

      expect(invalidSelection).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'RedstoneHostHopperSelectionInvalid' },
      })
      expect(second.calls).toStrictEqual([])
      expect(yield* runtime.drainHopperTransferEvents).toStrictEqual([validEvent])
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )

  it.effect('rejects missing hopper blocks, builder failures, and mismatched block writes', () =>
    Effect.gen(function* () {
      const runtime = yield* RedstoneWorldRuntime
      const event = hopperTransferEvent(dimensionId('overworld'), blockPosition(10, 10, 10))
      const sourceAddress = blockAddress('overworld', 10, 11, 10)
      const hopperLookup: RedstoneHostLookup = {
        ...missingLookup,
        readHopperTransferContext: () => ({
          powered: false,
          sourceAbove: { address: sourceAddress, kind: 'hopper' },
          destinationFacing: null,
        }),
      }
      const missingBlockLookup: RedstoneHostLookup = {
        ...hopperLookup,
        readHopperBlockId: () => null,
      }
      yield* runtime.restoreEvents(emptyEvents({ hopper: [event] }))
      const missingBlock = recordingRealm(dimensionId('overworld'), missingBlockLookup)
      const missingBlockResult = yield* Effect.result(
        applyRedstoneHostEvents(runtime, [missingBlock.realm], missingBlock.port),
      )
      expect(missingBlockResult).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'RedstoneHostHopperBlockMissing' },
      })
      expect(missingBlock.calls).toStrictEqual([])
      expect(yield* runtime.drainHopperTransferEvents).toStrictEqual([event])

      yield* runtime.restoreEvents(emptyEvents({ hopper: [event] }))
      const buildFailure = recordingRealm(dimensionId('overworld'), hopperLookup)
      const buildFailurePort: RedstoneHostWritePort<string> = {
        ...buildFailure.port,
        buildHopperBlockWrite: () => Result.fail('hopper block write could not be built'),
      }
      const buildFailureResult = yield* Effect.result(
        applyRedstoneHostEvents(runtime, [buildFailure.realm], buildFailurePort),
      )
      expect(buildFailureResult).toStrictEqual(Result.fail('hopper block write could not be built'))
      expect(hopperPlanCallsOf(buildFailure.calls)).toStrictEqual([])
      expect(yield* runtime.drainHopperTransferEvents).toStrictEqual([event])

      const mismatchedWrites = [
        Schema.decodeUnknownSync(WorldWriteBatchSchema)({
          world: testWorldId,
          expectedWorldRevision: 5,
          dimension: dimensionId('overworld'),
          expectedDimensionRevision: 2,
          edits: [],
        }),
        Schema.decodeUnknownSync(WorldWriteBatchSchema)({
          world: testWorldId,
          expectedWorldRevision: 5,
          dimension: dimensionId('overworld'),
          expectedDimensionRevision: 2,
          edits: [{ position: blockPosition(11, 10, 10), block: HOPPER_BLOCK_ID }],
        }),
      ]
      for (const blockWrite of mismatchedWrites) {
        yield* runtime.restoreEvents(emptyEvents({ hopper: [event] }))
        const mismatch = recordingRealm(dimensionId('overworld'), hopperLookup)
        const mismatchPort: RedstoneHostWritePort = {
          ...mismatch.port,
          buildHopperBlockWrite: () => Result.succeed(blockWrite),
        }
        const mismatchResult = yield* Effect.result(
          applyRedstoneHostEvents(runtime, [mismatch.realm], mismatchPort),
        )
        expect(mismatchResult).toMatchObject({
          _tag: 'Failure',
          failure: { _tag: 'RedstoneHostHopperBlockWriteMismatch' },
        })
        expect(hopperPlanCallsOf(mismatch.calls)).toStrictEqual([])
        expect(yield* runtime.drainHopperTransferEvents).toStrictEqual([event])
      }
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )

  it.effect('accepts owner-only redstone commits and rejects stale revisions', () =>
    Effect.gen(function* () {
      const runtime = yield* RedstoneWorldRuntime
      const trigger = {
        dimension: dimensionId('overworld'),
        position: blockPosition(10, 0, 0),
        kind: 'note-block',
      } as const
      const events = emptyEvents({ trigger: [trigger] })
      const noBlockWrite = recordingRealm(dimensionId('overworld'), missingLookup)
      const ownerOnlyPort: RedstoneHostWritePort = {
        ...noBlockWrite.port,
        buildCommitRequest: (batch, pistonPlans) =>
          Result.map(noBlockWrite.port.buildCommitRequest(batch, pistonPlans), ({ blockWrite: _blockWrite, ...request }) => request),
      }
      yield* runtime.restoreEvents(events)
      const ownerOnlyResult = yield* Effect.result(
        applyRedstoneHostEvents(runtime, [noBlockWrite.realm], ownerOnlyPort),
      )
      expect(Result.isSuccess(ownerOnlyResult)).toBe(true)
      expect(commitCallsOf(noBlockWrite.calls)).toHaveLength(1)
      expect(commitCallsOf(noBlockWrite.calls)[0]?.request.blockWrite).toBeUndefined()
      expect(yield* runtime.drainTriggerEvents).toStrictEqual([])

      const staleRevision = recordingRealm(dimensionId('overworld'), missingLookup)
      const staleRevisionPort: RedstoneHostWritePort = {
        ...staleRevision.port,
        buildCommitRequest: () => Result.succeed({
          expectedRevision: Schema.decodeUnknownSync(WorldRevisionSchema)(6),
          expectedDimensions: [],
          changes: [],
        }),
      }
      yield* runtime.restoreEvents(events)
      const staleRevisionResult = yield* Effect.result(
        applyRedstoneHostEvents(runtime, [staleRevision.realm], staleRevisionPort),
      )
      expect(staleRevisionResult).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'WorldCommitPlanRevisionConflict' },
      })
      expect(yield* runtime.drainTriggerEvents).toStrictEqual(events.trigger)
      expect(commitCallsOf(staleRevision.calls)).toStrictEqual([])
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )

  it.effect('rejects stale redstone dimension and block write revisions', () =>
    Effect.gen(function* () {
      const runtime = yield* RedstoneWorldRuntime
      const events = emptyEvents({
        trigger: [{
          dimension: dimensionId('overworld'),
          position: blockPosition(10, 0, 0),
          kind: 'note-block',
        }],
      })
      const expectedRevision = Schema.decodeUnknownSync(WorldRevisionSchema)(5)
      const expectedDimensionRevision = Schema.decodeUnknownSync(DimensionRevisionSchema)(2)
      const blockWrite = (overrides: Partial<Schema.Schema.Type<typeof WorldWriteBatchSchema>> = {}) =>
        Schema.decodeUnknownSync(WorldWriteBatchSchema)({
          dimension: 'overworld',
          edits: [{ block: 1, position: { x: 10, y: 0, z: 0 } }],
          expectedDimensionRevision,
          expectedWorldRevision: expectedRevision,
          world: testWorldId,
          ...overrides,
        })
      const baseRequest: WorldCommitRequest = {
        expectedRevision,
        expectedDimensions: [{ dimension: dimensionId('overworld'), expectedRevision: expectedDimensionRevision }],
        changes: [],
        blockWrite: blockWrite(),
      }
      const staleWorldId = Schema.decodeUnknownSync(WorldIdSchema)('other-redstone-world')
      const staleWorldRevision = Schema.decodeUnknownSync(WorldRevisionSchema)(6)
      const staleDimensionRevision = Schema.decodeUnknownSync(DimensionRevisionSchema)(3)
      const cases: ReadonlyArray<Readonly<{ request: WorldCommitRequest; tag: string }>> = [
        {
          request: {
            ...baseRequest,
            expectedDimensions: [{
              dimension: dimensionId('overworld'),
              expectedRevision: staleDimensionRevision,
            }],
          },
          tag: 'WorldCommitPlanDimensionRevisionConflict',
        },
        {
          request: { ...baseRequest, blockWrite: blockWrite({ world: staleWorldId }) },
          tag: 'WorldCommitPlanRevisionConflict',
        },
        {
          request: {
            ...baseRequest,
            blockWrite: blockWrite({ expectedWorldRevision: staleWorldRevision }),
          },
          tag: 'WorldCommitPlanRevisionConflict',
        },
        {
          request: {
            ...baseRequest,
            blockWrite: blockWrite({ expectedDimensionRevision: staleDimensionRevision }),
          },
          tag: 'WorldCommitPlanDimensionRevisionConflict',
        },
      ]

      for (const { request, tag } of cases) {
        const { calls, port, realm } = recordingRealm(dimensionId('overworld'), missingLookup)
        const stalePort: RedstoneHostWritePort = {
          ...port,
          buildCommitRequest: () => Result.succeed(request),
        }
        yield* runtime.restoreEvents(events)
        const result = yield* Effect.result(applyRedstoneHostEvents(runtime, [realm], stalePort))
        expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: tag } })
        expect(commitCallsOf(calls)).toStrictEqual([])
        expect(yield* runtime.drainTriggerEvents).toStrictEqual(events.trigger)
      }
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )

  it.effect('rejects a captured world or revision that disagrees with owner snapshots', () =>
    Effect.gen(function* () {
      const runtime = yield* RedstoneWorldRuntime
      const events = emptyEvents({
        trigger: [{
          dimension: dimensionId('overworld'),
          position: blockPosition(10, 0, 0),
          kind: 'note-block',
        }],
      })
      const otherWorld = Schema.decodeUnknownSync(WorldIdSchema)('different-redstone-world')
      const cases = [
        {
          failure: 'WorldCommitPlanWorldConflict',
          alterCoordinator: (port: RedstoneHostWritePort) => ({
            ...port,
            coordinator: { ...port.coordinator, worldId: otherWorld },
          }),
        },
        {
          failure: 'WorldCommitPlanRevisionConflict',
          alterCoordinator: (port: RedstoneHostWritePort) => ({
            ...port,
            coordinator: {
              ...port.coordinator,
              revision: Effect.succeed(Schema.decodeUnknownSync(WorldRevisionSchema)(6)),
            },
          }),
        },
      ] as const

      for (const { failure, alterCoordinator } of cases) {
        const { port, realm, calls } = recordingRealm(dimensionId('overworld'), missingLookup)
        const inconsistentPort = alterCoordinator(port)
        yield* runtime.restoreEvents(events)

        const result = yield* Effect.result(
          applyRedstoneHostEvents(runtime, [realm], inconsistentPort),
        )

        expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: failure } })
        expect(commitCallsOf(calls)).toStrictEqual([])
        expect(yield* runtime.drainTriggerEvents).toStrictEqual(events.trigger)
      }
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )

  it.effect('rejects a request for a dimension absent from the captured revision context', () =>
    Effect.gen(function* () {
      const runtime = yield* RedstoneWorldRuntime
      const trigger = {
        dimension: dimensionId('overworld'),
        position: blockPosition(10, 0, 0),
        kind: 'note-block',
      } as const
      const { calls, port, realm } = recordingRealm(dimensionId('overworld'), missingLookup)
      const otherDimension = dimensionId('nether')
      const invalidDimensionPort: RedstoneHostWritePort = {
        ...port,
        buildCommitRequest: () => Result.succeed({
          expectedRevision: Schema.decodeUnknownSync(WorldRevisionSchema)(5),
          expectedDimensions: [{
            dimension: otherDimension,
            expectedRevision: Schema.decodeUnknownSync(DimensionRevisionSchema)(2),
          }],
          changes: [],
        }),
      }
      yield* runtime.restoreEvents(emptyEvents({ trigger: [trigger] }))

      const result = yield* Effect.result(
        applyRedstoneHostEvents(runtime, [realm], invalidDimensionPort),
      )

      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'WorldCommitPlanDimensionRevisionMissing', dimension: otherDimension },
      })
      expect(commitCallsOf(calls)).toStrictEqual([])
      expect(yield* runtime.drainTriggerEvents).toStrictEqual([trigger])
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )

  it.effect('rejects conflicting block edits and mixed dimensions from hopper plan fragments', () =>
    Effect.gen(function* () {
      const runtime = yield* RedstoneWorldRuntime
      const events = [
        hopperTransferEvent(dimensionId('overworld'), blockPosition(10, 10, 10)),
        hopperTransferEvent(dimensionId('overworld'), blockPosition(11, 10, 10)),
      ]
      const sharedPosition = blockPosition(20, 10, 20)
      const otherDimension = dimensionId('nether')
      const cases = [
        {
          expectedFailure: 'WorldCommitPlanBlockConflict',
          makeBlockEdits: (index: number): NonNullable<WorldCommitPlanFragment<unknown>['blockEdits']> => ({
            dimension: dimensionId('overworld'),
            edits: [{
              position: sharedPosition,
              block: index === 0 ? HOPPER_BLOCK_ID : STONE_BLOCK_ID,
            }],
          }),
        },
        {
          expectedFailure: 'WorldCommitPlanDimensionConflict',
          makeBlockEdits: (index: number): NonNullable<WorldCommitPlanFragment<unknown>['blockEdits']> => ({
            dimension: index === 0 ? dimensionId('overworld') : otherDimension,
            edits: [{ position: sharedPosition, block: HOPPER_BLOCK_ID }],
          }),
        },
      ] as const

      for (const { expectedFailure, makeBlockEdits } of cases) {
        const { calls, port, realm } = recordingRealm(dimensionId('overworld'), missingLookup)
        let fragmentIndex = 0
        const conflictingPort: RedstoneHostWritePort = {
          ...port,
          hopperService: {
            ...port.hopperService,
            planAdvanceCooldown: (snapshot) => Effect.sync(() => ({
              world: snapshot.world,
              expectedRevision: snapshot.expectedRevision,
              expectedDimensions: snapshot.expectedDimensions,
              changes: [],
              blockEdits: makeBlockEdits(fragmentIndex++),
              result: { _tag: 'NoChange' },
              postCommitEvents: [],
            })),
          },
        }
        yield* runtime.restoreEvents(emptyEvents({ hopper: events }))

        const result = yield* Effect.result(
          applyRedstoneHostEvents(runtime, [realm], conflictingPort),
        )

        expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: expectedFailure } })
        expect(commitCallsOf(calls)).toStrictEqual([])
        expect(yield* runtime.drainHopperTransferEvents).toStrictEqual(events)
      }
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )

  it.effect('tries another candidate after a rejected hopper plan', () =>
    Effect.gen(function* () {
      const runtime = yield* RedstoneWorldRuntime
      const event = hopperTransferEvent(dimensionId('overworld'), blockPosition(10, 10, 10))
      const hopperLookup: RedstoneHostLookup = {
        ...missingLookup,
        readHopperTransferContext: () => ({
          powered: false,
          sourceAbove: { address: blockAddress('overworld', 10, 11, 10), kind: 'hopper' },
          destinationFacing: { address: blockAddress('overworld', 11, 10, 10), kind: 'chest' },
        }),
      }
      const { calls, port, realm } = recordingRealm(dimensionId('overworld'), hopperLookup)
      yield* runtime.restoreEvents(emptyEvents({ hopper: [event] }))

      yield* applyRedstoneHostEvents(runtime, [realm], port)

      const plans = hopperPlanCallsOf(calls)
      expect(plans.length).toBeGreaterThan(1)
      expect(plans[0]?.snapshot.state.intent.destination).not.toStrictEqual(
        plans[1]?.snapshot.state.intent.destination,
      )
      expect(commitCallsOf(calls)).toHaveLength(1)
      expect(yield* runtime.drainHopperTransferEvents).toStrictEqual([])
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )

  it.effect('returns plan validation failures and restores the hopper event', () =>
    Effect.gen(function* () {
      const runtime = yield* RedstoneWorldRuntime
      const event = hopperTransferEvent(dimensionId('overworld'), blockPosition(10, 10, 10))
      const hopperLookup: RedstoneHostLookup = {
        ...missingLookup,
        readHopperTransferContext: () => ({
          powered: false,
          sourceAbove: { address: blockAddress('overworld', 10, 11, 10), kind: 'hopper' },
          destinationFacing: null,
        }),
      }
      const { calls, port, realm } = recordingRealm(dimensionId('overworld'), hopperLookup)
      const invalidPlanPort: RedstoneHostWritePort = {
        ...port,
        hopperService: {
          ...port.hopperService,
          planTransferTick: (snapshot, elapsedTicks, powered) =>
            Effect.sync(() => {
              calls.push({ kind: 'hopper-plan', snapshot, elapsedTicks, powered })
              return {
                world: snapshot.world,
                expectedRevision: snapshot.expectedRevision,
                expectedDimensions: snapshot.expectedDimensions,
                changes: [],
                result: { _tag: 'InvalidRequest', reason: 'missing-hopper-block-edit' },
                postCommitEvents: [],
              }
            }),
        },
      }
      yield* runtime.restoreEvents(emptyEvents({ hopper: [event] }))

      const result = yield* Effect.result(applyRedstoneHostEvents(runtime, [realm], invalidPlanPort))

      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'RedstoneHostHopperTransferInvalid', reason: 'missing-hopper-block-edit' },
      })
      expect(commitCallsOf(calls)).toStrictEqual([])
      expect(yield* runtime.drainHopperTransferEvents).toStrictEqual([event])
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )

  it.effect('rejects a hopper block-write builder result with excess properties', () =>
    Effect.gen(function* () {
      const runtime = yield* RedstoneWorldRuntime
      const event = hopperTransferEvent(dimensionId('overworld'), blockPosition(10, 10, 10))
      const sourceAddress = blockAddress('overworld', 10, 11, 10)
      const hopperLookup: RedstoneHostLookup = {
        ...missingLookup,
        readHopperTransferContext: () => ({
          powered: false,
          sourceAbove: { address: sourceAddress, kind: 'hopper' },
          destinationFacing: null,
        }),
      }
      const { calls, port, realm } = recordingRealm(dimensionId('overworld'), hopperLookup)
      const excessWritePort: RedstoneHostWritePort = {
        ...port,
        buildHopperBlockWrite: (transferEvent, blockId, revisions) => {
          const blockWrite = Schema.decodeUnknownSync(WorldWriteBatchSchema)({
            world: testWorldId,
            expectedWorldRevision: revisions.expectedRevision,
            dimension: transferEvent.dimension,
            expectedDimensionRevision: revisions.expectedDimensionRevision,
            edits: [{ position: transferEvent.position, block: blockId }],
          })
          return Result.succeed({ ...blockWrite, unexpected: true })
        },
      }
      yield* runtime.restoreEvents(emptyEvents({ hopper: [event] }))

      const result = yield* Effect.result(applyRedstoneHostEvents(runtime, [realm], excessWritePort))

      expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: 'SchemaError' } })
      expect(hopperPlanCallsOf(calls)).toStrictEqual([])
      expect(yield* runtime.drainHopperTransferEvents).toStrictEqual([event])
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )

  it.effect('a powered stale hopper event is locked and never reaches cooldown or transfer services', () =>
    Effect.gen(function* () {
      const runtime = yield* RedstoneWorldRuntime
      const event = hopperTransferEvent(dimensionId('overworld'), blockPosition(10, 10, 10))
      yield* runtime.restoreEvents(emptyEvents({ hopper: [event] }))
      const poweredLookup: RedstoneHostLookup = {
        ...missingLookup,
        readHopperTransferContext: () => ({ powered: true, sourceAbove: null, destinationFacing: null }),
      }
      const { calls, port, realm } = recordingRealm(dimensionId('overworld'), poweredLookup)

      yield* applyRedstoneHostEvents(runtime, [realm], port)

      expect(calls).toStrictEqual([])
      expect(yield* runtime.drainHopperTransferEvents).toStrictEqual([])
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )

  it.effect('keeps per-tick hopper power samples when a batch contains both sides of a power edge', () =>
    Effect.gen(function* () {
      const runtime = yield* RedstoneWorldRuntime
      const position = blockPosition(10, 10, 10)
      const events = [
        hopperTransferEvent(dimensionId('overworld'), position, 1, false),
        hopperTransferEvent(dimensionId('overworld'), position, 1, true),
      ]
      yield* runtime.restoreEvents(emptyEvents({ hopper: events }))
      const currentPowerLookup: RedstoneHostLookup = {
        ...missingLookup,
        readHopperTransferContext: () => ({ powered: true, sourceAbove: null, destinationFacing: null }),
      }
      const { calls, port, realm } = recordingRealm(dimensionId('overworld'), currentPowerLookup)

      yield* applyRedstoneHostEvents(runtime, [realm], port)

      expect(hopperCooldownPlanCallsOf(calls).map(({ request }) => request.ticks)).toStrictEqual([2])
      expect(hopperPlanCallsOf(calls)).toStrictEqual([])
      expect(yield* runtime.drainHopperTransferEvents).toStrictEqual([])
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )

  it.effect('publishes post-commit domain events only after the single world commit succeeds', () =>
    Effect.gen(function* () {
      const runtime = yield* RedstoneWorldRuntime
      const event = hopperTransferEvent(dimensionId('overworld'), blockPosition(10, 10, 10))
      yield* runtime.restoreEvents(emptyEvents({ hopper: [event] }))
      const { calls, port, realm } = recordingRealm(dimensionId('overworld'), missingLookup)
      const eventBus: DomainEventBusApi = {
        events: Stream.empty,
        publish: (published) => Effect.sync(() => calls.push({ kind: 'publish', event: published })),
      }

      yield* applyRedstoneHostEvents(
        runtime,
        [realm],
        postCommitEventPort(port, blockChangedByWorldEvent, eventBus),
      )

      expect(calls.map(({ kind }) => kind)).toStrictEqual(['hopper-cooldown-plan', 'commit', 'publish'])
      expect(calls.filter((call) => call.kind === 'publish')).toStrictEqual([
        { kind: 'publish', event: blockChangedByWorldEvent },
      ])
      expect(yield* runtime.drainHopperTransferEvents).toStrictEqual([])
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )

  it.effect('restores the batch and publishes no domain event when the world commit fails', () =>
    Effect.gen(function* () {
      const runtime = yield* RedstoneWorldRuntime
      const event = hopperTransferEvent(dimensionId('overworld'), blockPosition(10, 10, 10))
      const batch = emptyEvents({ hopper: [event] })
      yield* runtime.restoreEvents(batch)
      const { calls, port, realm } = recordingRealm(dimensionId('overworld'), missingLookup)
      const eventBus: DomainEventBusApi = {
        events: Stream.empty,
        publish: (published) => Effect.sync(() => calls.push({ kind: 'publish', event: published })),
      }
      const failingPort: RedstoneHostWritePort = {
        ...postCommitEventPort(port, blockChangedByWorldEvent, eventBus),
        coordinator: {
          ...port.coordinator,
          commit: (request) => Effect.gen(function* failCommit() {
            yield* Effect.sync(() => calls.push({ kind: 'commit', request }))
            return yield* Effect.fail(new WorldCommitEmptyRequest({}))
          }),
        },
      }

      const result = yield* Effect.result(applyRedstoneHostEvents(runtime, [realm], failingPort))

      expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: 'WorldCommitEmptyRequest' } })
      expect(calls.map(({ kind }) => kind)).toStrictEqual(['hopper-cooldown-plan', 'commit'])
      expect(yield* runtime.drainHopperTransferEvents).toStrictEqual([event])
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )

  it.effect('rejects post-commit events without a bus before commit and restores the batch', () =>
    Effect.gen(function* () {
      const runtime = yield* RedstoneWorldRuntime
      const event = hopperTransferEvent(dimensionId('overworld'), blockPosition(10, 10, 10))
      yield* runtime.restoreEvents(emptyEvents({ hopper: [event] }))
      const { calls, port, realm } = recordingRealm(dimensionId('overworld'), missingLookup)

      const result = yield* Effect.result(applyRedstoneHostEvents(
        runtime,
        [realm],
        postCommitEventPort(port, blockChangedByWorldEvent),
      ))

      expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: 'RedstoneHostEventBusUnavailable' } })
      expect(commitCallsOf(calls)).toStrictEqual([])
      expect(yield* runtime.drainHopperTransferEvents).toStrictEqual([event])
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )

  it.effect('rejects an event-only plan without a world change and restores the batch', () =>
    Effect.gen(function* () {
      const runtime = yield* RedstoneWorldRuntime
      const event = hopperTransferEvent(dimensionId('overworld'), blockPosition(10, 10, 10))
      yield* runtime.restoreEvents(emptyEvents({ hopper: [event] }))
      const { calls, port, realm } = recordingRealm(dimensionId('overworld'), missingLookup)
      const eventBus: DomainEventBusApi = {
        events: Stream.empty,
        publish: (published) => Effect.sync(() => calls.push({ kind: 'publish', event: published })),
      }

      const result = yield* Effect.result(applyRedstoneHostEvents(
        runtime,
        [realm],
        postCommitEventPort(port, blockChangedByWorldEvent, eventBus, false),
      ))

      expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: 'WorldCommitPlanEmpty' } })
      expect(commitCallsOf(calls)).toStrictEqual([])
      expect(calls.filter((call) => call.kind === 'publish')).toStrictEqual([])
      expect(yield* runtime.drainHopperTransferEvents).toStrictEqual([event])
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )

  it.effect('does not restore an already committed batch when event publication fails', () =>
    Effect.gen(function* () {
      const runtime = yield* RedstoneWorldRuntime
      const event = hopperTransferEvent(dimensionId('overworld'), blockPosition(10, 10, 10))
      yield* runtime.restoreEvents(emptyEvents({ hopper: [event] }))
      const { calls, port, realm } = recordingRealm(dimensionId('overworld'), missingLookup)
      const eventBus: DomainEventBusApi = {
        events: Stream.empty,
        publish: (published) => {
          calls.push({ kind: 'publish', event: published })
          return Schema.decodeUnknownEffect(DomainEventSchema)({}).pipe(Effect.asVoid)
        },
      }

      const result = yield* Effect.result(applyRedstoneHostEvents(
        runtime,
        [realm],
        postCommitEventPort(port, blockChangedByWorldEvent, eventBus),
      ))

      expect(Result.isFailure(result)).toBe(true)
      expect(commitCallsOf(calls)).toHaveLength(1)
      expect(calls.filter((call) => call.kind === 'publish')).toHaveLength(1)
      expect(yield* runtime.drainHopperTransferEvents).toStrictEqual([])
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )

  it.effect('restores the complete redstone batch when hopper planning fails before commit', () =>
    Effect.gen(function* () {
      const runtime = yield* RedstoneWorldRuntime
      const first = hopperTransferEvent(dimensionId('overworld'), blockPosition(10, 10, 10))
      const second = hopperTransferEvent(dimensionId('overworld'), blockPosition(11, 10, 10))
      const lamp = { dimension: dimensionId('overworld'), lit: true, position: blockPosition(2, 0, 0) }
      const batch = emptyEvents({ hopper: [first, second], lamp: [lamp] })
      yield* runtime.restoreEvents(batch)
      const { calls, port, realm } = recordingRealm(dimensionId('overworld'), missingLookup)
      let planCount = 0
      const failingPort: RedstoneHostWritePort = {
        ...port,
        hopperService: {
          ...port.hopperService,
          planAdvanceCooldown: (snapshot, request) => {
            planCount += 1
            if (planCount === 2) {
              return Effect.gen(function* failSecondPlan() {
                yield* Effect.sync(() => calls.push({ kind: 'hopper-cooldown-plan', snapshot, request }))
                return yield* Effect.fail(new WorldCommitEmptyRequest({}))
              })
            }
            return port.hopperService.planAdvanceCooldown(snapshot, request)
          },
        },
      }

      const result = yield* Effect.result(applyRedstoneHostEvents(runtime, [realm], failingPort))

      expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: 'WorldCommitEmptyRequest' } })
      expect(commitCallsOf(calls)).toStrictEqual([])
      expect(buildCallsOf(calls)).toHaveLength(1)
      expect(yield* runtime.drainLampTransitions).toStrictEqual([lamp])
      expect(yield* runtime.drainHopperTransferEvents).toStrictEqual([first, second])
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )

  it.effect('REGRESSION: an event for a dimension with no matching realm is dropped, not thrown', () =>
    Effect.gen(function* () {
      const runtime = yield* RedstoneWorldRuntime
      const stages = yield* makeRuntimeRedstoneStages
      const { calls, port, realm } = recordingRealm(dimensionId('nether'), missingLookup)

      yield* runtime.syncSnapshot({ components: mixedComponentsSnapshot, dimension: dimensionId('overworld') })
      for (let tick = 0; tick < TICKS_TO_SETTLE_A_HOPPER; tick += 1) {
        yield* runFrame(stages)
      }

      const failure = yield* Effect.result(applyRedstoneHostEvents(runtime, [realm], port))
      expect(failure).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'RedstoneHostRealmMissing', dimension: dimensionId('overworld') },
      })
      expect(calls).toStrictEqual([])

      const matching = recordingRealm(dimensionId('overworld'), missingLookup)
      yield* applyRedstoneHostEvents(runtime, [matching.realm], matching.port)
      expect(buildCallsOf(matching.calls)).toHaveLength(1)
      expect(commitCallsOf(matching.calls)).toHaveLength(1)
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )

  it.effect(
    "raw note-block and trapdoor blocks reach the single host request",
    () =>
      Effect.gen(function* () {
        const runtime = yield* RedstoneWorldRuntime
        const stages = yield* makeRuntimeRedstoneStages
        const lookup: RedstoneHostLookup = { ...missingLookup, isLeverActive: () => true }
        const { calls, port, realm } = recordingRealm(dimensionId('overworld'), lookup)
        const decodeHostBlockType = Schema.decodeUnknownSync(RedstoneHostBlockTypeSchema)
        const snapshot = snapshotValue(realm, [
          block(decodeHostBlockType('lever'), 0, 0, 0),
          block(decodeHostBlockType('note_block'), 0, 1, 0),
          block(decodeHostBlockType('trapdoor'), 0, -1, 0),
        ])

        expect(snapshot.components).toStrictEqual([
          { active: true, kind: 'lever', position: blockPosition(0, 0, 0) },
          { kind: 'note-block', position: blockPosition(0, 1, 0) },
          { kind: 'trapdoor', position: blockPosition(0, -1, 0) },
        ])
        yield* runtime.syncSnapshot(snapshot)
        yield* runFrame(stages)
        yield* applyRedstoneHostEvents(runtime, [realm], port)

        const [build] = buildCallsOf(calls)
        expect(build?.events.trigger).toContainEqual({
          dimension: dimensionId('overworld'),
          kind: 'note-block',
          position: blockPosition(0, 1, 0),
        })
        expect(build?.events.powered).toContainEqual({
          dimension: dimensionId('overworld'),
          kind: 'trapdoor',
          powered: true,
          position: blockPosition(0, -1, 0),
        })
        expect(commitCallsOf(calls)).toHaveLength(1)

        const later = recordingRealm(dimensionId('overworld'), missingLookup)
        yield* applyRedstoneHostEvents(runtime, [later.realm], later.port)
        expect(later.calls).toStrictEqual([])
      }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )

  it.effect('preflights sticky and normal piston retractions and skips no-op transitions', () =>
    Effect.gen(function* () {
      const runtime = yield* RedstoneWorldRuntime
      const lookup: RedstoneHostLookup = { ...missingLookup, readPistonCell: () => ({ kind: 'empty' }) }
      const { calls, port, realm } = recordingRealm(dimensionId('overworld'), lookup)
      const sticky = {
        dimension: dimensionId('overworld'),
        piston: blockPosition(10, 10, 10),
        facing: 'east' as const,
        kind: 'sticky' as const,
        state: 'extended' as const,
        powered: false,
      }
      yield* runtime.restoreEvents(emptyEvents({ piston: [sticky] }))
      yield* applyRedstoneHostEvents(runtime, [realm], port)
      expect(buildCallsOf(calls)).toHaveLength(1)

      const normal = { ...sticky, kind: 'normal' as const }
      yield* runtime.restoreEvents(emptyEvents({ piston: [normal] }))
      yield* applyRedstoneHostEvents(runtime, [realm], port)
      expect(buildCallsOf(calls)).toHaveLength(2)

      const noOp = { ...normal, powered: true }
      yield* runtime.restoreEvents(emptyEvents({ piston: [noOp] }))
      yield* applyRedstoneHostEvents(runtime, [realm], port)
      expect(buildCallsOf(calls)).toHaveLength(2)
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )

  it.effect('does not commit a piston push into a kernel-immovable block', () =>
    Effect.gen(function* () {
      const runtime = yield* RedstoneWorldRuntime
      const bedrock = 'bedrock'
      const lookup: RedstoneHostLookup = {
        ...missingLookup,
        readPistonCell: () => ({ kind: 'block', block: bedrock }),
      }
      const { calls, port, realm } = recordingRealm(dimensionId('overworld'), lookup)
      const event = {
        dimension: dimensionId('overworld'),
        piston: blockPosition(10, 10, 10),
        facing: 'east' as const,
        kind: 'normal' as const,
        state: 'retracted' as const,
        powered: true,
      }
      yield* runtime.restoreEvents(emptyEvents({ piston: [event] }))

      yield* applyRedstoneHostEvents(runtime, [realm], port)

      expect(calls).toStrictEqual([])
      expect(yield* runtime.drainPistonTransitions).toStrictEqual([])
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )

  it.effect('reports an out-of-range piston cell found after the head preflight', () =>
    Effect.gen(function* () {
      const runtime = yield* RedstoneWorldRuntime
      const stone = 'stone'
      const lookup: RedstoneHostLookup = {
        ...missingLookup,
        readPistonCell: () => ({ kind: 'block', block: stone }),
      }
      const { calls, port, realm } = recordingRealm(dimensionId('overworld'), lookup)
      const event = {
        dimension: dimensionId('overworld'),
        piston: blockPosition(Number.MAX_SAFE_INTEGER - PISTON_PUSH_LIMIT, 0, 0),
        facing: 'east' as const,
        kind: 'normal' as const,
        state: 'retracted' as const,
        powered: true,
      }
      const batch = emptyEvents({ piston: [event] })
      yield* runtime.restoreEvents(batch)

      const failure = yield* Effect.result(applyRedstoneHostEvents(runtime, [realm], port))

      expect(failure).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'RedstoneHostPositionOutOfRange' },
      })
      expect(calls).toStrictEqual([])
      expect(yield* runtime.drainPistonTransitions).toStrictEqual(batch.piston)
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )

  it.effect('REGRESSION: a piston transition planPistonTransition refuses is never committed', () =>
    Effect.gen(function* () {
      const runtime = yield* RedstoneWorldRuntime
      const stages = yield* makeRuntimeRedstoneStages
      // `readPistonCell` reports every cell missing, which makes
      // `planPistonTransition`'s extension scan refuse immediately (`outcome.kind`
      // is `'refused'`, never `'move'`) — `commitPistonPlan` must never fire.
      const { calls, port, realm } = recordingRealm(dimensionId('overworld'), missingLookup)

      yield* runtime.syncSnapshot({
        components: [
          { active: true, kind: 'lever', position: blockPosition(0, 0, 0) },
          {
            kind: 'piston',
            pistonFacing: 'east',
            pistonKind: 'normal',
            pistonState: 'retracted',
            position: blockPosition(1, 0, 0),
          },
        ],
        dimension: dimensionId('overworld'),
      })
      yield* runFrame(stages)
      yield* applyRedstoneHostEvents(runtime, [realm], port)

      expect(buildCallsOf(calls)).toStrictEqual([])
      expect(commitCallsOf(calls)).toStrictEqual([])
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )

  it.effect('REGRESSION: mixed dimensions fail before request building and restore every drained event', () =>
    Effect.gen(function* () {
      const runtime = yield* RedstoneWorldRuntime
      const batch = emptyEvents({
        hopper: [
          hopperTransferEvent(dimensionId('overworld'), blockPosition(1, 0, 0)),
          hopperTransferEvent(dimensionId('nether'), blockPosition(2, 0, 0)),
        ],
      })
      yield* runtime.restoreEvents(batch)
      const { calls, port, realm } = recordingRealm(dimensionId('overworld'), missingLookup)

      const failure = yield* Effect.result(applyRedstoneHostEvents(runtime, [realm], port))

      expect(failure).toMatchObject({ _tag: 'Failure', failure: { _tag: 'RedstoneHostMixedDimensions' } })
      expect(calls).toStrictEqual([])
      expect(yield* runtime.drainHopperTransferEvents).toStrictEqual(batch.hopper)
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )

  it.effect('REGRESSION: an out-of-range piston scan fails with a typed error and restores the piston event', () =>
    Effect.gen(function* () {
      const runtime = yield* RedstoneWorldRuntime
      const event = {
        dimension: dimensionId('overworld'),
        piston: blockPosition(Number.MAX_SAFE_INTEGER, 0, 0),
        facing: 'east' as const,
        kind: 'normal' as const,
        state: 'retracted' as const,
        powered: true,
      }
      const batch = emptyEvents({ piston: [event] })
      yield* runtime.restoreEvents(batch)
      const { calls, port, realm } = recordingRealm(dimensionId('overworld'), missingLookup)

      const failure = yield* Effect.result(applyRedstoneHostEvents(runtime, [realm], port))

      expect(failure).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'RedstoneHostPositionOutOfRange' },
      })
      expect(calls).toStrictEqual([])
      expect(yield* runtime.drainPistonTransitions).toStrictEqual(batch.piston)
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )

  it.effect('REGRESSION: request build and coordinator failures restore the drained batch', () =>
    Effect.gen(function* () {
      const runtime = yield* RedstoneWorldRuntime
      const lamp = { dimension: dimensionId('overworld'), lit: true, position: blockPosition(2, 0, 0) }
      const batch = emptyEvents({
        hopper: [hopperTransferEvent(dimensionId('overworld'), blockPosition(1, 0, 0))],
        lamp: [lamp],
      })
      yield* runtime.restoreEvents(batch)
      const { calls, port, realm } = recordingRealm(dimensionId('overworld'), missingLookup)
      const buildFailurePort: RedstoneHostWritePort<string> = {
        ...port,
        buildCommitRequest: (events, pistonPlans) => {
          calls.push({ kind: 'build', events, pistonPlans })
          return Result.fail('request could not be built')
        },
      }

      const buildFailure = yield* Effect.result(applyRedstoneHostEvents(runtime, [realm], buildFailurePort))
      expect(buildFailure).toStrictEqual(Result.fail('request could not be built'))
      expect(commitCallsOf(calls)).toStrictEqual([])
      expect(yield* runtime.drainHopperTransferEvents).toStrictEqual(batch.hopper)
      expect(yield* runtime.drainLampTransitions).toStrictEqual(batch.lamp)
      expect(hopperCooldownPlanCallsOf(calls)).toStrictEqual([])

      yield* runtime.restoreEvents(batch)
      const commitFailurePort: RedstoneHostWritePort = {
        ...port,
        coordinator: {
          ...port.coordinator,
          commit: (request) =>
          Effect.gen(function* commitFailureGenerator() {
            yield* Effect.sync(() => calls.push({ kind: 'commit', request }))
            return yield* Effect.fail(new WorldCommitEmptyRequest({}))
          }),
        },
      }
      const commitFailure = yield* Effect.result(applyRedstoneHostEvents(runtime, [realm], commitFailurePort))
      expect(commitFailure).toMatchObject({ _tag: 'Failure', failure: { _tag: 'WorldCommitEmptyRequest' } })
      expect(commitCallsOf(calls)).toHaveLength(1)
      expect(yield* runtime.drainHopperTransferEvents).toStrictEqual(batch.hopper)
      expect(yield* runtime.drainLampTransitions).toStrictEqual(batch.lamp)
      expect(hopperCooldownPlanCallsOf(calls)).toHaveLength(1)
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )

  it.effect('restores a drained batch when coordinator commit is interrupted', () =>
    Effect.gen(function* () {
      const runtime = yield* RedstoneWorldRuntime
      const lamp = { dimension: dimensionId('overworld'), lit: true, position: blockPosition(2, 0, 0) }
      const batch = emptyEvents({
        hopper: [hopperTransferEvent(dimensionId('overworld'), blockPosition(1, 0, 0))],
        lamp: [lamp],
      })
      yield* runtime.restoreEvents(batch)
      const { calls, port, realm } = recordingRealm(dimensionId('overworld'), missingLookup)
      const entered = yield* Deferred.make<void>()
      const interruptiblePort: RedstoneHostWritePort = {
        ...port,
        coordinator: {
          ...port.coordinator,
          commit: (request) =>
            Effect.gen(function* commitInterruptibly() {
              yield* Effect.sync(() => calls.push({ kind: 'commit', request }))
              yield* Deferred.succeed(entered, undefined)
              return yield* Effect.never
            }),
        },
      }

      const fiber = yield* applyRedstoneHostEvents(runtime, [realm], interruptiblePort).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(fiber)

      expect(commitCallsOf(calls)).toHaveLength(1)
      expect(yield* runtime.drainHopperTransferEvents).toStrictEqual(batch.hopper)
      expect(yield* runtime.drainLampTransitions).toStrictEqual(batch.lamp)
      expect(hopperCooldownPlanCallsOf(calls)).toHaveLength(1)
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
            const { calls, port, realm } = recordingRealm(dimensionId('overworld'), missingLookup)

            const snapshot = snapshotValue(realm, [
              block('lever', 0, 0, 0),
              block('redstone_wire', 1, 0, 0),
              block('redstone_lamp', 2, 0, 0),
              block('hopper', 0, 1, 0),
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
              yield* applyRedstoneHostEvents(runtime, [realm], port)
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
