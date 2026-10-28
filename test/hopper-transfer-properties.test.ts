import {
  blockIdOf,
  BlockAddressSchema,
  chunkCoordOfBlock,
  CHUNK_SIZE_XZ,
  DimensionRevisionSchema,
  SimulationTickSchema,
  WorldRevisionSchema,
  WorldIdSchema,
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
  HOPPER_TRANSFER_COOLDOWN_TICKS,
  HopperElapsedTicksSchema,
  HopperServiceErrorSchema,
  HopperServiceSnapshotSchema,
  HOPPER_REPLICATED_OWNER_ID,
  ItemStackFailureSchema,
  HopperTransferOutcomeSchema,
  hopperOwnerRegistration,
  INITIAL_HOPPER_SERVICE_SNAPSHOT,
  itemStack,
  makeContainerStorageService,
  makeHopperService,
  makeWorldCommitCoordinator,
  mergeWorldCommitPlans,
  WorldRevisionConflict,
  WorldCommitCoordinator,
  WorldReadSnapshotSchema,
  worldContainerIdAt,
  type Container,
  type HopperTransferTickPlanState,
  type HopperTransferRequest,
  type WorldCommitPlanSnapshot,
  type WorldCommitRequest,
  type DomainEvent,
  type DomainEventBusApi,
} from '@nerima-games/mc-sim'
import * as fc from 'fast-check'
import { Effect, Option, Result, Schema, Stream } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  selectHopperTransferCandidates,
  type HopperTransferCandidate,
} from '../src/domain/hopper.js'
import { applyRedstoneHostEvents, type RedstoneHostRealm, type RedstoneHostWritePort } from '../src/application/redstone-host-port.js'
import {
  RedstoneEventBatchSchema,
  RedstoneWorldRuntime,
  RedstoneWorldRuntimeLayer,
  type HopperTransferEvent,
  type RedstoneEventBatch,
} from '../src/application/world-runtime.js'

const PROPERTY_RUN_COUNT = 32
const CHUNK_BIOME_COUNT = CHUNK_SIZE_XZ * CHUNK_SIZE_XZ
const strictDecode = { onExcessProperty: 'error' } as const
const hopperTransferEvent = (event: {
  dimension: string
  position: BlockAddress['position']
  elapsedRedstoneTicks: number
  powered: boolean
}): HopperTransferEvent => {
  const [decoded] = Schema.decodeUnknownSync(RedstoneEventBatchSchema)({
    hopper: [event],
    lamp: [],
    piston: [],
    powered: [],
    trigger: [],
  }).hopper
  if (decoded === undefined) {
    throw new Error('Expected a decoded hopper transfer event')
  }
  return decoded
}
const HOPPER_BLOCK_ID = Option.getOrThrow(blockIdOf('hopper'))
const LAMP_BLOCK_ID = Option.getOrThrow(blockIdOf('redstone_lamp_lit'))
const PISTON_BLOCK_ID = Option.getOrThrow(blockIdOf('piston'))
const PISTON_HEAD_BLOCK_ID = Option.getOrThrow(blockIdOf('piston_head'))
const TEST_WORLD_ID = Schema.decodeUnknownSync(WorldIdSchema)('redstone-hopper-transfer-property')
const HOPPER_ADDRESS: BlockAddress = Schema.decodeUnknownSync(BlockAddressSchema)({
  dimension: 'overworld',
  position: { x: 0, y: 64, z: 0 },
})
const COOLDOWN_HOPPER_ADDRESS: BlockAddress = Schema.decodeUnknownSync(BlockAddressSchema)({
  dimension: 'overworld',
  position: { x: 8, y: 64, z: 0 },
})
const CHEST_ADDRESS: BlockAddress = Schema.decodeUnknownSync(BlockAddressSchema)({
  dimension: 'overworld',
  position: { x: 1, y: 64, z: 0 },
})
const LAMP_ADDRESS: BlockAddress = Schema.decodeUnknownSync(BlockAddressSchema)({
  dimension: 'overworld',
  position: { x: 2, y: 64, z: 0 },
})
const PISTON_ADDRESS: BlockAddress = Schema.decodeUnknownSync(BlockAddressSchema)({
  dimension: 'overworld',
  position: { x: 3, y: 64, z: 0 },
})
const PISTON_HEAD_ADDRESS: BlockAddress = Schema.decodeUnknownSync(BlockAddressSchema)({
  dimension: 'overworld',
  position: { x: 4, y: 64, z: 0 },
})
const VANILLA_HOPPER_CADENCE_FIXTURE = {
  edition: 'Java Edition',
  version: '26.3',
  source: 'https://minecraft.wiki/w/Hopper',
  cooldownGameTicks: 8,
  poweredGameTicksAfterOneRemaining: 20,
  unpoweredTicksToCoolingDown: 7,
  finalUnpoweredTicks: 1,
} as const
const HOPPER_PLAN_COMMITTED_EVENT: DomainEvent = {
  _tag: 'BlockChangedByWorld',
  address: COOLDOWN_HOPPER_ADDRESS,
  cause: 'fire',
  tick: Schema.decodeUnknownSync(SimulationTickSchema)(1),
}

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

