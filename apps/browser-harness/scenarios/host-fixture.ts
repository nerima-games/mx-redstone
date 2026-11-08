import {
  BlockAddressSchema,
  BlockPositionSchema,
  DimensionIdSchema,
  EpochMillis,
  FixedClockLayer,
  MonotonicTimeSecs,
  NonNegativeTickCount,
  SimulationTickSchema,
  CHUNK_SIZE_XZ,
  chunkCoordOfBlock,
  DimensionRevisionSchema,
  WorldIdSchema,
  WorldRevisionSchema,
  WorldWriteBatchSchema,
  blockIdOf,
  defaultBlockState,
  encodeBlockState,
  isBlockType,
  type BlockAddress,
  type BlockPosition,
  type BlockStateValues,
  type StageRegistration,
} from '@nerima-games/mc-kernel'
import { ChunkCapacity, makeChunkStore, type ChunkStoreError } from '@nerima-games/mc-worldgen'
import { emptyBlocks } from '@nerima-games/mc-worldgen/testing'
import {
  CONTAINER_STORAGE_SNAPSHOT_VERSION,
  ContainerStorageService,
  ContainerStorageSnapshotSchema,
  ReplicatedOwnerIdSchema,
  containerCapacity,
  containerStorageOwnerRegistration,
  hopperOwnerRegistration,
  INITIAL_HOPPER_SERVICE_SNAPSHOT,
  HopperServiceSnapshotSchema,
  type HopperCooldownPlanRequest,
  type HopperServiceSnapshot,
  type HopperTransferOutcome,
  type HopperTransferTickPlanState,
  itemStack,
  makeContainerStorageService,
  makeHopperService,
  makeWorldCommitCoordinator,
  runStagesForTicks,
  worldContainerIdAt,
  WorldCommitCoordinator,
  type WorldCommitCoordinatorError,
  type WorldCommitPlanSnapshot,
  type WorldCommitRequest,
  type Container,
  type DomainEvent,
} from '@nerima-games/mc-sim'
import { Effect, Option, Result, Schema } from 'effect'
import {
  applyRedstoneHostEventsObserved,
  redstoneSnapshotFromRealm,
  RedstoneHostBlockTypeSchema,
  type RedstoneHostEventFailure,
  type RedstoneHostHopperFailure,
  type RedstoneHostPositionFailure,
  type PistonRefusalObservation,
  type RedstoneHostBlock,
  type RedstoneHostLookup,
  type RedstoneHostRealm,
  type RedstoneHostWritePort,
} from '../../../src/application/redstone-host-port.js'
import { observeRedstoneFrame, type RedstoneFrameObservation } from '../../../src/application/redstone-observation.js'
import {
  RedstoneWorldRuntime,
  RedstoneWorldRuntimeLayer,
  type RedstoneEventBatch,
  type RedstoneTickObservation,
  type RedstoneWorldRuntimeService,
  type RedstoneWorldSnapshot,
  redstoneTickObservationsFor,
  setRedstoneObservationEnabled,
} from '../../../src/application/world-runtime.js'
import { makeRuntimeRedstoneStages } from '../../../src/stages/registration.js'
import type {
  HostFixtureContainer,
  HostFixtureHopperContext,
  HostFixtureInput,
  HostFixtureRequest,
} from '../scenario-registry.js'
import type { PistonMovementOutcome } from '../../../src/domain/piston.js'

type RedstoneDimensionId = BlockAddress['dimension']

const TEST_WORLD_ID = Schema.decodeUnknownSync(WorldIdSchema)('redstone-browser-harness')
const HOPPER_BLOCK_ID = Option.getOrThrow(blockIdOf('hopper'))
const ZERO_REVISION = 0
const WORLD_REVISION = Schema.decodeUnknownSync(WorldRevisionSchema)(ZERO_REVISION)
const DIMENSION_REVISION = Schema.decodeUnknownSync(DimensionRevisionSchema)(ZERO_REVISION)
const GAME_TICKS_PER_REDSTONE_TICK = 2

