import {
  blockIdOf,
  BlockAddressSchema,
  chunkCoordOfBlock,
  CHUNK_SIZE_XZ,
  WorldIdSchema,
  WorldRevisionSchema,
  WorldWriteBatchSchema,
  type BlockAddress,
  type WorldRevision,
  type WorldWriteBatch,
} from '@nerima-games/mc-kernel'
import { ChunkCapacity, makeChunkStore } from '@nerima-games/mc-worldgen'
import { emptyBlocks } from '@nerima-games/mc-worldgen/testing'
import {
  CONTAINER_STORAGE_REPLICATED_OWNER_ID,
  CONTAINER_STORAGE_SNAPSHOT_VERSION,
  ContainerStorageService,
  ContainerStorageSnapshotSchema,
  containerCapacity,
  containerStorageOwnerRegistration,
  HopperServiceErrorSchema,
  HopperServiceSnapshotSchema,
  HopperTransferOutcomeSchema,
  hopperOwnerRegistration,
  INITIAL_HOPPER_SERVICE_SNAPSHOT,
  itemStack,
  makeContainerStorageService,
  makeHopperService,
  makeWorldCommitCoordinator,
  WorldCommitCoordinator,
  WorldReadSnapshotSchema,
  worldContainerIdAt,
  type Container,
  type HopperTransferRequest,
} from '@nerima-games/mc-sim'
import * as fc from 'fast-check'
import { Effect, Option, Result, Schema } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  selectHopperTransferCandidates,
  type HopperTransferCandidate,
} from '../src/domain/hopper.js'

const PROPERTY_RUN_COUNT = 32
const CHUNK_BIOME_COUNT = CHUNK_SIZE_XZ * CHUNK_SIZE_XZ
const strictDecode = { onExcessProperty: 'error' } as const
const HOPPER_BLOCK_ID = Option.getOrThrow(blockIdOf('hopper'))
const TEST_WORLD_ID = Schema.decodeUnknownSync(WorldIdSchema)('redstone-hopper-transfer-property')
const HOPPER_ADDRESS: BlockAddress = Schema.decodeUnknownSync(BlockAddressSchema)({
  dimension: 'overworld',
  position: { x: 0, y: 64, z: 0 },
})
const CHEST_ADDRESS: BlockAddress = Schema.decodeUnknownSync(BlockAddressSchema)({
  dimension: 'overworld',
  position: { x: 1, y: 64, z: 0 },
})

const countStorageItems = (snapshot: Schema.Schema.Type<typeof ContainerStorageSnapshotSchema>): number =>
  snapshot.containers.reduce(
    (storageCount, container) =>
      storageCount +
      container.slots.reduce(
        (containerCount, stack) => containerCount + (stack === null ? 0 : stack.count),
        0,
      ),
    0,
  )

const makeHopperTransferScenario = (initialItemCount: number) =>
  Effect.gen(function* makeHopperTransferScenarioGenerator() {
    const stackResult = itemStack('redstone_dust', initialItemCount)
    if (Result.isFailure(stackResult)) {
      return yield* Effect.fail(stackResult.failure)
    }
    const hopperSlots: Array<Container['slots'][number]> = Array.from(
      { length: containerCapacity('hopper') },
      () => null,
    )
    hopperSlots[0] = { ...stackResult.success, durability: null }
    const initialStorage = Schema.decodeUnknownSync(ContainerStorageSnapshotSchema, strictDecode)({
      containers: [
        { id: worldContainerIdAt(HOPPER_ADDRESS), kind: 'hopper', slots: hopperSlots },
        {
          id: worldContainerIdAt(CHEST_ADDRESS),
          kind: 'chest',
          slots: Array.from({ length: containerCapacity('chest') }, () => null),
        },
      ],
      version: CONTAINER_STORAGE_SNAPSHOT_VERSION,
    })
    const chunkStore = yield* makeChunkStore(
      (coord) =>
        Effect.succeed({
          biomes: Array.from({ length: CHUNK_BIOME_COUNT }, () => 'PLAINS' as const),
          blocks: emptyBlocks(),
          coord,
        }),
      ChunkCapacity(1),
    )
    yield* chunkStore.load(chunkCoordOfBlock(HOPPER_ADDRESS.position))
    const coordinator = yield* makeWorldCommitCoordinator({
      chunkStores: { forDimension: () => chunkStore },
      owners: [
        containerStorageOwnerRegistration(initialStorage),
        hopperOwnerRegistration(INITIAL_HOPPER_SERVICE_SNAPSHOT),
      ],
      world: TEST_WORLD_ID,
    })
    const storage = yield* Effect.provideService(
      makeContainerStorageService(),
      WorldCommitCoordinator,
      coordinator,
    )
    const hopper = yield* Effect.provideService(
      Effect.provideService(makeHopperService(), WorldCommitCoordinator, coordinator),
      ContainerStorageService,
      storage,
    )
    const selected = selectHopperTransferCandidates({
      destinationFacing: { address: CHEST_ADDRESS, kind: 'chest' },
      hopperAddress: HOPPER_ADDRESS,
      powered: false,
      sourceAbove: null,
    })
    if (selected._tag !== 'Candidates') {
      return yield* Effect.fail('Expected hopper transfer candidate')
    }
    const candidate: HopperTransferCandidate = selected.candidates[0]
    const makeBlockWrite = (expectedWorldRevision: WorldRevision) =>
      Effect.map(coordinator.dimensionRevision(HOPPER_ADDRESS.dimension), (expectedDimensionRevision) =>
        Schema.decodeUnknownSync(WorldWriteBatchSchema, strictDecode)({
          dimension: HOPPER_ADDRESS.dimension,
          edits: [{ block: HOPPER_BLOCK_ID, position: HOPPER_ADDRESS.position }],
          expectedDimensionRevision,
          expectedWorldRevision,
          world: coordinator.worldId,
        }),
      )
    const makeRequest = (blockWrite: WorldWriteBatch): HopperTransferRequest => ({
      blockWrite,
      destination: candidate.destination,
      hopperAddress: HOPPER_ADDRESS,
      source: candidate.source,
    })
    const observe = () =>
      Effect.map(
        coordinator.observe(CONTAINER_STORAGE_REPLICATED_OWNER_ID, ContainerStorageSnapshotSchema, [
          { dimension: HOPPER_ADDRESS.dimension, position: HOPPER_ADDRESS.position },
        ]),
        (snapshot) => Schema.decodeUnknownSync(
          WorldReadSnapshotSchema(ContainerStorageSnapshotSchema),
          strictDecode,
        )(snapshot),
      )
    const snapshotStorage = () =>
      Effect.map(storage.snapshot, (snapshot) =>
        Schema.decodeUnknownSync(ContainerStorageSnapshotSchema, strictDecode)(snapshot),
      )
    const snapshotHopper = () =>
      Effect.map(hopper.snapshot, (snapshot) =>
        Schema.decodeUnknownSync(HopperServiceSnapshotSchema, strictDecode)(snapshot.state),
      )
    const blockWrite = yield* Effect.flatMap(coordinator.revision, makeBlockWrite)
    return {
      candidate,
      coordinator,
      hopper,
      makeBlockWrite,
      makeRequest,
      observe,
      snapshotHopper,
      snapshotStorage,
      blockWrite,
      dimensionsRevision: coordinator.dimensionRevision(HOPPER_ADDRESS.dimension),
      worldRevision: coordinator.revision,
      storage,
    }
  })

