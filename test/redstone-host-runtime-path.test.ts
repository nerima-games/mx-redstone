import { describe, expect, it } from '@effect/vitest'
import {
  BlockAddressSchema,
  BlockPositionSchema,
  DimensionIdSchema,
  NonNegativeTickCount,
  WorldIdSchema,
  WorldWriteBatchSchema,
  blockIdOf,
  encodeBlockState,
  isBlockType,
  type BlockAddress,
  type BlockPosition,
  type StageRegistration,
} from '@nerima-games/mc-kernel'
import {
  CONTAINER_STORAGE_SNAPSHOT_VERSION,
  HOPPER_REPLICATED_OWNER_ID,
  ReplicatedOwnerIdSchema,
  type HopperCooldownPlanRequest,
  type HopperServiceSnapshot,
  type HopperTransferOutcome,
  type HopperTransferTickPlanState,
  type WorldCommitPlanSnapshot,
  type WorldCommitRequest,
  runStagesForTicks,
  type RunStagesForTicksFailure,
  itemStack,
  type Container,
} from '@nerima-games/mc-sim'
import { Effect, Option, Result, Schema } from 'effect'
import {
  applyRedstoneHostEvents,
  componentForBlock,
  redstoneSnapshotFromRealm,
  RedstoneHostBlockTypeSchema,
  type RedstoneHostBlock,
  type RedstoneHostBlockType,
  type RedstoneHostLookup,
  type RedstoneHostRealm,
  type RedstoneHostWritePort,
} from '../src/application/redstone-host-port'
import {
  RedstoneWorldRuntime,
  RedstoneWorldRuntimeLayer,
  redstoneNodeId,
  redstoneTickObservationsFor,
  setRedstoneObservationEnabled,
  type RedstoneEventBatch,
} from '../src/application/world-runtime'
import { planDispenserAction } from '../src/domain/dispenser'
import { ContainerSlotSchema } from '../src/domain/comparator'
import type { PistonMovementPlan } from '../src/domain/piston'
import { makeRuntimeRedstoneStages } from '../src/stages/registration'
// eslint-disable-next-line sort-imports
import { FrameServicesLayer } from './frame-services'

type RedstoneDimensionId = BlockAddress['dimension']

const testWorldId = Schema.decodeUnknownSync(WorldIdSchema)('redstone-host-runtime-path')
const HOPPER_BLOCK_ID = Option.getOrThrow(blockIdOf('hopper'))

const dimensionId = (value: string): RedstoneDimensionId =>
  Schema.decodeUnknownSync(DimensionIdSchema)(value)

const blockPosition = (x: number, y = 0, z = 0): BlockPosition =>
  Schema.decodeUnknownSync(BlockPositionSchema)({ x, y, z })

const blockAddress = (
  x: number,
  y = 0,
  z = 0,
  dimension: RedstoneDimensionId = dimensionId('overworld'),
): BlockAddress =>
  Schema.decodeUnknownSync(BlockAddressSchema)({
    dimension,
    position: { x, y, z },
  })

const successValue = <Value, Failure>(result: Result.Result<Value, Failure>): Value => {
  if (Result.isFailure(result)) {
    throw new Error('Expected a successful Result')
  }
  return result.success
}

const encodedStateFor = (name: RedstoneHostBlockType | null, state: unknown = {}): unknown => {
  if (name === null || !isBlockType(name) || !['comparator', 'dispenser', 'dropper', 'hopper', 'observer', 'piston', 'redstone_torch', 'repeater'].includes(name)) {
    return undefined
  }
  const blockId = Option.getOrUndefined(blockIdOf(name))
  if (typeof blockId === 'undefined') {
    throw new Error(`Missing kernel block ID for ${name}`)
  }
  return successValue(encodeBlockState(blockId, state))
}

const block = (
  name: RedstoneHostBlockType,
  x = 0,
  y = 0,
  z = 0,
  strongPowerTo?: BlockPosition,
  dimension: RedstoneDimensionId = dimensionId('overworld'),
): RedstoneHostBlock => {
  const encodedState = encodedStateFor(name)
  return {
    address: blockAddress(x, y, z, dimension),
    block: Schema.decodeUnknownSync(RedstoneHostBlockTypeSchema)(name),
    ...(encodedState === undefined ? {} : { encodedState }),
    ...(strongPowerTo === undefined ? {} : { strongPowerTo }),
  }
}

