/**
 * The hopper's rules: the inversion, endpoint order, and transfer timing.
 *
 * The inversion is the interesting one. Every other component in this repository
 * acts when power arrives; a hopper STOPS. A reader who knows the rest of the
 * model writes `if (powered)` and gets a filter that is open when it should be
 * shut, which is a machine that empties itself.
 *
 * The reference models neither rule — `redstone-hopper-world-effects.ts:11-14`
 * says so in as many words ("this model transfers directly") and moves items on
 * every frame. The lock and periodic cooldown expectations therefore come from
 * vanilla; the first eligible tick remains an inference from the initial sim
 * service state, not a vanilla-confirmed number.
 */
import {
  BlockAddressSchema,
  blockIdOf,
  chunkCoordOfBlock,
  CHUNK_SIZE_XZ,
  WorldIdSchema,
  WorldWriteBatchSchema,
  type BlockAddress,
} from '@nerima-games/mc-kernel'
import {
  CONTAINER_STORAGE_SNAPSHOT_VERSION,
  ContainerStorageSnapshotSchema,
  ContainerStorageService,
  containerCapacity,
  containerStorageOwnerRegistration,
  HopperTransferOutcomeSchema,
  hopperOwnerRegistration,
  INITIAL_HOPPER_SERVICE_SNAPSHOT,
  itemStack,
  makeContainerStorageService,
  makeHopperService,
  makeWorldCommitCoordinator,
  worldContainerIdAt,
  WorldCommitCoordinator,
  type Container,
} from '@nerima-games/mc-sim'
import { ChunkCapacity, makeChunkStore } from '@nerima-games/mc-worldgen'
import { emptyBlocks } from '@nerima-games/mc-worldgen/testing'
import * as fc from 'fast-check'
import { Effect, Option, Result, Schema } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  GAME_TICKS_PER_REDSTONE_TICK,
  HOPPER_TRANSFER_COOLDOWN_GAME_TICKS,
  HOPPER_TRANSFER_ITEMS,
  HOPPER_TRANSFER_PERIOD_TICKS,
  HopperTransferSelectionRequestSchema,
  HopperTransferSelectionOutcomeSchema,
  hopperTransferDue,
  isHopperLocked,
  selectHopperTransferCandidates,
} from '../src/domain/hopper'
import { REDSTONE_TICK_SECS } from '../src/stages/registration'

const PROPERTY_RUN_COUNT = 32
const CHUNK_BIOME_COUNT = CHUNK_SIZE_XZ * CHUNK_SIZE_XZ

const sourceUrl = 'https://minecraft.wiki/w/Hopper'
const versionSourceUrl = 'https://minecraft.wiki/w/Java_Edition'

// This inference describes the newly initialized sim service, not a Java timing claim.
const initialEligibilityFixture = {
  firstEligibleGameTick: 0,
  evidence: 'inference from INITIAL_HOPPER_SERVICE_SNAPSHOT having no hopper cooldown entry',
  vanillaNumericFixture: false,
} as const

const periodicCooldownFixture = {
  edition: 'Java Edition',
  version: '26.3',
  sourceUrl,
  versionSourceUrl,
  cooldownGameTicks: 8,
} as const

const address = (x: number, y: number, z: number): BlockAddress =>
  Schema.decodeUnknownSync(BlockAddressSchema)({
    dimension: 'overworld',
    position: { x, y, z },
  })

const HOPPER_BLOCK_ID = Option.getOrThrow(blockIdOf('hopper'))
const HOPPER_ADDRESS = address(0, 64, 0)
const CHEST_ADDRESS = address(1, 64, 0)