describe('HopperService transfer properties', () => {
  it.effect('successful transfers conserve item count across owner and block commits', () =>
    Effect.sync(() => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 64 }), (initialItemCount) => {
          const scenario = Effect.runSync(makeHopperTransferScenario(initialItemCount))
          const before = Effect.runSync(scenario.snapshotStorage())
          const outcome = Effect.runSync(scenario.hopper.transfer(scenario.makeRequest(scenario.blockWrite)))
          const decodedOutcome = Schema.decodeUnknownSync(HopperTransferOutcomeSchema, strictDecode)(outcome)
          const after = Effect.runSync(scenario.snapshotStorage())
          const observed = Effect.runSync(scenario.observe())

          expect(decodedOutcome._tag).toBe('Committed')
          expect(countStorageItems(before)).toBe(initialItemCount)
          expect(countStorageItems(after)).toBe(countStorageItems(before))
          expect(countStorageItems(observed.state)).toBe(initialItemCount)
          expect(observed.blocks).toStrictEqual([
            {
              dimension: HOPPER_ADDRESS.dimension,
              position: HOPPER_ADDRESS.position,
              reading: { _tag: 'Block', block: HOPPER_BLOCK_ID },
            },
          ])
          expect(Effect.runSync(scenario.snapshotHopper())).toMatchObject({
            hoppers: [{ address: HOPPER_ADDRESS, cooldownTicks: 8 }],
          })
        }),
        { numRuns: PROPERTY_RUN_COUNT },
      )
    }),
  )

  it.effect('a typed stale-revision failure leaves owner state, block reads, and revisions unchanged', () =>
    Effect.sync(() => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 64 }), (initialItemCount) => {
          const scenario = Effect.runSync(makeHopperTransferScenario(initialItemCount))
          const beforeStorage = Effect.runSync(scenario.snapshotStorage())
          const beforeHopper = Effect.runSync(scenario.snapshotHopper())
          const beforeObserved = Effect.runSync(scenario.observe())
          const beforeWorldRevision = Effect.runSync(scenario.worldRevision)
          const beforeDimensionRevision = Effect.runSync(scenario.dimensionsRevision)
          const staleRevision = Schema.decodeUnknownSync(WorldRevisionSchema, strictDecode)(
            Number(beforeWorldRevision) + 1,
          )
          const staleBlockWrite = Effect.runSync(scenario.makeBlockWrite(staleRevision))
          const failed = Effect.runSync(
            Effect.result(scenario.hopper.transfer(scenario.makeRequest(staleBlockWrite))),
          )

          expect(Result.isFailure(failed)).toBe(true)
          if (Result.isFailure(failed)) {
            const decodedFailure = Schema.decodeUnknownSync(HopperServiceErrorSchema, strictDecode)(failed.failure)
            expect(decodedFailure._tag).toBe('WorldRevisionConflict')
          }
          expect(Effect.runSync(scenario.snapshotStorage())).toStrictEqual(beforeStorage)
          expect(Effect.runSync(scenario.snapshotHopper())).toStrictEqual(beforeHopper)
          expect(Effect.runSync(scenario.observe())).toStrictEqual(beforeObserved)
          expect(Effect.runSync(scenario.worldRevision)).toBe(beforeWorldRevision)
          expect(Effect.runSync(scenario.dimensionsRevision)).toBe(beforeDimensionRevision)
          expect(countStorageItems(beforeStorage)).toBe(initialItemCount)
        }),
        { numRuns: PROPERTY_RUN_COUNT },
      )
    }),
  )
})