export type HostFixtureResult = Readonly<{
  snapshot: RedstoneWorldSnapshot
  observation: RedstoneFrameObservation
  tickObservations: ReadonlyArray<RedstoneTickObservation>
  applyReached: boolean
  appliedRequests: ReadonlyArray<HostFixtureRequest>
  failures: ReadonlyArray<RedstoneHostEventFailure | RedstoneHostPositionFailure | RedstoneHostHopperFailure>
  drainedEventBatch: RedstoneEventBatch
  pistonPlanResults: ReadonlyArray<PistonMovementOutcome>
  pistonRefusals: ReadonlyArray<PistonRefusalObservation>
  hopperTransferResults: ReadonlyArray<HopperTransferOutcome>
}>

const dimensionId = (value: string): RedstoneDimensionId =>
  Schema.decodeUnknownSync(DimensionIdSchema)(value)

const blockPosition = (position: HostFixtureInput['blocks'][number]['position']): BlockPosition =>
  Schema.decodeUnknownSync(BlockPositionSchema)(position)

const blockAddress = (dimension: RedstoneDimensionId, position: BlockPosition): BlockAddress =>
  Schema.decodeUnknownSync(BlockAddressSchema)({ dimension, position })

const encodedStateFor = (block: RedstoneHostBlock['block'], state?: BlockStateValues): unknown => {
  if (block === null || block === 'sticky_piston' || block === 'redstone_wall_torch' || !isBlockType(block)) {
    return undefined
  }
  const blockId = Option.getOrUndefined(blockIdOf(block))
  if (typeof blockId === 'undefined') {
    return undefined
  }
  const defaults = defaultBlockState(blockId)
  if (Result.isFailure(defaults)) {
    return undefined
  }
  const encoded = encodeBlockState(blockId, { ...defaults.success, ...state })
  if (Result.isFailure(encoded)) {
    return undefined
  }
  return encoded.success
}

const rawBlocksFromInput = (
  input: HostFixtureInput,
  dimension = dimensionId(input.dimension),
): ReadonlyArray<RedstoneHostBlock> => input.blocks.map(({ block, position, state, strongPowerTo }) => {
  const decodedBlock = typeof block === 'string' ? Schema.decodeUnknownSync(RedstoneHostBlockTypeSchema)(block) : null
  return {
    address: blockAddress(dimension, blockPosition(position)),
    block: decodedBlock,
    ...(decodedBlock === null ? {} : { encodedState: encodedStateFor(decodedBlock, state) }),
    ...(typeof strongPowerTo === 'undefined' ? {} : { strongPowerTo: blockPosition(strongPowerTo) }),
  }
})

const hostRequestsFromEvents = (events: RedstoneEventBatch): ReadonlyArray<HostFixtureRequest> => [
  ...events.lamp.map((event): HostFixtureRequest => ({
    dimension: String(event.dimension),
    kind: 'lamp',
    position: { x: event.position.x, y: event.position.y, z: event.position.z },
  })),
  ...events.piston.map((event): HostFixtureRequest => ({
    dimension: String(event.dimension),
    kind: 'piston',
    position: { x: event.piston.x, y: event.piston.y, z: event.piston.z },
  })),
  ...events.hopper.map((event): HostFixtureRequest => ({
    dimension: String(event.dimension),
    kind: 'hopper',
    position: { x: event.position.x, y: event.position.y, z: event.position.z },
  })),
  ...events.trigger.map((event): HostFixtureRequest => ({
    component: event.kind,
    dimension: String(event.dimension),
    kind: 'trigger',
    position: { x: event.position.x, y: event.position.y, z: event.position.z },
  })),
  ...events.powered.map((event): HostFixtureRequest => ({
    component: event.kind,
    dimension: String(event.dimension),
    kind: 'powered',
    position: { x: event.position.x, y: event.position.y, z: event.position.z },
  })),
]

type HostFixtureLookup = RedstoneHostLookup & Readonly<{
  isRedstoneConductiveAt: NonNullable<RedstoneHostLookup['isRedstoneConductiveAt']>
}>