const blockWithState = (
  name: RedstoneHostBlockType,
  x: number,
  y: number,
  z: number,
  state: unknown,
): RedstoneHostBlock => ({
  ...block(name, x, y, z),
  encodedState: encodedStateFor(name, state),
})

type RecordedCall =
  | {
      readonly kind: 'build'
      readonly events: RedstoneEventBatch
      readonly pistonPlans: ReadonlyArray<PistonMovementPlan>
    }
  | { readonly kind: 'commit'; readonly request: WorldCommitRequest }
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

const callsOf = <Kind extends RecordedCall['kind']>(calls: ReadonlyArray<RecordedCall>, kind: Kind) =>
  calls.filter((call): call is Extract<RecordedCall, { readonly kind: Kind }> => call.kind === kind)

const recordingRealm = (
  lookup: RedstoneHostLookup,
): {
  readonly calls: Array<RecordedCall>
  readonly port: RedstoneHostWritePort
  readonly realm: RedstoneHostRealm
} => {
  const calls: Array<RecordedCall> = []
  const dimension = dimensionId('overworld')
  const revisions = Schema.decodeUnknownSync(WorldWriteBatchSchema)({
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
      const request: WorldCommitRequest = {
        expectedRevision: revisions.expectedWorldRevision,
        expectedDimensions: [{ dimension: revisions.dimension, expectedRevision: revisions.expectedDimensionRevision }],
        changes: [{
          ownerId: Schema.decodeUnknownSync(ReplicatedOwnerIdSchema)('redstone-host-runtime-path-owner'),
          state: { events, pistonPlans },
        }],
      }
      return Result.succeed(request)
    },
    buildHopperBlockWrite: (event, blockId, expected) =>
      Result.succeed(Schema.decodeUnknownSync(WorldWriteBatchSchema)({
        world: testWorldId,
        expectedWorldRevision: expected.expectedRevision,
        dimension: event.dimension,
        expectedDimensionRevision: expected.expectedDimensionRevision,
        edits: [{ position: event.position, block: blockId }],
      })),
    coordinator: {
      worldId: testWorldId,
      revision: Effect.succeed(revisions.expectedWorldRevision),
      dimensionRevision: () => Effect.succeed(revisions.expectedDimensionRevision),
      snapshot: (ownerId, schema) => {
        const state = ownerId === HOPPER_REPLICATED_OWNER_ID
          ? { hoppers: [] }
          : { version: CONTAINER_STORAGE_SNAPSHOT_VERSION, containers: [] }
        return Schema.decodeUnknownEffect(schema)(state).pipe(
          Effect.map((decodedState) => ({
            world: testWorldId,
            revision: revisions.expectedWorldRevision,
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

const runFrame = (stages: ReadonlyArray<StageRegistration>): Effect.Effect<void, RunStagesForTicksFailure> =>
  runStagesForTicks(stages, NonNegativeTickCount(2)).pipe(Effect.provide(FrameServicesLayer))

const makeDispenser = (kind: 'dispenser' | 'dropper', withArrow: boolean): Container => {
  const slots: Array<Container['slots'][number]> = Array.from({ length: 9 }, () => null)
  if (withArrow) {
    slots[3] = { ...successValue(itemStack('arrow', 2)), durability: null }
  }
  return { id: `host-${kind}`, kind, slots }
}

describe('raw host block to host request', () => {
  it.effect('passes only local conductivity reads from the requested realm into solid-backed power', () =>
    Effect.gen(function* () {
      // Fails if the host scans world blocks or the runtime loses a source's placement target.
      const dimension = dimensionId('nether')
      const supportPosition = blockPosition(0, -1, 0)
      const wirePosition = blockPosition(0, -2, 0)
      const conductivityReads: Array<Readonly<{ dimension: RedstoneDimensionId; position: BlockPosition }>> = []
      const lookup: RedstoneHostLookup = {
        isLeverActive: () => true,
        isPoweredRailPowered: () => false,
        isRedstoneConductiveAt: (position) => {
          conductivityReads.push({ dimension, position })
          return dimension === dimensionId('nether')
            && position.x === supportPosition.x
            && position.y === supportPosition.y
            && position.z === supportPosition.z
        },
        readContainerSlots: () => undefined,
        readHopperBlockId: () => HOPPER_BLOCK_ID,
        readHopperTransferContext: () => ({ powered: false, sourceAbove: null, destinationFacing: null }),
        readPistonCell: () => ({ kind: 'empty' }),
      }
      const realm: RedstoneHostRealm = { dimension, lookup }
      const rawBlocks = [
        block('lever', 0, 0, 0, supportPosition, dimension),
        block('redstone_wire', wirePosition.x, wirePosition.y, wirePosition.z, undefined, dimension),
      ]
      const snapshot = successValue(redstoneSnapshotFromRealm(realm, rawBlocks))

      expect(snapshot.dimension).toBe(dimension)
      expect(snapshot.components).toContainEqual({
        active: true,
        kind: 'lever',
        position: blockPosition(0, 0, 0),
        strongPowerTo: supportPosition,
      })
      expect(conductivityReads).toStrictEqual([])

      const runtime = yield* RedstoneWorldRuntime
      const stages = yield* makeRuntimeRedstoneStages
      const isRedstoneConductiveAt = lookup.isRedstoneConductiveAt
      if (typeof isRedstoneConductiveAt === 'undefined') {
        throw new Error('Expected the realm conductivity lookup')
      }
      yield* runtime.syncSnapshot(snapshot, { isRedstoneConductiveAt })
      yield* setRedstoneObservationEnabled(runtime, true)
      yield* runFrame(stages)

      const observations = yield* redstoneTickObservationsFor(runtime)
      expect(observations).toHaveLength(1)
      expect(observations[0]?.power.get(redstoneNodeId(dimension, wirePosition))).toBe(15)
      expect(conductivityReads).toContainEqual({ dimension, position: supportPosition })
      expect(new Set(conductivityReads.map(({ position: { x, y, z } }) => `${x},${y},${z}`)).size)
        .toBe(conductivityReads.length)
      expect(conductivityReads.every((read) => read.dimension === dimension)).toBe(true)
      expect(conductivityReads.length).toBeLessThanOrEqual(12)
      expect(conductivityReads).not.toContainEqual({ dimension, position: blockPosition(200, 200, 200) })
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )

  it.effect('maps every supported raw block through runtime and stages into ordered host requests', () =>
    Effect.gen(function* () {
      // Fails if a raw block is misclassified, a runtime transition is dropped or reordered, or an empty drain commits again.
      const slot = Schema.decodeUnknownSync(ContainerSlotSchema)({ count: 32, maxStack: 64 })
      const hopperPosition = blockPosition(40, 0, 0)
      const hopperContextReads: Array<BlockPosition> = []
      const lookup: RedstoneHostLookup = {
        isLeverActive: () => true,
        isPoweredRailPowered: () => false,
        readContainerSlots: (position) => {
          expect(position).toStrictEqual(blockPosition(30, 0, 1))
          return [slot]
        },
        readHopperBlockId: () => HOPPER_BLOCK_ID,
        readHopperTransferContext: (position) => {
          hopperContextReads.push(position)
          return { powered: false, sourceAbove: null, destinationFacing: null }
        },
        readPistonCell: () => ({ kind: 'empty' }),
      }
      const { calls, port, realm } = recordingRealm(lookup)
      const rawBlocks = [
        block('lever', 0, 0, 0),
        block('redstone_wire', 1, 0, 0),
        block('redstone_lamp', 2, 0, 0),
        blockWithState('comparator', 30, 0, 0, { facing: 'north', mode: 'compare', powered: false }),
        blockWithState('piston', 0, 0, -1, { facing: 'south', extended: false }),
        block('hopper', hopperPosition.x, hopperPosition.y, hopperPosition.z),
        block('dispenser', -1, 0, 0),
        block('dropper', 0, 1, 0),
        block('powered_rail', 10, 1, 0),
        block('door', 0, -1, 0),
        block('note_block', 10, 0, -1),
        block('trapdoor', 9, 0, 0),
        block('lever', 10, 0, 0),
      ]
      const mappedComponents = rawBlocks.flatMap(({ address, block: blockType, encodedState }) => {
        const component = successValue(componentForBlock(lookup, blockType, {
          position: address.position,
          ...(encodedState === undefined ? {} : { encodedState }),
        }))
        return typeof component === 'undefined' ? [] : [component]
      })
      const snapshot = successValue(redstoneSnapshotFromRealm(realm, rawBlocks))

      expect(snapshot).toStrictEqual({
        components: [
          { active: true, kind: 'lever', position: blockPosition(0, 0, 0) },
          { kind: 'wire', position: blockPosition(1, 0, 0) },
          { kind: 'lamp', position: blockPosition(2, 0, 0) },
          {
            containerSlots: [slot],
            facing: 'north',
            inputFrom: blockPosition(30, 0, 1),
            kind: 'comparator',
            mode: 'compare',
            outputTo: blockPosition(30, 0, -1),
            position: blockPosition(30, 0, 0),
            powered: false,
            sideInputs: [blockPosition(29, 0, 0), blockPosition(31, 0, 0)],
          },
          {
            kind: 'piston',
            pistonFacing: 'south',
            pistonKind: 'normal',
            pistonState: 'retracted',
            position: blockPosition(0, 0, -1),
          },
          { enabled: true, facing: 'down', kind: 'hopper', position: hopperPosition },
          { facing: 'north', kind: 'dispenser', position: blockPosition(-1, 0, 0), triggered: false },
          { facing: 'north', kind: 'dropper', position: blockPosition(0, 1, 0), triggered: false },
          { kind: 'powered-rail', powered: false, position: blockPosition(10, 1, 0) },
          { kind: 'door', position: blockPosition(0, -1, 0) },
          { kind: 'note-block', position: blockPosition(10, 0, -1) },
          { kind: 'trapdoor', position: blockPosition(9, 0, 0) },
          { active: true, kind: 'lever', position: blockPosition(10, 0, 0) },
        ],
        dimension: dimensionId('overworld'),
      })
      expect(snapshot.components).toStrictEqual(mappedComponents)

      const runtime = yield* RedstoneWorldRuntime
      const stages = yield* makeRuntimeRedstoneStages
      yield* runtime.syncSnapshot(snapshot)
      yield* runFrame(stages)
      yield* applyRedstoneHostEvents(runtime, [realm], port)

      const [build] = callsOf(calls, 'build')
      const [commit] = callsOf(calls, 'commit')
      const expectedEvents: RedstoneEventBatch = {
        hopper: [],
        lamp: [{ dimension: dimensionId('overworld'), lit: true, position: blockPosition(2, 0, 0) }],
        piston: [{
          dimension: dimensionId('overworld'),
          facing: 'south',
          kind: 'normal',
          piston: blockPosition(0, 0, -1),
          powered: true,
          state: 'retracted',
        }],
        // This catches PositionKey string order putting x=10 before x=9 in the canonical numeric order.
        powered: [
          { dimension: dimensionId('overworld'), kind: 'door', powered: true, position: blockPosition(0, -1, 0) },
          { dimension: dimensionId('overworld'), kind: 'trapdoor', powered: true, position: blockPosition(9, 0, 0) },
          { dimension: dimensionId('overworld'), kind: 'powered-rail', powered: true, position: blockPosition(10, 1, 0) },
        ],
        trigger: [
          { dimension: dimensionId('overworld'), facing: 'north', kind: 'dispenser', position: blockPosition(-1, 0, 0) },
          { dimension: dimensionId('overworld'), facing: 'north', kind: 'dropper', position: blockPosition(0, 1, 0) },
          { dimension: dimensionId('overworld'), kind: 'note-block', position: blockPosition(10, 0, -1) },
        ],
      }
      expect(callsOf(calls, 'build')).toHaveLength(1)
      expect(build?.events).toStrictEqual(expectedEvents)
      expect(build?.pistonPlans).toMatchObject([{
        facing: 'south',
        fromState: 'retracted',
        kind: 'normal',
        moves: [],
        piston: blockPosition(0, 0, -1),
        toState: 'extended',
      }])
      expect(callsOf(calls, 'commit')).toHaveLength(1)
      expect(commit?.request.changes[0]?.state).toStrictEqual({
        events: expectedEvents,
        pistonPlans: build?.pistonPlans,
      })
      expect(hopperContextReads).toStrictEqual([hopperPosition])
      expect(callsOf(calls, 'hopper-cooldown-plan').map(({ request }) => request.ticks)).toStrictEqual([2])
      expect(callsOf(calls, 'hopper-plan')).toStrictEqual([])

      const callsAfterCommit = calls.length
      yield* applyRedstoneHostEvents(runtime, [realm], port)
      expect(calls).toHaveLength(callsAfterCommit)

      const inventory = makeDispenser('dispenser', true)
      const inventoryBefore = { ...inventory, slots: inventory.slots.map((stack) => stack === null ? null : { ...stack }) }
      expect(planDispenserAction(inventory, 3)).toStrictEqual(Result.succeed({
        _tag: 'SpawnArrow',
        count: 1,
        item: 'arrow',
        slot: 3,
      }))
      expect(inventory).toStrictEqual(inventoryBefore)
      expect(planDispenserAction(makeDispenser('dispenser', false), 8)).toStrictEqual(
        Result.fail({ _tag: 'EmptySlot', slot: 8 }),
      )
      expect(planDispenserAction(makeDispenser('dropper', true), 3)).toStrictEqual(
        Result.fail({ _tag: 'NotDispenser' }),
      )
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )

  it.effect('passes a raw comparator reading into its numeric output and ordered lamp request', () =>
    Effect.gen(function* () {
      // Fails if raw container slots stop before the comparator emits their level and powers the output.
      const slot = Schema.decodeUnknownSync(ContainerSlotSchema)({ count: 32, maxStack: 64 })
      const comparatorPosition = blockPosition(30, 0, 0)
      const outputWirePosition = blockPosition(30, 0, -1)
      const lampPosition = blockPosition(30, 0, -2)
      const lookup: RedstoneHostLookup = {
        isLeverActive: () => false,
        isPoweredRailPowered: () => false,
        readContainerSlots: (position) => {
          expect(position).toStrictEqual(blockPosition(30, 0, 1))
          return [slot]
        },
        readHopperBlockId: () => HOPPER_BLOCK_ID,
        readHopperTransferContext: () => ({ powered: false, sourceAbove: null, destinationFacing: null }),
        readPistonCell: () => ({ kind: 'empty' }),
      }
      const { calls, port, realm } = recordingRealm(lookup)
      const rawBlocks = [
        blockWithState('comparator', comparatorPosition.x, comparatorPosition.y, comparatorPosition.z, {
          facing: 'north',
          mode: 'compare',
          powered: false,
        }),
        block('redstone_wire', outputWirePosition.x, outputWirePosition.y, outputWirePosition.z),
        block('redstone_lamp', lampPosition.x, lampPosition.y, lampPosition.z),
      ]
      const snapshot = successValue(redstoneSnapshotFromRealm(realm, rawBlocks))

      expect(snapshot).toStrictEqual({
        components: [
          {
            containerSlots: [slot],
            facing: 'north',
            inputFrom: blockPosition(30, 0, 1),
            kind: 'comparator',
            mode: 'compare',
            outputTo: outputWirePosition,
            position: comparatorPosition,
            powered: false,
            sideInputs: [blockPosition(29, 0, 0), blockPosition(31, 0, 0)],
          },
          { kind: 'wire', position: outputWirePosition },
          { kind: 'lamp', position: lampPosition },
        ],
        dimension: dimensionId('overworld'),
      })

      const runtime = yield* RedstoneWorldRuntime
      const stages = yield* makeRuntimeRedstoneStages
      yield* runtime.syncSnapshot(snapshot)
      yield* setRedstoneObservationEnabled(runtime, true)
      yield* runFrame(stages)
      yield* applyRedstoneHostEvents(runtime, [realm], port)

      const observations = yield* redstoneTickObservationsFor(runtime)
      expect(observations).toHaveLength(1)
      expect(observations[0]?.power.get(redstoneNodeId(dimensionId('overworld'), comparatorPosition))).toBe(8)

      const [build] = callsOf(calls, 'build')
      const [commit] = callsOf(calls, 'commit')
      const expectedEvents: RedstoneEventBatch = {
        hopper: [],
        lamp: [{ dimension: dimensionId('overworld'), lit: true, position: lampPosition }],
        piston: [],
        powered: [],
        trigger: [],
      }
      expect(callsOf(calls, 'build')).toHaveLength(1)
      expect(build?.events).toStrictEqual(expectedEvents)
      expect(build?.pistonPlans).toStrictEqual([])
      expect(callsOf(calls, 'commit')).toHaveLength(1)
      expect(commit?.request.changes[0]?.state).toStrictEqual({ events: expectedEvents, pistonPlans: [] })
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )

  it.effect('uses encoded repeater facing and delay during simulation-tick advances', () =>
    Effect.gen(function* () {
      const lookup: RedstoneHostLookup = {
        isLeverActive: () => true,
        isPoweredRailPowered: () => false,
        readContainerSlots: () => undefined,
        readHopperBlockId: () => HOPPER_BLOCK_ID,
        readHopperTransferContext: () => ({ powered: false, sourceAbove: null, destinationFacing: null }),
        readPistonCell: () => ({ kind: 'empty' }),
      }
      const { realm } = recordingRealm(lookup)
      const repeaterPosition = blockPosition(1, 0, 0)
      const snapshot = successValue(redstoneSnapshotFromRealm(realm, [
        block('lever', 0, 0, 0),
        blockWithState('repeater', repeaterPosition.x, repeaterPosition.y, repeaterPosition.z, {
          delay: 2,
          facing: 'east',
          locked: false,
          powered: false,
        }),
        block('redstone_wire', 2, 0, 0),
        block('redstone_lamp', 3, 0, 0),
      ]))
      expect(snapshot.components.find(({ kind }) => kind === 'repeater')).toMatchObject({
        delayTicks: 2,
        facing: 'east',
        inputFrom: blockPosition(0, 0, 0),
        kind: 'repeater',
        outputTo: blockPosition(2, 0, 0),
      })

      const runtime = yield* RedstoneWorldRuntime
      const stages = yield* makeRuntimeRedstoneStages
      yield* runtime.syncSnapshot(snapshot)
      yield* setRedstoneObservationEnabled(runtime, true)
      const outputPower: Array<number | undefined> = []
      for (let tick = 0; tick < 3; tick += 1) {
        yield* runFrame(stages)
        const observations = yield* redstoneTickObservationsFor(runtime)
        outputPower.push(observations.at(-1)?.power.get(redstoneNodeId(dimensionId('overworld'), repeaterPosition)) ?? 0)
      }
      expect(outputPower).toStrictEqual([0, 0, 15])
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )

  it.effect('holds and releases an encoded repeater lock across simulation-tick advances', () =>
    Effect.gen(function* () {
      const lookup: RedstoneHostLookup = {
        isLeverActive: () => true,
        isPoweredRailPowered: () => false,
        readContainerSlots: () => undefined,
        readHopperBlockId: () => HOPPER_BLOCK_ID,
        readHopperTransferContext: () => ({ powered: false, sourceAbove: null, destinationFacing: null }),
        readPistonCell: () => ({ kind: 'empty' }),
      }
      const { realm } = recordingRealm(lookup)
      const repeaterPosition = blockPosition(1, 0, 0)
      const snapshotFor = (inputOn: boolean, locked: boolean) => successValue(redstoneSnapshotFromRealm(realm, [
        ...(inputOn ? [block('lever', 0, 0, 0)] : []),
        blockWithState('repeater', repeaterPosition.x, repeaterPosition.y, repeaterPosition.z, {
          delay: 2,
          facing: 'east',
          locked,
          powered: false,
        }),
        block('redstone_wire', 2, 0, 0),
      ]))
      const unlockedWithInput = snapshotFor(true, false)
      const lockedWithoutInput = snapshotFor(false, true)
      const unlockedWithoutInput = snapshotFor(false, false)
      expect(lockedWithoutInput.components.find(({ kind }) => kind === 'repeater')).toMatchObject({
        delayTicks: 2,
        facing: 'east',
        inputFrom: blockPosition(0, 0, 0),
        locked: true,
        outputTo: blockPosition(2, 0, 0),
      })

      const runtime = yield* RedstoneWorldRuntime
      const stages = yield* makeRuntimeRedstoneStages
      yield* runtime.syncSnapshot(unlockedWithInput)
      yield* setRedstoneObservationEnabled(runtime, true)
      const outputPower: Array<number> = []
      for (let tick = 0; tick < 3; tick += 1) {
        yield* runFrame(stages)
        const observations = yield* redstoneTickObservationsFor(runtime)
        outputPower.push(observations.at(-1)?.power.get(redstoneNodeId(dimensionId('overworld'), repeaterPosition)) ?? 0)
      }

      yield* runtime.syncSnapshot(lockedWithoutInput)
      for (let tick = 0; tick < 2; tick += 1) {
        yield* runFrame(stages)
        const observations = yield* redstoneTickObservationsFor(runtime)
        outputPower.push(observations.at(-1)?.power.get(redstoneNodeId(dimensionId('overworld'), repeaterPosition)) ?? 0)
      }

      yield* runtime.syncSnapshot(unlockedWithoutInput)
      for (let tick = 0; tick < 2; tick += 1) {
        yield* runFrame(stages)
        const observations = yield* redstoneTickObservationsFor(runtime)
        outputPower.push(observations.at(-1)?.power.get(redstoneNodeId(dimensionId('overworld'), repeaterPosition)) ?? 0)
      }

      expect(outputPower).toStrictEqual([0, 0, 15, 15, 15, 15, 0])
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )

  it.effect('applies the encoded comparator facing and subtraction mode after one simulation tick', () =>
    Effect.gen(function* () {
      const comparatorPosition = blockPosition(1, 0, 0)
      const fullContainerSlots = Array.from(
        { length: 27 },
        () => Schema.decodeUnknownSync(ContainerSlotSchema)({ count: 64, maxStack: 64 }),
      )
      const lookup: RedstoneHostLookup = {
        isLeverActive: () => true,
        isPoweredRailPowered: () => false,
        readContainerSlots: (position) => {
          expect(position).toStrictEqual(blockPosition(0, 0, 0))
          return fullContainerSlots
        },
        readHopperBlockId: () => HOPPER_BLOCK_ID,
        readHopperTransferContext: () => ({ powered: false, sourceAbove: null, destinationFacing: null }),
        readPistonCell: () => ({ kind: 'empty' }),
      }
      const { realm } = recordingRealm(lookup)
      const snapshot = successValue(redstoneSnapshotFromRealm(realm, [
        block('chest', 0, 0, 0),
        blockWithState('comparator', comparatorPosition.x, comparatorPosition.y, comparatorPosition.z, {
          facing: 'east',
          mode: 'subtract',
          powered: false,
        }),
        block('lever', 1, 0, 1),
        block('redstone_wire', 2, 0, 0),
      ]))
      expect(snapshot.components.find(({ kind }) => kind === 'comparator')).toMatchObject({
        containerSlots: fullContainerSlots,
        facing: 'east',
        inputFrom: blockPosition(0, 0, 0),
        kind: 'comparator',
        mode: 'subtract',
        outputTo: blockPosition(2, 0, 0),
        sideInputs: [blockPosition(1, 0, -1), blockPosition(1, 0, 1)],
      })

      const runtime = yield* RedstoneWorldRuntime
      const stages = yield* makeRuntimeRedstoneStages
      yield* runtime.syncSnapshot(snapshot)
      yield* setRedstoneObservationEnabled(runtime, true)
      const outputPower: Array<number | undefined> = []
      for (let tick = 0; tick < 2; tick += 1) {
        yield* runFrame(stages)
        const observations = yield* redstoneTickObservationsFor(runtime)
        outputPower.push(observations.at(-1)?.power.get(redstoneNodeId(dimensionId('overworld'), comparatorPosition)) ?? 0)
      }
      expect(outputPower).toStrictEqual([15, 0])
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )

  it.effect('inverts an encoded floor torch from power at its supporting block', () =>
    Effect.gen(function* () {
      const torchPosition = blockPosition(0, 0, 0)
      const supportPosition = blockPosition(0, -1, 0)
      const isRedstoneConductiveAt = (position: BlockPosition): boolean =>
        position.x === supportPosition.x && position.y === supportPosition.y && position.z === supportPosition.z
      const lookup: RedstoneHostLookup = {
        isRedstoneConductiveAt,
        isLeverActive: () => true,
        isPoweredRailPowered: () => false,
        readContainerSlots: () => undefined,
        readHopperBlockId: () => HOPPER_BLOCK_ID,
        readHopperTransferContext: () => ({ powered: false, sourceAbove: null, destinationFacing: null }),
        readPistonCell: () => ({ kind: 'empty' }),
      }
      const { realm } = recordingRealm(lookup)
      const snapshot = successValue(redstoneSnapshotFromRealm(realm, [
        blockWithState('redstone_torch', torchPosition.x, torchPosition.y, torchPosition.z, { lit: true }),
        block('lever', 1, -1, 0, supportPosition),
        block('redstone_wire', 0, 0, 1),
      ]))
      expect(snapshot.components.find(({ kind }) => kind === 'torch')).toMatchObject({
        active: true,
        invertedBy: supportPosition,
        kind: 'torch',
      })

      const runtime = yield* RedstoneWorldRuntime
      const stages = yield* makeRuntimeRedstoneStages
      yield* runtime.syncSnapshot(snapshot, { isRedstoneConductiveAt })
      yield* setRedstoneObservationEnabled(runtime, true)
      const outputPower: Array<number> = []
      for (let tick = 0; tick < 2; tick += 1) {
        yield* runFrame(stages)
        const observations = yield* redstoneTickObservationsFor(runtime)
        outputPower.push(observations.at(-1)?.power.get(redstoneNodeId(dimensionId('overworld'), torchPosition)) ?? 0)
      }
      expect(outputPower).toStrictEqual([15, 0])
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )

  it.effect('keeps an encoded unlit floor torch off while its support is already powered', () =>
    Effect.gen(function* () {
      const torchPosition = blockPosition(0, 0, 0)
      const supportPosition = blockPosition(0, -1, 0)
      const isRedstoneConductiveAt = (position: BlockPosition): boolean =>
        position.x === supportPosition.x && position.y === supportPosition.y && position.z === supportPosition.z
      const lookup: RedstoneHostLookup = {
        isRedstoneConductiveAt,
        isLeverActive: () => true,
        isPoweredRailPowered: () => false,
        readContainerSlots: () => undefined,
        readHopperBlockId: () => HOPPER_BLOCK_ID,
        readHopperTransferContext: () => ({ powered: false, sourceAbove: null, destinationFacing: null }),
        readPistonCell: () => ({ kind: 'empty' }),
      }
      const { realm } = recordingRealm(lookup)
      const poweredSupport = successValue(redstoneSnapshotFromRealm(realm, [
        block('stone', supportPosition.x, supportPosition.y, supportPosition.z),
        block('lever', 1, -1, 0, supportPosition),
      ]))
      const unlitTorch = successValue(redstoneSnapshotFromRealm(realm, [
        block('stone', supportPosition.x, supportPosition.y, supportPosition.z),
        blockWithState('redstone_torch', torchPosition.x, torchPosition.y, torchPosition.z, { lit: false }),
        block('lever', 1, -1, 0, supportPosition),
        block('redstone_wire', 0, 0, 1),
      ]))
      expect(unlitTorch.components.find(({ kind }) => kind === 'torch')).toMatchObject({
        active: false,
        invertedBy: supportPosition,
        kind: 'torch',
      })

      const runtime = yield* RedstoneWorldRuntime
      const stages = yield* makeRuntimeRedstoneStages
      yield* runtime.syncSnapshot(poweredSupport, { isRedstoneConductiveAt })
      yield* setRedstoneObservationEnabled(runtime, true)
      yield* runFrame(stages)
      yield* runtime.syncSnapshot(unlitTorch, { isRedstoneConductiveAt })
      const outputPower: Array<number> = []
      for (let tick = 0; tick < 2; tick += 1) {
        yield* runFrame(stages)
        const observations = yield* redstoneTickObservationsFor(runtime)
        outputPower.push(observations.at(-1)?.power.get(redstoneNodeId(dimensionId('overworld'), torchPosition)) ?? 0)
      }
      expect(outputPower).toStrictEqual([0, 0])
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )

  it('returns a typed failure when kernel state data cannot identify a sticky piston', () => {
    const lookup: RedstoneHostLookup = {
      isLeverActive: () => false,
      isPoweredRailPowered: () => false,
      readContainerSlots: () => undefined,
      readHopperBlockId: () => HOPPER_BLOCK_ID,
      readHopperTransferContext: () => ({ powered: false, sourceAbove: null, destinationFacing: null }),
      readPistonCell: () => ({ kind: 'empty' }),
    }
    const realm = { dimension: dimensionId('overworld'), lookup }
    const rawBlocks = [block('sticky_piston')]

    expect(redstoneSnapshotFromRealm(realm, rawBlocks)).toStrictEqual(Result.fail({
      _tag: 'RedstoneHostUnsupportedBlockState',
      block: 'sticky_piston',
    }))
  })
})