const makeHopperTransferScenario = (
  initialItemCount: number,
  initialHopperSnapshot: Schema.Schema.Type<typeof HopperServiceSnapshotSchema> = INITIAL_HOPPER_SERVICE_SNAPSHOT,
) =>
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
        hopperOwnerRegistration(initialHopperSnapshot),
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
    const makeBlockWrite = (
      expectedWorldRevision: WorldRevision,
      edits = [{ block: HOPPER_BLOCK_ID, position: HOPPER_ADDRESS.position }],
    ) =>
      Effect.map(coordinator.dimensionRevision(HOPPER_ADDRESS.dimension), (expectedDimensionRevision) =>
        Schema.decodeUnknownSync(WorldWriteBatchSchema, strictDecode)({
          dimension: HOPPER_ADDRESS.dimension,
          edits,
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
    const observe = (positions = [{ dimension: HOPPER_ADDRESS.dimension, position: HOPPER_ADDRESS.position }]) =>
      Effect.map(
        coordinator.observe(CONTAINER_STORAGE_REPLICATED_OWNER_ID, ContainerStorageSnapshotSchema, positions),
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
    const makeTransferTickPlanSnapshot = () => Effect.gen(function* makeTransferTickPlanSnapshotGenerator() {
      const [hoppers, containers, expectedDimensionRevision] = yield* Effect.all([
        coordinator.snapshot(HOPPER_REPLICATED_OWNER_ID, HopperServiceSnapshotSchema),
        coordinator.snapshot(CONTAINER_STORAGE_REPLICATED_OWNER_ID, ContainerStorageSnapshotSchema),
        coordinator.dimensionRevision(HOPPER_ADDRESS.dimension),
      ])
      const expectedDimensions = [{ dimension: HOPPER_ADDRESS.dimension, expectedRevision: expectedDimensionRevision }]
      const blockWrite = yield* makeBlockWrite(hoppers.revision)
      return {
        world: hoppers.world,
        expectedRevision: hoppers.revision,
        expectedDimensions,
        state: {
          hoppers: hoppers.state,
          containers: {
            world: containers.world,
            expectedRevision: containers.revision,
            expectedDimensions,
            state: containers.state,
          },
          player: { _tag: 'None' },
          intent: {
            hopperAddress: HOPPER_ADDRESS,
            source: candidate.source,
            destination: candidate.destination,
            blockEdits: { dimension: HOPPER_ADDRESS.dimension, edits: blockWrite.edits },
          },
        },
      } satisfies WorldCommitPlanSnapshot<HopperTransferTickPlanState>
    })
    const makeAtomicHostHarness = (failCommit: boolean) => Effect.gen(function* makeAtomicHostHarnessGenerator() {
      const expectedRevision = yield* coordinator.revision
      const expectedDimensionRevision = yield* coordinator.dimensionRevision(HOPPER_ADDRESS.dimension)
      const lampBlockWrite = yield* makeBlockWrite(expectedRevision, [
        { block: LAMP_BLOCK_ID, position: LAMP_ADDRESS.position },
      ])
      const publishedEvents: Array<DomainEvent> = []
      const eventBus: DomainEventBusApi = {
        events: Stream.empty,
        publish: (event) => Effect.sync(() => {
          publishedEvents.push(event)
        }),
      }
      const blockWriteFor = (
        event: HopperTransferEvent,
        blockId: number,
        revisions: Readonly<{ expectedRevision: WorldRevision; expectedDimensionRevision: typeof expectedDimensionRevision }>,
      ) => Result.succeed(Schema.decodeUnknownSync(WorldWriteBatchSchema, strictDecode)({
        dimension: event.dimension,
        edits: [{ block: blockId, position: event.position }],
        expectedDimensionRevision: revisions.expectedDimensionRevision,
        expectedWorldRevision: revisions.expectedRevision,
        world: coordinator.worldId,
      }))
      let commitCount = 0
      const realm: RedstoneHostRealm = {
        dimension: HOPPER_ADDRESS.dimension,
        lookup: {
          isLeverActive: () => false,
          isPoweredRailPowered: () => false,
          readHopperBlockId: () => HOPPER_BLOCK_ID,
          readHopperTransferContext: (position) => position.x === COOLDOWN_HOPPER_ADDRESS.position.x
            ? { powered: false, sourceAbove: null, destinationFacing: null }
            : {
                powered: false,
                sourceAbove: null,
                destinationFacing: { address: CHEST_ADDRESS, kind: 'chest' },
              },
          readContainerSlots: () => undefined,
          readPistonCell: () => ({ kind: 'empty' }),
          readPistonFacing: () => 'north',
        },
      }
      const hopperServiceWithPostCommitEvent: typeof hopper = {
        ...hopper,
        planAdvanceCooldown: (...args) => hopper.planAdvanceCooldown(...args).pipe(
          Effect.map((fragment) => ({
            ...fragment,
            postCommitEvents: fragment.changes.length > 0 || fragment.blockEdits !== undefined
              ? [HOPPER_PLAN_COMMITTED_EVENT]
              : fragment.postCommitEvents,
          })),
        ),
        planTransferTick: (...args) => hopper.planTransferTick(...args).pipe(
          Effect.map((fragment) => ({
            ...fragment,
            postCommitEvents: fragment.changes.length > 0 || fragment.blockEdits !== undefined
              ? [HOPPER_PLAN_COMMITTED_EVENT]
              : fragment.postCommitEvents,
          })),
        ),
      }
      const port: RedstoneHostWritePort = {
        buildCommitRequest: (_events, pistonPlans) => Result.succeed({
          expectedRevision,
          expectedDimensions: [{ dimension: HOPPER_ADDRESS.dimension, expectedRevision: expectedDimensionRevision }],
          changes: [],
          blockWrite: Schema.decodeUnknownSync(WorldWriteBatchSchema, strictDecode)({
            ...lampBlockWrite,
            edits: [
              ...lampBlockWrite.edits,
              ...pistonPlans.flatMap(({ piston }) => [
                { block: PISTON_BLOCK_ID, position: piston },
                { block: PISTON_HEAD_BLOCK_ID, position: PISTON_HEAD_ADDRESS.position },
              ]),
            ],
          }),
        }),
        buildHopperBlockWrite: blockWriteFor,
        eventBus,
        coordinator: {
          ...coordinator,
          commit: (request) => {
            commitCount += 1
            if (!failCommit) return coordinator.commit(request)
            const staleRevision = Schema.decodeUnknownSync(WorldRevisionSchema, strictDecode)(
              Number(request.expectedRevision) + 1,
            )
            const staleDimensions = request.expectedDimensions.map((expectation) => ({
              ...expectation,
              expectedRevision: Schema.decodeUnknownSync(DimensionRevisionSchema, strictDecode)(
                Number(expectation.expectedRevision) + 1,
              ),
            }))
            const staleBlockWrite = request.blockWrite === undefined
              ? undefined
              : Schema.decodeUnknownSync(WorldWriteBatchSchema, strictDecode)({
                  ...request.blockWrite,
                  expectedWorldRevision: staleRevision,
                  expectedDimensionRevision: Schema.decodeUnknownSync(
                    DimensionRevisionSchema,
                    strictDecode,
                  )(Number(request.blockWrite.expectedDimensionRevision) + 1),
                })
            const staleRequest: WorldCommitRequest = {
              ...request,
              expectedRevision: staleRevision,
              expectedDimensions: staleDimensions,
              ...(staleBlockWrite === undefined ? {} : { blockWrite: staleBlockWrite }),
            }
            return coordinator.commit(staleRequest)
          },
        },
        hopperService: hopperServiceWithPostCommitEvent,
      }
      return { commitCount: () => commitCount, port, publishedEvents, realm }
    })
    const blockWrite = yield* Effect.flatMap(coordinator.revision, makeBlockWrite)
    return {
      candidate,
      coordinator,
      hopper,
      makeBlockWrite,
      makeTransferTickPlanSnapshot,
      makeAtomicHostHarness,
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
  it.effect('matches the Java Edition hopper cooldown while powered ticks reduce it without transferring', () =>
    Effect.sync(() => {
      expect(VANILLA_HOPPER_CADENCE_FIXTURE).toMatchObject({
        edition: 'Java Edition',
        version: '26.3',
        source: 'https://minecraft.wiki/w/Hopper',
        cooldownGameTicks: 8,
      })
      fc.assert(
        fc.property(fc.integer({ min: 2, max: 64 }), (initialItemCount) => {
          // The source's 7-tick case applies when another block inserts an item
          // into an empty hopper; this scenario transfers from a non-empty hopper.
          const scenario = Effect.runSync(makeHopperTransferScenario(initialItemCount))
          const firstTransfer = Effect.runSync(
            scenario.hopper.transfer(scenario.makeRequest(scenario.blockWrite)),
          )
          expect(firstTransfer._tag).toBe('Committed')
          expect(Effect.runSync(scenario.snapshotHopper()).hoppers[0]?.cooldownTicks).toBe(
            HOPPER_TRANSFER_COOLDOWN_TICKS,
          )

          const afterTransfer = Effect.runSync(scenario.makeTransferTickPlanSnapshot())
          const sevenUnpoweredTicks = Effect.runSync(
            scenario.hopper.planTransferTick(
              afterTransfer,
              Schema.decodeUnknownSync(HopperElapsedTicksSchema, strictDecode)(
                VANILLA_HOPPER_CADENCE_FIXTURE.unpoweredTicksToCoolingDown,
              ),
              false,
            ),
          )
          expect(sevenUnpoweredTicks.result).toMatchObject({ _tag: 'CoolingDown', ticks: 1 })
          const cooldownRequest = Effect.runSync(
            Effect.fromResult(mergeWorldCommitPlans([sevenUnpoweredTicks])),
          )
          Effect.runSync(scenario.coordinator.commit(cooldownRequest))

          const oneTickRemaining = Effect.runSync(scenario.makeTransferTickPlanSnapshot())
          const poweredCooldownAdvance = Effect.runSync(
            scenario.hopper.planTransferTick(
              oneTickRemaining,
              Schema.decodeUnknownSync(HopperElapsedTicksSchema, strictDecode)(
                VANILLA_HOPPER_CADENCE_FIXTURE.poweredGameTicksAfterOneRemaining,
              ),
              true,
            ),
          )
          expect(poweredCooldownAdvance.result).toStrictEqual({ _tag: 'Disabled' })
          expect(poweredCooldownAdvance.changes).not.toStrictEqual([])
          const poweredCooldownRequest = Effect.runSync(
            Effect.fromResult(mergeWorldCommitPlans([poweredCooldownAdvance])),
          )
          Effect.runSync(scenario.coordinator.commit(poweredCooldownRequest))
          expect(Effect.runSync(scenario.snapshotHopper()).hoppers[0]?.cooldownTicks).toBe(0)

          const finalUnpoweredTick = Effect.runSync(
            scenario.hopper.planTransferTick(
              Effect.runSync(scenario.makeTransferTickPlanSnapshot()),
              Schema.decodeUnknownSync(HopperElapsedTicksSchema, strictDecode)(
                VANILLA_HOPPER_CADENCE_FIXTURE.finalUnpoweredTicks,
              ),
              false,
            ),
          )
          expect(finalUnpoweredTick.result._tag).toBe('Committed')
          const transferRequest = Effect.runSync(
            Effect.fromResult(mergeWorldCommitPlans([finalUnpoweredTick])),
          )
          Effect.runSync(scenario.coordinator.commit(transferRequest))
          expect(Effect.runSync(scenario.snapshotHopper()).hoppers[0]?.cooldownTicks).toBe(
            HOPPER_TRANSFER_COOLDOWN_TICKS,
          )
        }),
        { numRuns: PROPERTY_RUN_COUNT },
      )
    }),
  )

  it.effect('reduces a powered hopper cooldown from three game ticks to two', () =>
    Effect.sync(() => {
      const scenario = Effect.runSync(makeHopperTransferScenario(8))
      const firstTransfer = Effect.runSync(
        scenario.hopper.transfer(scenario.makeRequest(scenario.blockWrite)),
      )
      expect(firstTransfer._tag).toBe('Committed')

      const threeTicksRemaining = Effect.runSync(
        scenario.hopper.planTransferTick(
          Effect.runSync(scenario.makeTransferTickPlanSnapshot()),
          Schema.decodeUnknownSync(HopperElapsedTicksSchema, strictDecode)(5),
          false,
        ),
      )
      expect(threeTicksRemaining.result).toMatchObject({ _tag: 'CoolingDown', ticks: 3 })
      const cooldownRequest = Effect.runSync(
        Effect.fromResult(mergeWorldCommitPlans([threeTicksRemaining])),
      )
      Effect.runSync(scenario.coordinator.commit(cooldownRequest))

      const storageBeforePoweredTick = Effect.runSync(scenario.snapshotStorage())
      const poweredTick = Effect.runSync(
        scenario.hopper.planTransferTick(
          Effect.runSync(scenario.makeTransferTickPlanSnapshot()),
          Schema.decodeUnknownSync(HopperElapsedTicksSchema, strictDecode)(1),
          true,
        ),
      )
      const poweredTickRequest = Effect.runSync(
        Effect.fromResult(mergeWorldCommitPlans([poweredTick])),
      )
      Effect.runSync(scenario.coordinator.commit(poweredTickRequest))

      expect(Effect.runSync(scenario.snapshotHopper()).hoppers[0]?.cooldownTicks).toBe(2)
      expect(Effect.runSync(scenario.snapshotStorage())).toStrictEqual(storageBeforePoweredTick)
    }),
  )

  it.effect('covers fixed item-count boundaries and adjacent invalid counts', () =>
    Effect.sync(() => {
      for (const initialItemCount of [1, 64]) {
        const successfulScenario = Effect.runSync(makeHopperTransferScenario(initialItemCount))
        const before = Effect.runSync(successfulScenario.snapshotStorage())
        const outcome = Effect.runSync(
          successfulScenario.hopper.transfer(
            successfulScenario.makeRequest(successfulScenario.blockWrite),
          ),
        )
        const decodedOutcome = Schema.decodeUnknownSync(
          HopperTransferOutcomeSchema,
          strictDecode,
        )(outcome)
        const after = Effect.runSync(successfulScenario.snapshotStorage())

        expect(decodedOutcome._tag).toBe('Committed')
        expect(countStorageItems(before)).toBe(initialItemCount)
        expect(countStorageItems(after)).toBe(initialItemCount)

        const staleScenario = Effect.runSync(makeHopperTransferScenario(initialItemCount))
        const beforeStorage = Effect.runSync(staleScenario.snapshotStorage())
        const beforeHopper = Effect.runSync(staleScenario.snapshotHopper())
        const beforeObserved = Effect.runSync(staleScenario.observe())
        const beforeWorldRevision = Effect.runSync(staleScenario.worldRevision)
        const beforeDimensionRevision = Effect.runSync(staleScenario.dimensionsRevision)
        const staleRevision = Schema.decodeUnknownSync(WorldRevisionSchema, strictDecode)(
          Number(beforeWorldRevision) + 1,
        )
        const staleBlockWrite = Effect.runSync(staleScenario.makeBlockWrite(staleRevision))
        const failed = Effect.runSync(
          Effect.result(
            staleScenario.hopper.transfer(staleScenario.makeRequest(staleBlockWrite)),
          ),
        )

        expect(Result.isFailure(failed)).toBe(true)
        if (Result.isFailure(failed)) {
          const decodedFailure = Schema.decodeUnknownSync(
            HopperServiceErrorSchema,
            strictDecode,
          )(failed.failure)
          expect(decodedFailure._tag).toBe('WorldRevisionConflict')
        }
        expect(Effect.runSync(staleScenario.snapshotStorage())).toStrictEqual(beforeStorage)
        expect(Effect.runSync(staleScenario.snapshotHopper())).toStrictEqual(beforeHopper)
        expect(Effect.runSync(staleScenario.observe())).toStrictEqual(beforeObserved)
        expect(Effect.runSync(staleScenario.worldRevision)).toBe(beforeWorldRevision)
        expect(Effect.runSync(staleScenario.dimensionsRevision)).toBe(beforeDimensionRevision)
      }

      for (const invalidItemCount of [0, 65]) {
        const attempted = Effect.runSync(
          Effect.result(makeHopperTransferScenario(invalidItemCount)),
        )
        expect(Result.isFailure(attempted)).toBe(true)
        if (Result.isFailure(attempted)) {
          const decodedFailure = Schema.decodeUnknownResult(
            ItemStackFailureSchema,
            strictDecode,
          )(attempted.failure)
          expect(Result.isSuccess(decodedFailure)).toBe(true)
        }
      }
    }),
  )

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

  it.effect('host commit failure preserves hopper state and queued events; success commits the batch once', () =>
    Effect.sync(() => {
      const runHostBatch = (initialItemCount: number, failCommit: boolean) => {
        const initialHopperSnapshot = failCommit
          ? Schema.decodeUnknownSync(HopperServiceSnapshotSchema, strictDecode)({
              hoppers: [{ address: COOLDOWN_HOPPER_ADDRESS, cooldownTicks: 6 }],
            })
          : INITIAL_HOPPER_SERVICE_SNAPSHOT
        const scenario = Effect.runSync(makeHopperTransferScenario(initialItemCount, initialHopperSnapshot))
        const harness = Effect.runSync(scenario.makeAtomicHostHarness(failCommit))
        const positions = [
          { dimension: HOPPER_ADDRESS.dimension, position: HOPPER_ADDRESS.position },
          { dimension: LAMP_ADDRESS.dimension, position: LAMP_ADDRESS.position },
          { dimension: PISTON_ADDRESS.dimension, position: PISTON_ADDRESS.position },
          { dimension: PISTON_HEAD_ADDRESS.dimension, position: PISTON_HEAD_ADDRESS.position },
        ]
        const beforeStorage = Effect.runSync(scenario.snapshotStorage())
        const beforeHopper = Effect.runSync(scenario.snapshotHopper())
        const beforeObserved = Effect.runSync(scenario.observe(positions))
        const beforeWorldRevision = Effect.runSync(scenario.worldRevision)
        const beforeDimensionRevision = Effect.runSync(scenario.dimensionsRevision)
        const lamp = { dimension: LAMP_ADDRESS.dimension, lit: true, position: LAMP_ADDRESS.position }
        const events: RedstoneEventBatch = {
          hopper: failCommit
            ? [hopperTransferEvent({
                dimension: COOLDOWN_HOPPER_ADDRESS.dimension,
                position: COOLDOWN_HOPPER_ADDRESS.position,
                elapsedRedstoneTicks: 1,
                powered: false,
              })]
            : [
                hopperTransferEvent({
                  dimension: HOPPER_ADDRESS.dimension,
                  position: HOPPER_ADDRESS.position,
                  elapsedRedstoneTicks: 1,
                  powered: true,
                }),
                hopperTransferEvent({
                  dimension: HOPPER_ADDRESS.dimension,
                  position: HOPPER_ADDRESS.position,
                  elapsedRedstoneTicks: 4,
                  powered: false,
                }),
              ],
          lamp: [lamp],
          piston: [{
            dimension: PISTON_ADDRESS.dimension,
            piston: PISTON_ADDRESS.position,
            facing: 'east',
            kind: 'normal',
            state: 'retracted',
            powered: true,
          }],
          powered: [],
          trigger: [],
        }
        const execution = Effect.runSync(
          Effect.gen(function* runHostBatchGenerator() {
            const runtime = yield* RedstoneWorldRuntime
            yield* runtime.restoreEvents(events)
            const result = yield* Effect.result(
              applyRedstoneHostEvents(runtime, [harness.realm], harness.port),
            )
            const remaining = {
              hopper: yield* runtime.drainHopperTransferEvents,
              lamp: yield* runtime.drainLampTransitions,
              piston: yield* runtime.drainPistonTransitions,
              powered: yield* runtime.drainPoweredComponentTransitions,
              trigger: yield* runtime.drainTriggerEvents,
            }
            return { remaining, result }
          }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
        )
        return {
          afterHopper: Effect.runSync(scenario.snapshotHopper()),
          afterObserved: Effect.runSync(scenario.observe(positions)),
          afterStorage: Effect.runSync(scenario.snapshotStorage()),
          afterWorldRevision: Effect.runSync(scenario.worldRevision),
          afterDimensionRevision: Effect.runSync(scenario.dimensionsRevision),
          beforeHopper,
          beforeObserved,
          beforeStorage,
          beforeWorldRevision,
          beforeDimensionRevision,
          commitCount: harness.commitCount(),
          events,
          execution,
          initialItemCount,
          publishedEvents: harness.publishedEvents,
        }
      }

      fc.assert(
        fc.property(fc.integer({ min: 1, max: 64 }), (initialItemCount) => {
          const failed = runHostBatch(initialItemCount, true)
          expect(Result.isFailure(failed.execution.result)).toBe(true)
          if (Result.isFailure(failed.execution.result)) {
            expect(failed.execution.result.failure).toBeInstanceOf(WorldRevisionConflict)
          }
          expect(failed.commitCount).toBe(1)
          expect(failed.afterStorage).toStrictEqual(failed.beforeStorage)
          expect(failed.afterHopper).toStrictEqual(failed.beforeHopper)
          expect(failed.afterHopper.hoppers.find(({ address }) => address.position.x === COOLDOWN_HOPPER_ADDRESS.position.x)?.cooldownTicks)
            .toBe(6)
          expect(failed.afterObserved).toStrictEqual(failed.beforeObserved)
          expect(failed.afterWorldRevision).toBe(failed.beforeWorldRevision)
          expect(failed.afterDimensionRevision).toBe(failed.beforeDimensionRevision)
          expect(failed.execution.remaining).toStrictEqual(failed.events)
          expect(failed.publishedEvents).toStrictEqual([])

          const succeeded = runHostBatch(initialItemCount, false)
          expect(Result.isSuccess(succeeded.execution.result)).toBe(true)
          expect(succeeded.commitCount).toBe(1)
          expect(succeeded.publishedEvents).toStrictEqual([HOPPER_PLAN_COMMITTED_EVENT])
          expect(succeeded.afterWorldRevision).toBe(Number(succeeded.beforeWorldRevision) + 1)
          expect(succeeded.afterDimensionRevision).toBe(Number(succeeded.beforeDimensionRevision) + 1)
          expect(countStorageItems(succeeded.afterStorage)).toBe(initialItemCount)
          expect(countStorageItems(succeeded.afterObserved.state)).toBe(initialItemCount)
          expect(succeeded.afterHopper.hoppers.find(({ address }) => address.position.x === HOPPER_ADDRESS.position.x)?.cooldownTicks)
            .toBe(HOPPER_TRANSFER_COOLDOWN_TICKS)
          expect(succeeded.afterObserved.blocks).toEqual(expect.arrayContaining([
            {
              dimension: HOPPER_ADDRESS.dimension,
              position: HOPPER_ADDRESS.position,
              reading: { _tag: 'Block', block: HOPPER_BLOCK_ID },
            },
            {
              dimension: LAMP_ADDRESS.dimension,
              position: LAMP_ADDRESS.position,
              reading: { _tag: 'Block', block: LAMP_BLOCK_ID },
            },
            {
              dimension: PISTON_ADDRESS.dimension,
              position: PISTON_ADDRESS.position,
              reading: { _tag: 'Block', block: PISTON_BLOCK_ID },
            },
            {
              dimension: PISTON_HEAD_ADDRESS.dimension,
              position: PISTON_HEAD_ADDRESS.position,
              reading: { _tag: 'Block', block: PISTON_HEAD_BLOCK_ID },
            },
          ]))
          expect(succeeded.execution.remaining).toStrictEqual({
            hopper: [],
            lamp: [],
            piston: [],
            powered: [],
            trigger: [],
          })
        }),
        { numRuns: PROPERTY_RUN_COUNT },
      )
    }),
  )
})