const hostLookup = (input: HostFixtureInput): HostFixtureLookup => ({
  isRedstoneConductiveAt: (position) => input.lookups?.conductivePositions?.some((candidate) =>
    samePosition(candidate, position)
  ) ?? false,
  isLeverActive: () => input.lookups?.leverActive ?? true,
  isPoweredRailPowered: () => input.lookups?.poweredRailPowered ?? false,
  readContainerSlots: () => input.lookups?.containerSlots,
  readHopperBlockId: () => input.failureCase === 'hopper-block-missing' ? null : HOPPER_BLOCK_ID,
  readHopperTransferContext: (position) => {
    const context = input.hopperContexts?.find((candidate) => samePosition(candidate.position, position))
    const sourceAbove = context?.sourceAbove === undefined || context.sourceAbove === null
      ? null
      : adjacentContainerFromInput(context.sourceAbove, input.dimension)
    const destinationFacing = context?.destinationFacing === undefined || context.destinationFacing === null
      ? null
      : adjacentContainerFromInput(context.destinationFacing, input.dimension)
    if (input.failureCase === 'hopper-selection-invalid' && !context?.powered && sourceAbove !== null) {
      const invalidContext = {
        powered: false,
        sourceAbove,
        destinationFacing,
        unexpected: true,
      }
      return invalidContext
    }
    if (input.failureCase === 'hopper-transfer-invalid' && !context?.powered && sourceAbove !== null) {
      return {
        powered: false,
        sourceAbove: { ...sourceAbove, address: { ...sourceAbove.address, dimension: dimensionId('nether') } },
        destinationFacing,
      }
    }
    return {
      powered: context?.powered ?? input.lookups?.hopperPowered ?? false,
      sourceAbove,
      destinationFacing,
    }
  },
  readObservedBlock: (position) => {
    const candidate = input.blocks.find((entry) => samePosition(entry.position, position))
    if (candidate === undefined || candidate.block === null) {
      return undefined
    }
    const block = Schema.decodeUnknownSync(RedstoneHostBlockTypeSchema)(candidate.block)
    return { block, encodedState: encodedStateFor(block, candidate.state) }
  },
  readPistonCell: (position) => {
    const block = input.blocks.find(({ position: candidate }) => samePosition(candidate, position))?.block
    return typeof block === 'string' ? { block, kind: 'block' } : { kind: 'empty' }
  },
})

const CHUNK_BIOME_COUNT = CHUNK_SIZE_XZ * CHUNK_SIZE_XZ

const samePosition = (
  left: Readonly<{ x: number; y: number; z: number }>,
  right: Readonly<{ x: number; y: number; z: number }>,
): boolean => left.x === right.x && left.y === right.y && left.z === right.z

const adjacentContainerFromInput = (
  input: NonNullable<HostFixtureHopperContext['sourceAbove']>,
  defaultDimension: string,
) => ({
  address: blockAddress(dimensionId(input.dimension ?? defaultDimension), blockPosition(input.position)),
  kind: input.kind,
})

const containerSlots = (container: HostFixtureContainer): Array<Container['slots'][number]> => {
  const slots: Array<Container['slots'][number]> = Array.from(
    { length: containerCapacity(container.kind) },
    () => null,
  )
  for (const [index, item] of container.items.entries()) {
    const stack = itemStack(item.item, item.count)
    if (Result.isFailure(stack)) {
      throw new Error(`Invalid fixture item ${item.item}`)
    }
    slots[index] = { ...stack.success, durability: null }
  }
  return slots
}

const containerStorageSnapshot = (
  input: HostFixtureInput,
  dimension: RedstoneDimensionId,
): Schema.Schema.Type<typeof ContainerStorageSnapshotSchema> =>
  Schema.decodeUnknownSync(ContainerStorageSnapshotSchema)({
    containers: (input.containers ?? []).map((container) => ({
      id: worldContainerIdAt(blockAddress(dimension, blockPosition(container.position))),
      kind: container.kind,
      slots: containerSlots(container),
    })),
    version: CONTAINER_STORAGE_SNAPSHOT_VERSION,
  })