const countStorageItems = (
  snapshot: Schema.Schema.Type<typeof ContainerStorageSnapshotSchema>,
): number =>
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
  Effect.gen(function* () {
    const stackResult = itemStack('redstone_dust', initialItemCount)
    if (Result.isFailure(stackResult)) return yield* Effect.fail(stackResult.failure)

    const hopperSlots: Array<Container['slots'][number]> = Array.from(
      { length: containerCapacity('hopper') },
      () => null,
    )
    hopperSlots[0] = { ...stackResult.success, durability: null }

    const initialStorage = Schema.decodeUnknownSync(ContainerStorageSnapshotSchema)({
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

    const chunkStores = { forDimension: () => chunkStore }
    const coordinator = yield* makeWorldCommitCoordinator({
      chunkStores,
      owners: [
        containerStorageOwnerRegistration(initialStorage),
        hopperOwnerRegistration(INITIAL_HOPPER_SERVICE_SNAPSHOT),
      ],
      world: Schema.decodeUnknownSync(WorldIdSchema)('hopper-property-test'),
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
    const before = Schema.decodeUnknownSync(ContainerStorageSnapshotSchema)(yield* storage.snapshot)
    const blockWrite = Schema.decodeUnknownSync(WorldWriteBatchSchema)({
      dimension: HOPPER_ADDRESS.dimension,
      edits: [{ block: HOPPER_BLOCK_ID, position: HOPPER_ADDRESS.position }],
      expectedDimensionRevision: yield* coordinator.dimensionRevision(HOPPER_ADDRESS.dimension),
      expectedWorldRevision: yield* coordinator.revision,
      world: coordinator.worldId,
    })
    const outcome = Schema.decodeUnknownSync(HopperTransferOutcomeSchema)(
      yield* hopper.transfer({
        blockWrite,
        destination: { _tag: 'Container', address: CHEST_ADDRESS, slot: 0 },
        hopperAddress: HOPPER_ADDRESS,
        source: { _tag: 'Container', address: HOPPER_ADDRESS, slot: 0 },
      }),
    )
    const after = Schema.decodeUnknownSync(ContainerStorageSnapshotSchema)(yield* storage.snapshot)

    return { after, before, outcome }
  })

describe('hopper locking — the one component power switches OFF', () => {
  it.effect('REGRESSION: a POWERED hopper is locked; this is the inverse of every other component', () =>
    Effect.sync(() => {
      expect(isHopperLocked(true)).toBe(true)
      expect(isHopperLocked(false)).toBe(false)
    }),
  )

  it.effect('REGRESSION: a locked hopper transfers nothing, whatever its cooldown says', () =>
    Effect.sync(() => {
      // Both halves matter. A rule that only checked the lock would transfer
      // every tick; a rule that only checked the cadence would drain a locked
      // filter every fourth tick, which is the sorting machine failing slowly
      // enough that nobody notices until the chest is empty.
      for (let ticks = 0; ticks < 20; ticks += 1) {
        expect(hopperTransferDue({ powered: true, ticksSinceTransfer: ticks })).toBe(false)
      }
    }),
  )
})

describe('hopper timing', () => {
  it.effect('records tick-zero eligibility as an inference from the empty initial sim state', () =>
    Effect.sync(() => {
      // Vanilla's source establishes the cooldown after a transfer, not the exact
      // first eligible tick. Tick zero is an inference from the new service state
      // having no cooldown entry, so it stays separate from the numeric fixture.
      expect(initialEligibilityFixture).toStrictEqual({
        firstEligibleGameTick: 0,
        evidence: 'inference from INITIAL_HOPPER_SERVICE_SNAPSHOT having no hopper cooldown entry',
        vanillaNumericFixture: false,
      })
      expect(INITIAL_HOPPER_SERVICE_SNAPSHOT.hoppers).toStrictEqual([])
    }),
  )

  it.effect('converts the Java Edition 26.3 eight-game-tick cooldown to four local ticks', () =>
    Effect.sync(() => {
      // Redstone runs at 10 Hz (DN-RS-3, `REDSTONE_TICK_SECS`) and the game at
      // 20, so eight game ticks is four local ticks. Assert the conversion so a
      // future tick-rate change cannot leave the two units silently mismatched.
      expect(periodicCooldownFixture).toStrictEqual({
        edition: 'Java Edition',
        version: '26.3',
        sourceUrl,
        versionSourceUrl,
        cooldownGameTicks: 8,
      })
      expect(HOPPER_TRANSFER_COOLDOWN_GAME_TICKS).toBe(periodicCooldownFixture.cooldownGameTicks)
      expect(GAME_TICKS_PER_REDSTONE_TICK).toBe(2)
      expect(HOPPER_TRANSFER_PERIOD_TICKS).toBe(4)
      expect(HOPPER_TRANSFER_PERIOD_TICKS * GAME_TICKS_PER_REDSTONE_TICK).toBe(
        periodicCooldownFixture.cooldownGameTicks,
      )
      expect(HOPPER_TRANSFER_PERIOD_TICKS * REDSTONE_TICK_SECS).toBeCloseTo(0.4, 10)
      expect(HOPPER_TRANSFER_ITEMS).toBe(1)
      // The local counter gate remains only to compile the current runtime caller;
      // service integration replaces this state with HopperService cooldown.
      expect(hopperTransferDue({ powered: false, ticksSinceTransfer: 3 })).toBe(false)
      expect(hopperTransferDue({ powered: false, ticksSinceTransfer: 4 })).toBe(true)

      // Start eligible to isolate the repeat interval from the initial-tick inference above.
      const transferLocalTicks: Array<number> = []
      let ticksSinceTransfer = HOPPER_TRANSFER_PERIOD_TICKS
      for (let localTick = 0; localTick < 16; localTick += 1) {
        if (localTick > 0) ticksSinceTransfer += 1
        if (hopperTransferDue({ powered: false, ticksSinceTransfer })) {
          transferLocalTicks.push(localTick)
          ticksSinceTransfer = 0
        }
      }
      expect(transferLocalTicks).toStrictEqual([0, 4, 8, 12])
    }),
  )

  it.effect('REGRESSION: a skipped local deadline still passes the compatibility gate', () =>
    Effect.sync(() => {
      // `stages/registration.ts` runs up to MAX_TICKS_PER_FRAME ticks in a loop
      // and DISCARDS the excess after a long frame (DN-RS-3), so a counter can
      // jump past any particular value. An `===` here would leave that hopper
      // waiting for a number it will never see again — a machine that stops
      // after a lag spike and never restarts.
      for (const ticks of [4, 5, 9, 400]) {
        expect(hopperTransferDue({ powered: false, ticksSinceTransfer: ticks })).toBe(true)
      }
      for (const ticks of [0, 1, 2, 3]) {
        expect(hopperTransferDue({ powered: false, ticksSinceTransfer: ticks })).toBe(false)
      }
    }),
  )

  it.effect('a long-locked hopper passes the compatibility gate immediately when unlocked', () =>
    Effect.sync(() => {
      // What makes a redstone-clocked filter emit one item per PULSE rather than
      // one item per pulse that happens to coincide with the cadence. The
      // counter keeps running while the hopper is locked because the caller only
      // resets it on a transfer, and there were none. This is transitional caller
      // behavior; HopperService owns cooldown state after integration.
      let ticksSinceTransfer = 0
      for (let tick = 0; tick < 30; tick += 1) {
        expect(hopperTransferDue({ powered: true, ticksSinceTransfer })).toBe(false)
        ticksSinceTransfer += 1
      }
      expect(hopperTransferDue({ powered: false, ticksSinceTransfer })).toBe(true)
    }),
  )
})

describe('hopper transfer candidates', () => {
  const hopperAddress = address(0, 64, 0)
  const sourceAbove = { address: address(0, 65, 0), kind: 'dispenser' as const }
  const destinationFacing = { address: address(1, 64, 0), kind: 'hopper' as const }

  it.effect('stops candidate selection while powered', () =>
    Effect.sync(() => {
      expect(
        selectHopperTransferCandidates({
          powered: true,
          hopperAddress,
          sourceAbove,
          destinationFacing,
        }),
      ).toStrictEqual({ _tag: 'Locked' })
    }),
  )

  it.effect('returns no candidates when neither adjacent container is available', () =>
    Effect.sync(() => {
      expect(
        selectHopperTransferCandidates({
          powered: false,
          hopperAddress,
          sourceAbove: null,
          destinationFacing: null,
        }),
      ).toStrictEqual({ _tag: 'NoCandidates' })
    }),
  )

  it.effect('returns InvalidRequest for null, malformed address, extra field, or unsupported container kind', () =>
    Effect.sync(() => {
      const request = {
        powered: false,
        hopperAddress,
        sourceAbove: null,
        destinationFacing: null,
      }
      const malformedAddressRequest = {
        ...request,
        hopperAddress: {
          dimension: 'overworld',
          position: { x: 0, y: '64', z: 0 },
        },
      }
      const extraFieldRequest = { ...request, extra: true }
      const unsupportedKindRequest = {
        ...request,
        sourceAbove: { address: hopperAddress, kind: 'barrel' },
      }
      const decodeRequest = Schema.decodeUnknownResult(HopperTransferSelectionRequestSchema, {
        onExcessProperty: 'error',
      })
      const decodeOutcome = Schema.decodeUnknownResult(HopperTransferSelectionOutcomeSchema, {
        onExcessProperty: 'error',
      })

      for (const input of [null, malformedAddressRequest, extraFieldRequest, unsupportedKindRequest]) {
        const outcome = selectHopperTransferCandidates(input)
        expect(outcome).toStrictEqual({ _tag: 'InvalidRequest' })
        expect(Result.isSuccess(decodeOutcome(outcome))).toBe(true)
      }
      expect(Result.isFailure(decodeRequest(extraFieldRequest))).toBe(true)
    }),
  )

  it.effect('orders push before pull and enumerates source and destination slots ascending', () =>
    Effect.sync(() => {
      const selection = selectHopperTransferCandidates({
        powered: false,
        hopperAddress,
        sourceAbove,
        destinationFacing,
      })
      expect(selection._tag).toBe('Candidates')
      if (selection._tag !== 'Candidates') return

      const hopperCapacity = containerCapacity('hopper')
      const facingCapacity = containerCapacity(destinationFacing.kind)
      const aboveCapacity = containerCapacity(sourceAbove.kind)
      const pushCandidateCount = hopperCapacity * facingCapacity

      expect(selection.candidates).toHaveLength(pushCandidateCount + aboveCapacity * hopperCapacity)
      expect(selection.candidates[0]).toStrictEqual({
        direction: 'push',
        source: { _tag: 'Container', address: hopperAddress, slot: 0 },
        destination: { _tag: 'Container', address: destinationFacing.address, slot: 0 },
      })
      expect(selection.candidates[facingCapacity - 1]).toStrictEqual({
        direction: 'push',
        source: { _tag: 'Container', address: hopperAddress, slot: 0 },
        destination: { _tag: 'Container', address: destinationFacing.address, slot: facingCapacity - 1 },
      })
      expect(selection.candidates[facingCapacity]).toStrictEqual({
        direction: 'push',
        source: { _tag: 'Container', address: hopperAddress, slot: 1 },
        destination: { _tag: 'Container', address: destinationFacing.address, slot: 0 },
      })
      expect(selection.candidates[pushCandidateCount]).toStrictEqual({
        direction: 'pull',
        source: { _tag: 'Container', address: sourceAbove.address, slot: 0 },
        destination: { _tag: 'Container', address: hopperAddress, slot: 0 },
      })
      expect(selection.candidates[pushCandidateCount + hopperCapacity - 1]).toStrictEqual({
        direction: 'pull',
        source: { _tag: 'Container', address: sourceAbove.address, slot: 0 },
        destination: { _tag: 'Container', address: hopperAddress, slot: hopperCapacity - 1 },
      })
    }),
  )

  it.effect('decodes complete outcomes strictly and rejects missing or extra fields', () =>
    Effect.sync(() => {
      const selection = selectHopperTransferCandidates({
        powered: false,
        hopperAddress,
        sourceAbove: null,
        destinationFacing,
      })
      expect(selection._tag).toBe('Candidates')
      if (selection._tag !== 'Candidates') return

      const decode = Schema.decodeUnknownResult(HopperTransferSelectionOutcomeSchema, {
        onExcessProperty: 'error',
      })
      const valid = decode(selection)
      expect(Result.isSuccess(valid)).toBe(true)
      if (Result.isSuccess(valid)) expect(valid.success).toStrictEqual(selection)

      const candidate = selection.candidates[0]
      const missingDirection: unknown = {
        _tag: 'Candidates',
        candidates: [{ source: candidate.source, destination: candidate.destination }],
      }
      const extraField: unknown = {
        ...selection,
        candidates: [{ ...candidate, extra: true }],
      }
      const fractionalSlot: unknown = {
        ...selection,
        candidates: [{ ...candidate, source: { ...candidate.source, slot: 0.5 } }],
      }

      expect(Result.isFailure(decode(missingDirection))).toBe(true)
      expect(Result.isFailure(decode(extraField))).toBe(true)
      expect(Result.isFailure(decode(fractionalSlot))).toBe(true)
    }),
  )
})

describe('hopper item properties', () => {
  const adjacentContainer = fc.option(
    fc.constant({ address: CHEST_ADDRESS, kind: 'chest' as const }),
    { nil: null },
  )
  const selectionInput = fc.oneof(
    fc.anything({ maxDepth: 3 }),
    fc.record({
      destinationFacing: adjacentContainer,
      hopperAddress: fc.constant(HOPPER_ADDRESS),
      powered: fc.boolean(),
      sourceAbove: adjacentContainer,
    }),
  )

  it.effect('returns only typed failures or schema-valid finite transfer candidates for arbitrary inputs', () =>
    Effect.sync(() => {
      fc.assert(
        fc.property(selectionInput, (input) => {
          const outcome = selectHopperTransferCandidates(input)
          const decoded = Schema.decodeUnknownResult(HopperTransferSelectionOutcomeSchema, {
            onExcessProperty: 'error',
          })(outcome)
          expect(Result.isSuccess(decoded)).toBe(true)
        }),
        { numRuns: PROPERTY_RUN_COUNT },
      )
    }),
  )

  it.effect('conserves the total item count through HopperService transfers', () =>
    Effect.sync(() => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 64 }), (initialItemCount) => {
          const scenario = Effect.runSync(makeHopperTransferScenario(initialItemCount))
          expect(scenario.outcome._tag).toBe('Committed')
          expect(countStorageItems(scenario.before)).toBe(initialItemCount)
          expect(countStorageItems(scenario.after)).toBe(countStorageItems(scenario.before))
        }),
        { numRuns: PROPERTY_RUN_COUNT },
      )
    }),
  )
})