const makeFixtureHopperServices = (
  input: HostFixtureInput,
  dimension: RedstoneDimensionId,
): Effect.Effect<Readonly<{
  coordinator: RedstoneHostWritePort['coordinator']
  hopperService: RedstoneHostWritePort['hopperService']
}>, ChunkStoreError | WorldCommitCoordinatorError> => Effect.gen(function* makeFixtureHopperServicesGenerator() {
  const containers = containerStorageSnapshot(input, dimension)
  const hopperState = Schema.decodeUnknownSync(HopperServiceSnapshotSchema)(INITIAL_HOPPER_SERVICE_SNAPSHOT)
  const chunkStore = yield* makeChunkStore(
    (coord) => Effect.succeed({
      biomes: Array.from({ length: CHUNK_BIOME_COUNT }, () => 'PLAINS' as const),
      blocks: emptyBlocks(),
      coord,
    }),
    ChunkCapacity(1),
  )
  const firstContainer = input.containers?.[0]
  const loadedPosition = blockPosition(firstContainer?.position ?? { x: 0, y: 0, z: 0 })
  yield* chunkStore.load(chunkCoordOfBlock(loadedPosition))
  const worldCoordinator = yield* makeWorldCommitCoordinator({
    chunkStores: { forDimension: () => chunkStore },
    owners: [
      containerStorageOwnerRegistration(containers),
      hopperOwnerRegistration(hopperState),
    ],
    world: TEST_WORLD_ID,
  })
  const storage = yield* Effect.provideService(
    makeContainerStorageService(),
    WorldCommitCoordinator,
    worldCoordinator,
  )
  const hopperService = yield* Effect.provideService(
    Effect.provideService(makeHopperService(), WorldCommitCoordinator, worldCoordinator),
    ContainerStorageService,
    storage,
  )
  return {
    coordinator: {
      commit: (request) => Effect.succeed({
        world: request.blockWrite?.world ?? TEST_WORLD_ID,
        revision: request.expectedRevision,
        changes: [],
        blockChanges: [],
      }),
      dimensionRevision: worldCoordinator.dimensionRevision,
      revision: worldCoordinator.revision,
      snapshot: worldCoordinator.snapshot,
      worldId: worldCoordinator.worldId,
    },
    hopperService,
  }
})

const hopperPlanCommittedEvent = (dimension: RedstoneDimensionId): DomainEvent => ({
  _tag: 'BlockChangedByWorld',
  address: blockAddress(dimension, blockPosition({ x: 10, y: 0, z: 4 })),
  cause: 'fire',
  tick: Schema.decodeUnknownSync(SimulationTickSchema)(1),
})

const fixtureWritePort = (
  dimension: RedstoneDimensionId,
  requests: Array<HostFixtureRequest>,
  pistonPlanResults: Array<PistonMovementOutcome>,
  hopperTransferResults: Array<HopperTransferOutcome>,
  input: HostFixtureInput,
  services: Readonly<{
    coordinator: RedstoneHostWritePort['coordinator']
    hopperService: RedstoneHostWritePort['hopperService']
  }>,
): RedstoneHostWritePort => {
  const ownerId = Schema.decodeUnknownSync(ReplicatedOwnerIdSchema)('redstone-browser-harness-owner')
  const transferEvent = hopperPlanCommittedEvent(dimension)
  let pendingRequests: ReadonlyArray<HostFixtureRequest> = []
  const hopperService: RedstoneHostWritePort['hopperService'] = {
    planAdvanceCooldown: (snapshot: WorldCommitPlanSnapshot<HopperServiceSnapshot>, request: HopperCooldownPlanRequest) =>
      services.hopperService.planAdvanceCooldown(snapshot, request),
    planTransferTick: (
      snapshot: WorldCommitPlanSnapshot<HopperTransferTickPlanState>,
      elapsedTicks,
      powered,
    ) => services.hopperService.planTransferTick(snapshot, elapsedTicks, powered).pipe(Effect.map((fragment) => {
        hopperTransferResults.push(fragment.result)
        if (input.failureCase === 'event-bus-unavailable' && (
          fragment.changes.length > 0 || fragment.blockEdits !== undefined
        )) {
          return { ...fragment, postCommitEvents: [transferEvent] }
        }
        return fragment
      })),
  }
  return {
    buildCommitRequest: (events, pistonPlans) => {
      pendingRequests = hostRequestsFromEvents(events)
      pistonPlanResults.push(...pistonPlans.map((plan): PistonMovementOutcome => ({ kind: 'move', plan })))
      const request: WorldCommitRequest = {
        expectedRevision: WORLD_REVISION,
        expectedDimensions: [{ dimension, expectedRevision: DIMENSION_REVISION }],
        changes: [{ ownerId, state: { events, pistonPlans } }],
      }
      return Result.succeed(request)
    },
    buildHopperBlockWrite: (event, blockId, revisions) => {
      const position = input.failureCase === 'hopper-block-write-mismatch'
        ? blockPosition({ x: event.position.x + 1, y: event.position.y, z: event.position.z })
        : event.position
      return Result.succeed(Schema.decodeUnknownSync(WorldWriteBatchSchema)({
        world: TEST_WORLD_ID,
        expectedWorldRevision: revisions.expectedRevision,
        dimension: event.dimension,
        expectedDimensionRevision: revisions.expectedDimensionRevision,
        edits: [{ position, block: blockId }],
      }))
    },
    coordinator: {
      ...services.coordinator,
      commit: (request) => Effect.sync(() => {
        requests.push(...pendingRequests)
        pendingRequests = []
        return {
          world: request.blockWrite?.world ?? TEST_WORLD_ID,
          revision: request.expectedRevision,
          changes: [],
          blockChanges: [],
        }
      }),
    },
    hopperService,
  }
}

type HostFixtureFailure =
  | RedstoneHostEventFailure
  | RedstoneHostPositionFailure
  | RedstoneHostHopperFailure

const isHostFixtureFailure = (failure: unknown): failure is HostFixtureFailure => {
  if (typeof failure !== 'object' || failure === null || !('_tag' in failure)) {
    return false
  }
  switch (failure._tag) {
    case 'RedstoneHostMixedDimensions':
    case 'RedstoneHostRealmMissing':
    case 'RedstoneHostEventBusUnavailable':
    case 'RedstoneHostPositionOutOfRange':
    case 'RedstoneHostHopperSelectionInvalid':
    case 'RedstoneHostHopperBlockMissing':
    case 'RedstoneHostHopperTransferInvalid':
    case 'RedstoneHostHopperBlockWriteMismatch':
      return true
    default:
      return false
  }
}

const emptyEventBatch = (): RedstoneEventBatch => ({
  hopper: [],
  lamp: [],
  piston: [],
  powered: [],
  trigger: [],
})

const mapEventDimension = <Event extends Readonly<{ dimension: RedstoneDimensionId }>>(
  events: ReadonlyArray<Event>,
  dimension: RedstoneDimensionId,
): ReadonlyArray<Event> => events.map((event) => ({ ...event, dimension }))

const captureDrain = <Event,>(
  effect: Effect.Effect<ReadonlyArray<Event>>,
  decorate: (events: ReadonlyArray<Event>) => ReadonlyArray<Event>,
  capture: (events: ReadonlyArray<Event>) => void,
): Effect.Effect<ReadonlyArray<Event>> => effect.pipe(
  Effect.map(decorate),
  Effect.tap((events) => Effect.sync(() => capture(events))),
)

const runtimeWithCapturedFixtureEvents = (
  runtime: RedstoneWorldRuntimeService,
  failureCase: HostFixtureInput['failureCase'],
  onDrain: (batch: RedstoneEventBatch) => void,
): RedstoneWorldRuntimeService => {
  const missingDimension = dimensionId('nether')
  const captureCategory = <Key extends keyof RedstoneEventBatch>(
    key: Key,
    events: RedstoneEventBatch[Key],
  ): void => {
    onDrain({ ...currentBatch, [key]: events })
    currentBatch = { ...currentBatch, [key]: events }
  }
  let currentBatch = emptyEventBatch()
  return {
    ...runtime,
    drainHopperTransferEvents: captureDrain(
      runtime.drainHopperTransferEvents,
      (events) => failureCase === 'realm-missing' ? mapEventDimension(events, missingDimension) : events,
      (events) => captureCategory('hopper', events),
    ),
    drainLampTransitions: captureDrain(
      runtime.drainLampTransitions,
      (events) => {
        if (failureCase === 'realm-missing') {
          return mapEventDimension(events, missingDimension)
        }
        if (failureCase === 'mixed-dimensions') {
          return events.concat({
            dimension: missingDimension,
            lit: true,
            position: blockPosition({ x: 11, y: 0, z: 0 }),
          })
        }
        return events
      },
      (events) => captureCategory('lamp', events),
    ),
    drainPistonTransitions: captureDrain(
      runtime.drainPistonTransitions,
      (events) => {
        if (failureCase === 'realm-missing') {
          return mapEventDimension(events, missingDimension)
        }
        if (failureCase === 'position-out-of-range') {
          return events.concat({
            dimension: dimensionId('overworld'),
            facing: 'east',
            kind: 'normal',
            piston: blockPosition({ x: Number.MAX_SAFE_INTEGER, y: 0, z: 0 }),
            powered: true,
            state: 'retracted',
          })
        }
        return events
      },
      (events) => captureCategory('piston', events),
    ),
    drainPoweredComponentTransitions: captureDrain(
      runtime.drainPoweredComponentTransitions,
      (events) => failureCase === 'realm-missing' ? mapEventDimension(events, missingDimension) : events,
      (events) => captureCategory('powered', events),
    ),
    drainTriggerEvents: captureDrain(
      runtime.drainTriggerEvents,
      (events) => failureCase === 'realm-missing' ? mapEventDimension(events, missingDimension) : events,
      (events) => captureCategory('trigger', events),
    ),
  }
}

const runStages = (stages: ReadonlyArray<StageRegistration>): Effect.Effect<void, unknown> => {
  const clock = FixedClockLayer({
    monotonicSecs: MonotonicTimeSecs(0),
    wallClockEpochMillis: EpochMillis(0),
  })
  return runStagesForTicks(stages, NonNegativeTickCount(GAME_TICKS_PER_REDSTONE_TICK))
    .pipe(Effect.provide(clock))
}

/** Builds the fixture with the production host builders and records the real apply path. */
export const buildHostFixture = (
  input: HostFixtureInput,
): Effect.Effect<HostFixtureResult, unknown> => {
  const requests: Array<HostFixtureRequest> = []
  const failures: Array<HostFixtureFailure> = []
  const pistonPlanResults: Array<PistonMovementOutcome> = []
  const pistonRefusals: Array<PistonRefusalObservation> = []
  const hopperTransferResults: Array<HopperTransferOutcome> = []
  const dimension = dimensionId(input.dimension)
  const lookup = hostLookup(input)
  const realm: RedstoneHostRealm = { dimension, lookup }
  const rawBlocks = rawBlocksFromInput(input)
  const hostSnapshot = redstoneSnapshotFromRealm(realm, rawBlocks)
  if (Result.isFailure(hostSnapshot)) {
    return Effect.fail(new Error('The host fixture contains an invalid block position'))
  }

  let applyReached = false
  const program = Effect.gen(function* buildHostFixtureGenerator() {
    const runtime = yield* RedstoneWorldRuntime
    const stages = yield* makeRuntimeRedstoneStages
    yield* runtime.syncSnapshot(hostSnapshot.success, { isRedstoneConductiveAt: lookup.isRedstoneConductiveAt })
    yield* setRedstoneObservationEnabled(runtime, true)
    yield* runStages(stages)
    const services = yield* makeFixtureHopperServices(input, dimension)
    let drainedEventBatch = emptyEventBatch()
    const capturingRuntime = runtimeWithCapturedFixtureEvents(
      runtime,
      input.failureCase,
      (batch) => { drainedEventBatch = batch },
    )
    applyReached = true
    const applyResult = yield* Effect.result(applyRedstoneHostEventsObserved({
      runtime: capturingRuntime,
      realms: [realm],
      port: fixtureWritePort(dimension, requests, pistonPlanResults, hopperTransferResults, input, services),
      observer: { onPistonRefusal: (observation) => pistonRefusals.push(observation) },
    }))
    if (Result.isFailure(applyResult)) {
      if (!isHostFixtureFailure(applyResult.failure)) {
        return yield* Effect.fail(applyResult.failure)
      }
      failures.push(applyResult.failure)
    }
    const observation = yield* observeRedstoneFrame(runtime)
    const tickObservations = yield* redstoneTickObservationsFor(runtime)
    return {
      appliedRequests: [...requests],
      applyReached,
      drainedEventBatch,
      failures,
      hopperTransferResults,
      observation,
      pistonPlanResults,
      pistonRefusals,
      snapshot: hostSnapshot.success,
      tickObservations,
    }
  }).pipe(Effect.provide(RedstoneWorldRuntimeLayer))

  return program
}
