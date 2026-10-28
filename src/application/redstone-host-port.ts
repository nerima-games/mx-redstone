/**
 * The host boundary this repository's own stages never cross.
 *
 * This responsibility moved from mc-compose's hand-rolled per-host runtime.
 * Block classification belongs here; hosts supply decoded addresses, block
 * names, local state reads, and request context.
 *
 * `RedstoneHostLookup` and `RedstoneHostWritePort` keep the seam
 * host-agnostic. This package does not own a concrete world representation or
 * mx-multiplayer state. The request builder supplies owner candidates, world
 * revisions, and an optional dimension-local `WorldWriteBatch`. An absent
 * container slot reading means the host cannot read one, not that it is empty.
 *
 * Lamp and door transitions stay semantic booleans. The host decides the
 * actual block id for a lit lamp or open door.
 *
 * The former fixed piston facing/kind and dropped note-block/trapdoor events
 * are handled here: lookup supplies the actual piston state, and every drained
 * event category reaches the single C4/C7 request builder.
 *
 * Piston planning remains in `domain/piston.ts`; the resulting plan is passed
 * to the builder and committed with the other events. We do not duplicate
 * `applyPistonPlan` validation because `planPistonTransition` establishes
 * those invariants by construction (state changes, facing-consistent moves,
 * and unique claims). The 100% `pnpm test:coverage` gate exposed that the
 * separate refusal branch was unreachable through this host path, as recorded
 * by DN-RS-11 and `docs/testing.md` §6-1.
 */
import {
  BLOCK_TYPES,
  type BlockAddress,
  BlockAxis,
  type BlockId,
  type BlockPosition,
  type BlockRegistryResolutionFailure,
  type BlockType,
  type WorldWriteBatch,
  WorldWriteBatchSchema,
  blockIdOf,
  capabilityOfBlockId,
  isBlockType,
} from '@nerima-games/mc-kernel'
import {
  type BlockCapabilityLookup,
  PISTON_PUSH_LIMIT,
  type PistonBlockOffset,
  PistonBlockOffsetSchema,
  type PistonCellRead,
  type PistonFacing,
  type PistonMovementPlan,
  type PistonPosition,
  planPistonTransition,
} from '../domain/piston.js'
import { Effect, Exit, Option, Result, Schema } from 'effect'
import {
  HOPPER_TRANSFER_COOLDOWN_GAME_TICKS,
  type HopperAdjacentContainer,
  type HopperTransferCandidate,
  type HopperTransferDueRequest,
  HopperTransferDueRequestSchema,
  type HopperTransferSelectionOutcome,
  hopperTransferDue,
  selectHopperTransferCandidates,
} from '../domain/hopper.js'
import type {
  HopperServiceApi,
  HopperServiceError,
  HopperTransferOutcome,
  HopperTransferRequest,
  WorldCommitCoordinatorApi,
  WorldCommitCoordinatorError,
  WorldCommitRequest,
} from '@nerima-games/mc-sim'
import {
  type HopperTransferEvent,
  type PoweredPistonTransition,
  type RedstoneComponentSnapshot,
  type RedstoneEventBatch,
  type RedstoneWorldRuntimeService,
  type RedstoneWorldSnapshot,
} from './world-runtime.js'
import type { ContainerSlot } from '../domain/comparator.js'

const blockAxis = BlockAxis
const schemaLiterals = Schema.Literals
const NO_COMPONENT = Option.getOrUndefined(Option.none<RedstoneComponentSnapshot>())

type RedstoneDimensionId = BlockAddress['dimension']

/** How far in front of a piston's base its head cell sits. */
const PISTON_HEAD_DISTANCE_BLOCKS = 1
const STICKY_PULL_SOURCE_DISTANCE_BLOCKS = 2
const PISTON_CELL_READ_STEP = 1
const EXPECTED_HOPPER_BLOCK_EDIT_COUNT = 1
const PISTON_HEAD_DISTANCE = Schema.decodeUnknownSync(PistonBlockOffsetSchema)(PISTON_HEAD_DISTANCE_BLOCKS)
const STICKY_PULL_SOURCE_DISTANCE = Schema.decodeUnknownSync(PistonBlockOffsetSchema)(STICKY_PULL_SOURCE_DISTANCE_BLOCKS)
const FIRST_EVENT_DIMENSION_INDEX = 0
const MAX_EVENT_DIMENSION_COUNT = 1
const STRICT_DECODE_OPTIONS = { onExcessProperty: 'error' } as const
const ZERO_EVENT_COUNT = 0

/** The mc-kernel capability name `kernelPistonCapabilities` reads. */
const PISTON_IMMOVABLE_CAPABILITY = 'pistonImmovable'

/** The block id an extended piston's head cell holds. */
const PISTON_HEAD_BLOCK = 'piston_head'

/** How far behind a comparator its rear (input) cell sits, and how far in front its output cell sits. */
const COMPARATOR_REAR_DISTANCE = 1

/** How far to either side of a comparator its two side-input cells sit. */
const COMPARATOR_SIDE_DISTANCE = 1

/**
 * `BlockCapabilityLookup` backed by mc-kernel's own capability table
 * (DN-RS-1), so a host no longer has to assemble this lookup itself the way
 * the mc-compose source did.
 */
export const kernelPistonCapabilities: BlockCapabilityLookup = {
  pistonImmovable: (block) => {
    if (!isBlockType(block)) {
      return Result.succeed(false)
    }
    return Option.match(blockIdOf(block), {
      onNone: () => Result.succeed(false),
      onSome: (blockId) => capabilityOfBlockId(blockId, PISTON_IMMOVABLE_CAPABILITY),
    })
  },
}

/** One decoded host block address and the block occupying it. */
const REDSTONE_HOST_BLOCK_TYPES = [...BLOCK_TYPES, 'sticky_piston'] as const

export type RedstoneHostBlockType = BlockType | 'sticky_piston'
export const RedstoneHostBlockTypeSchema: Schema.Codec<RedstoneHostBlockType, RedstoneHostBlockType> =
  schemaLiterals(REDSTONE_HOST_BLOCK_TYPES)

export type RedstoneHostBlock = {
  readonly address: BlockAddress
  readonly block: RedstoneHostBlockType | null
}

/**
 * Peripheral reads `componentForBlock` needs beyond the bare block string —
 * everything a `RedstoneComponentSnapshot` field can encode that this
 * repository cannot derive from the string alone.
 */
export type RedstoneHostLookup = {
  readonly isLeverActive: (position: BlockPosition) => boolean
  readonly isPoweredRailPowered: (position: BlockPosition) => boolean
  readonly readContainerSlots: (position: BlockPosition) => ReadonlyArray<ContainerSlot> | undefined
  readonly readHopperBlockId: (position: BlockPosition) => BlockId | null
  readonly readHopperTransferContext: (position: BlockPosition) => Readonly<{
    powered: boolean
    sourceAbove: HopperAdjacentContainer | null
    destinationFacing: HopperAdjacentContainer | null
  }>
  readonly readPistonCell: (position: BlockPosition) => PistonCellRead
  readonly readPistonFacing: (position: BlockPosition) => PistonFacing
}

type ExpectedHopperDimensionRevision = WorldCommitRequest['expectedDimensions'][number]['expectedRevision']

export type RedstoneHostHopperRevisionContext = Readonly<{
  expectedRevision: WorldCommitRequest['expectedRevision']
  expectedDimensionRevision: ExpectedHopperDimensionRevision
}>

type RedstoneHostCoordinatorPort = Pick<
  WorldCommitCoordinatorApi,
  'worldId' | 'commit' | 'revision' | 'dimensionRevision'
>
type RedstoneHostHopperService = Pick<HopperServiceApi, 'advanceCooldown' | 'transfer'>
type HopperCooldownRemaining = Extract<HopperTransferOutcome, { readonly _tag: 'CoolingDown' }>['ticks']
type HopperInvalidRequestReason = Extract<HopperTransferOutcome, { readonly _tag: 'InvalidRequest' }>['reason']

/**
 * The host supplies world context and builds the one request; this module
 * stages semantic outcomes but does not choose block ids or write world state.
 */
export type RedstoneHostWritePort<BuildError = never> = {
  readonly buildCommitRequest: (
    events: RedstoneEventBatch,
    pistonPlans: ReadonlyArray<PistonMovementPlan>,
  ) => Result.Result<WorldCommitRequest, BuildError>
  readonly buildHopperBlockWrite: (
    event: HopperTransferEvent,
    blockId: BlockId,
    revisions: RedstoneHostHopperRevisionContext,
  ) => Result.Result<WorldWriteBatch, BuildError>
  readonly coordinator: RedstoneHostCoordinatorPort
  readonly hopperService: RedstoneHostHopperService
}

/** One dimension's worth of host reads, addressed by a decoded kernel id. */
export type RedstoneHostRealm = {
  readonly dimension: RedstoneDimensionId
  readonly lookup: RedstoneHostLookup
}

export type RedstoneHostEventFailure =
  | Readonly<{ _tag: 'RedstoneHostMixedDimensions'; dimensions: ReadonlyArray<RedstoneDimensionId> }>
  | Readonly<{ _tag: 'RedstoneHostRealmMissing'; dimension: RedstoneDimensionId }>

export type RedstoneHostPositionFailure = Readonly<{ _tag: 'RedstoneHostPositionOutOfRange' }>

export type RedstoneHostHopperFailure =
  | Readonly<{ _tag: 'RedstoneHostHopperSelectionInvalid'; event: HopperTransferEvent }>
  | Readonly<{ _tag: 'RedstoneHostHopperBlockMissing'; event: HopperTransferEvent }>
  | Readonly<{ _tag: 'RedstoneHostHopperCooldownNotReady'; event: HopperTransferEvent; ticks: HopperCooldownRemaining }>
  | Readonly<{
      _tag: 'RedstoneHostHopperTransferInvalid'
      event: HopperTransferEvent
      reason: HopperInvalidRequestReason
    }>
  | Readonly<{ _tag: 'RedstoneHostHopperBlockWriteMismatch'; event: HopperTransferEvent }>

/** Includes `containerSlots` only when the host actually has a reading for this position. */
const withContainerSlots = (
  containerSlots: ReadonlyArray<ContainerSlot> | undefined,
): Partial<Record<'containerSlots', ReadonlyArray<ContainerSlot>>> => {
  if (typeof containerSlots === 'undefined') {
    return {}
  }
  return { containerSlots }
}

/** Whether a read piston head cell shows the piston currently extended. */
const isPistonHeadExtended = (head: PistonCellRead): boolean =>
  head.kind === 'block' && head.block === PISTON_HEAD_BLOCK

/** `isPistonHeadExtended`, named for the component snapshot field it fills. */
const pistonStateFromHead = (head: PistonCellRead): 'extended' | 'retracted' => {
  if (isPistonHeadExtended(head)) {
    return 'extended'
  }
  return 'retracted'
}

const pistonKindFromBlock = (block: RedstoneHostBlockType): 'normal' | 'sticky' => {
  if (block === 'sticky_piston') {
    return 'sticky'
  }
  return 'normal'
}

const blockPositionAt = (x: number, y: number, z: number): Result.Result<BlockPosition, RedstoneHostPositionFailure> => {
  if (![x, y, z].every(Number.isSafeInteger)) {
    return Result.fail({ _tag: 'RedstoneHostPositionOutOfRange' })
  }
  return Result.succeed({ x: blockAxis(x), y: blockAxis(y), z: blockAxis(z) })
}

const PISTON_FACING_OFFSETS: Readonly<Record<PistonFacing, Readonly<{ x: number; y: number; z: number }>>> = {
  down: { x: 0, y: -1, z: 0 },
  east: { x: 1, y: 0, z: 0 },
  north: { x: 0, y: 0, z: -1 },
  south: { x: 0, y: 0, z: 1 },
  up: { x: 0, y: 1, z: 0 },
  west: { x: -1, y: 0, z: 0 },
}

const safePistonPositionAt = (
  origin: BlockPosition,
  facing: PistonFacing,
  distance: PistonBlockOffset,
): Result.Result<BlockPosition, RedstoneHostPositionFailure> => {
  const offset = PISTON_FACING_OFFSETS[facing]
  return blockPositionAt(
    origin.x + offset.x * distance,
    origin.y + offset.y * distance,
    origin.z + offset.z * distance,
  )
}

const comparatorComponent = (
  lookup: RedstoneHostLookup,
  position: BlockPosition,
): Result.Result<RedstoneComponentSnapshot, RedstoneHostPositionFailure> =>
  Result.gen(function* comparatorComponentGenerator() {
    const inputFrom = yield* blockPositionAt(position.x, position.y, position.z + COMPARATOR_REAR_DISTANCE)
    const outputTo = yield* blockPositionAt(position.x, position.y, position.z - COMPARATOR_REAR_DISTANCE)
    const west = yield* blockPositionAt(position.x - COMPARATOR_SIDE_DISTANCE, position.y, position.z)
    const east = yield* blockPositionAt(position.x + COMPARATOR_SIDE_DISTANCE, position.y, position.z)
    return {
      inputFrom,
      kind: 'comparator',
      mode: 'compare',
      outputTo,
      position,
      sideInputs: [west, east],
      ...withContainerSlots(lookup.readContainerSlots(inputFrom)),
    }
  })

const pistonComponent = (
  lookup: RedstoneHostLookup,
  position: BlockPosition,
  block: RedstoneHostBlockType,
): Result.Result<RedstoneComponentSnapshot, RedstoneHostPositionFailure> => {
  const facing = lookup.readPistonFacing(position)
  return Result.map(
    safePistonPositionAt(position, facing, PISTON_HEAD_DISTANCE),
    (safeHeadPosition) => {
      const head = lookup.readPistonCell(safeHeadPosition)
      return {
        kind: 'piston',
        pistonFacing: facing,
        pistonKind: pistonKindFromBlock(block),
        pistonState: pistonStateFromHead(head),
        position,
      }
    },
  )
}

type ComponentBuilder = (
  lookup: RedstoneHostLookup,
  position: BlockPosition,
  block: RedstoneHostBlockType,
) => Result.Result<RedstoneComponentSnapshot, RedstoneHostPositionFailure>

/** A builder for the block kinds whose component needs no host lookup at all. */
const fixedKindComponent = (kind: RedstoneComponentSnapshot['kind']): ComponentBuilder => (_lookup, position) =>
  Result.succeed({ kind, position })

const poweredRailComponent: ComponentBuilder = (lookup, position) =>
  Result.succeed({ kind: 'powered-rail', position, powered: lookup.isPoweredRailPowered(position) })

const leverComponent: ComponentBuilder = (lookup, position) =>
  Result.succeed({ active: lookup.isLeverActive(position), kind: 'lever', position })

/**
 * This repository's own component roster (docs/responsibility.md §2-1),
 * keyed by the block string that names each part. `redstone_lamp` /
 * `redstone_lamp_lit` share one builder, as do `door` / `door_open` — the
 * block-name vocabulary tells this repository which STATE a lamp or door is
 * currently in, not that it should be classified any differently.
 */
const COMPONENT_BUILDERS: Readonly<Partial<Record<RedstoneHostBlockType, ComponentBuilder>>> = {
  comparator: comparatorComponent,
  dispenser: fixedKindComponent('dispenser'),
  door: fixedKindComponent('door'),
  door_open: fixedKindComponent('door'),
  dropper: fixedKindComponent('dropper'),
  hopper: fixedKindComponent('hopper'),
  lever: leverComponent,
  piston: pistonComponent,
  powered_rail: poweredRailComponent,
  redstone_lamp: fixedKindComponent('lamp'),
  redstone_lamp_lit: fixedKindComponent('lamp'),
  redstone_torch: fixedKindComponent('torch'),
  redstone_wire: fixedKindComponent('wire'),
  sticky_piston: pistonComponent,
}

/**
 * Classifies one host block into this repository's component roster, or
 * `undefined` when the block plays no redstone role. Piston facing and kind
 * come from host reads; see the file header for the event batch boundary.
 */
export const componentForBlock = (
  lookup: RedstoneHostLookup,
  block: RedstoneHostBlockType | null,
  position: BlockPosition,
): Result.Result<RedstoneComponentSnapshot | undefined, RedstoneHostPositionFailure> => {
  if (block === null) {
    return Result.succeed(NO_COMPONENT)
  }
  const builder = COMPONENT_BUILDERS[block]
  if (!builder) {
    return Result.succeed(NO_COMPONENT)
  }
  return builder(lookup, position, block)
}

/**
 * Builds one dimension's `RedstoneWorldSnapshot` from a host's raw block
 * list — the replacement for the mc-compose source's per-tick
 * `realm.core.snapshot().blocks.flatMap(componentForBlock)`.
 */
export const redstoneSnapshotFromRealm = (
  realm: RedstoneHostRealm,
  blocks: ReadonlyArray<RedstoneHostBlock>,
): Result.Result<RedstoneWorldSnapshot, RedstoneHostPositionFailure> =>
  Result.gen(function* redstoneSnapshotFromRealmGenerator() {
    const components = yield* Result.all(blocks.map(({ address, block }) =>
      componentForBlock(realm.lookup, block, address.position),
    ))
    return {
      components: components.filter((component): component is RedstoneComponentSnapshot => Boolean(component)),
      dimension: realm.dimension,
    }
  })

type PistonPlanReadState = {
  readonly realm: RedstoneHostRealm
  readonly event: PoweredPistonTransition
  readonly isExtension: boolean
  extensionReadCount: number
  positionFailure: Option.Option<RedstoneHostPositionFailure>
}

const pistonEventPreflightOffsets = (event: PoweredPistonTransition): ReadonlyArray<PistonBlockOffset> => {
  if (event.powered && event.state === 'retracted') {
    return [PISTON_HEAD_DISTANCE]
  }
  if (!event.powered && event.state === 'extended' && event.kind === 'sticky') {
    return [PISTON_HEAD_DISTANCE, STICKY_PULL_SOURCE_DISTANCE]
  }
  return []
}

const pistonEventPreflightFailure = (
  event: PoweredPistonTransition,
): Option.Option<RedstoneHostPositionFailure> => {
  for (const offset of pistonEventPreflightOffsets(event)) {
    const position = safePistonPositionAt(event.piston, event.facing, offset)
    if (Result.isFailure(position)) {
      return Option.some(position.failure)
    }
  }
  return Option.none()
}

const pistonCellOutOfWorld = (
  state: PistonPlanReadState,
  failure: RedstoneHostPositionFailure,
): PistonCellRead => {
  state.positionFailure = Option.some(failure)
  return { kind: 'out-of-world' }
}

const preflightPistonHead = (
  state: PistonPlanReadState,
  position: PistonPosition,
  cell: PistonCellRead,
): PistonCellRead => {
  if (!state.isExtension || cell.kind !== 'block' || state.extensionReadCount > PISTON_PUSH_LIMIT) {
    return cell
  }
  const immovable = kernelPistonCapabilities.pistonImmovable(cell.block)
  if (!Result.isSuccess(immovable) || immovable.success) {
    return cell
  }
  const nextPosition = safePistonPositionAt(position, state.event.facing, PISTON_HEAD_DISTANCE)
  if (Result.isFailure(nextPosition)) {
    return pistonCellOutOfWorld(state, nextPosition.failure)
  }
  return cell
}

const readPistonPlanCell = (state: PistonPlanReadState, position: PistonPosition): PistonCellRead => {
  if (state.isExtension) {
    state.extensionReadCount += PISTON_CELL_READ_STEP
  }
  const cell = state.realm.lookup.readPistonCell(position)
  return preflightPistonHead(state, position, cell)
}

const pistonPlanEffect = (
  outcome: ReturnType<typeof planPistonTransition>,
): Effect.Effect<Option.Option<PistonMovementPlan>, BlockRegistryResolutionFailure> => {
  if (outcome.kind === 'failed') {
    return Effect.fail(outcome.failure)
  }
  if (outcome.kind === 'move') {
    return Effect.succeed(Option.some(outcome.plan))
  }
  return Effect.succeed(Option.none())
}

const planPistonTransitionEvent = (
  realm: RedstoneHostRealm,
  event: PoweredPistonTransition,
): Effect.Effect<
  Option.Option<PistonMovementPlan>,
  BlockRegistryResolutionFailure | RedstoneHostPositionFailure
> => {
  const preflightFailure = pistonEventPreflightFailure(event)
  if (Option.isSome(preflightFailure)) {
    return Effect.fail(preflightFailure.value)
  }
  const readState: PistonPlanReadState = {
    event,
    extensionReadCount: 0,
    isExtension: event.powered && event.state === 'retracted',
    positionFailure: Option.none(),
    realm,
  }
  const outcome = planPistonTransition(
    event,
    { read: (position) => readPistonPlanCell(readState, position) },
    kernelPistonCapabilities,
  )
  return Option.match(readState.positionFailure, {
    onNone: () => pistonPlanEffect(outcome),
    onSome: (failure) => Effect.fail(failure),
  })
}


/** Gathers all five queues, including note-block and trapdoor events, before preflight. */
const drainRedstoneEvents = (runtime: RedstoneWorldRuntimeService): Effect.Effect<RedstoneEventBatch> =>
  Effect.gen(function* drainRedstoneEventsGenerator() {
    const [hopper, trigger, lamp, powered, piston] = yield* Effect.all([
      runtime.drainHopperTransferEvents,
      runtime.drainTriggerEvents,
      runtime.drainLampTransitions,
      runtime.drainPoweredComponentTransitions,
      runtime.drainPistonTransitions,
    ])
    return { hopper, lamp, piston, powered, trigger }
  })

const eventDimensions = (events: RedstoneEventBatch): ReadonlyArray<RedstoneDimensionId> =>
  [...new Set([
    ...events.hopper.map((event) => event.dimension),
    ...events.lamp.map((event) => event.dimension),
    ...events.piston.map((event) => event.dimension),
    ...events.powered.map((event) => event.dimension),
    ...events.trigger.map((event) => event.dimension),
  ])]

const redstoneEventBatchIsEmpty = (events: RedstoneEventBatch): boolean =>
  events.hopper.length + events.lamp.length + events.piston.length + events.powered.length + events.trigger.length ===
  ZERO_EVENT_COUNT

const realmForRedstoneEvents = (
  realms: ReadonlyArray<RedstoneHostRealm>,
  events: RedstoneEventBatch,
): Effect.Effect<Option.Option<RedstoneHostRealm>, RedstoneHostEventFailure> =>
  Effect.gen(function* realmForRedstoneEventsGenerator() {
    const dimensions = eventDimensions(events)
    if (dimensions.length > MAX_EVENT_DIMENSION_COUNT) {
      return yield* Effect.fail<RedstoneHostEventFailure>({ _tag: 'RedstoneHostMixedDimensions', dimensions })
    }
    const dimension = dimensions[FIRST_EVENT_DIMENSION_INDEX]
    if (typeof dimension === 'undefined') {
      return Option.none()
    }
    const realm = realms.find((candidate) => candidate.dimension === dimension)
    if (!realm) {
      return yield* Effect.fail<RedstoneHostEventFailure>({ _tag: 'RedstoneHostRealmMissing', dimension })
    }
    return Option.some(realm)
  })

const planEventPistons = (
  realm: RedstoneHostRealm,
  events: RedstoneEventBatch,
) => Effect.forEach(events.piston, (event) =>
    Effect.map(planPistonTransitionEvent(realm, event), (plan) => ({ event, plan })),
  )

type HopperCandidateOutcome = Extract<HopperTransferSelectionOutcome, { readonly _tag: 'Candidates' }>

type SelectedHopperEvent = Readonly<{
  dueRequest: HopperTransferDueRequest
  event: HopperTransferEvent
  outcome: Exclude<HopperTransferSelectionOutcome, { readonly _tag: 'InvalidRequest' }>
}>

type RedstoneHostEventProgress = {
  nonHopperEventsCommitted: boolean
  completedHopperEvents: number
}

const selectHopperEvent = (
  realm: RedstoneHostRealm,
  event: HopperTransferEvent,
): Effect.Effect<SelectedHopperEvent, Schema.SchemaError | RedstoneHostHopperFailure> => {
  const context = realm.lookup.readHopperTransferContext(event.position)
  const transferDueRequest = Schema.decodeUnknownResult(
    HopperTransferDueRequestSchema,
    STRICT_DECODE_OPTIONS,
  )({
    ...event.transferDueRequest,
    powered: context.powered || event.transferDueRequest.powered,
  })
  if (Result.isFailure(transferDueRequest)) {
    return Effect.fail(transferDueRequest.failure)
  }
  const outcome = selectHopperTransferCandidates({
    ...context,
    hopperAddress: { dimension: event.dimension, position: event.position },
    powered: transferDueRequest.success.powered,
  })
  if (outcome['_tag'] === 'InvalidRequest') {
    return Effect.fail<RedstoneHostHopperFailure>({
      _tag: 'RedstoneHostHopperSelectionInvalid',
      event,
    })
  }
  return Effect.succeed({
    dueRequest: transferDueRequest.success,
    event,
    outcome,
  })
}

const selectHopperEvents = (
  realm: RedstoneHostRealm,
  events: ReadonlyArray<HopperTransferEvent>,
): Effect.Effect<ReadonlyArray<SelectedHopperEvent>, Schema.SchemaError | RedstoneHostHopperFailure> =>
  Effect.forEach(events, (event) => selectHopperEvent(realm, event))

const sameBlockPosition = (left: BlockPosition, right: BlockPosition): boolean =>
  left.x === right.x && left.y === right.y && left.z === right.z

type HopperBlockWriteValidation = Readonly<{
  blockWrite: WorldWriteBatch
  blockId: BlockId
  coordinator: RedstoneHostCoordinatorPort
  event: HopperTransferEvent
  revisions: RedstoneHostHopperRevisionContext
}>

const blockWriteMatchesHopper = ({
  blockWrite,
  blockId,
  coordinator,
  event,
  revisions,
}: HopperBlockWriteValidation): boolean => {
  const [edit] = blockWrite.edits
  if (!edit) {
    return false
  }
  return (
    blockWrite.world === coordinator.worldId &&
    blockWrite.expectedWorldRevision === revisions.expectedRevision &&
    blockWrite.dimension === event.dimension &&
    blockWrite.expectedDimensionRevision === revisions.expectedDimensionRevision &&
    blockWrite.edits.length === EXPECTED_HOPPER_BLOCK_EDIT_COUNT &&
    edit.block === blockId &&
    sameBlockPosition(edit.position, event.position)
  )
}

type HopperCooldownAdvanceContext = Readonly<{
  coordinator: RedstoneHostCoordinatorPort
  event: HopperTransferEvent
  hopperAddress: BlockAddress
  hopperService: RedstoneHostHopperService
}>

const advanceHopperCooldown = (context: HopperCooldownAdvanceContext) =>
  Effect.gen(function* advanceHopperCooldownGenerator() {
    const cooldownRevision = yield* context.coordinator.revision
    const cooldownDimensionRevision = yield* context.coordinator.dimensionRevision(context.event.dimension)
    yield* context.hopperService.advanceCooldown({
      address: context.hopperAddress,
      expectedDimensionRevision: cooldownDimensionRevision,
      expectedRevision: cooldownRevision,
      ticks: HOPPER_TRANSFER_COOLDOWN_GAME_TICKS,
    })
  })

type HopperBlockWriteBuildContext<BuildError> = Readonly<{
  port: RedstoneHostWritePort<BuildError>
  event: HopperTransferEvent
  blockId: BlockId
  revisions: RedstoneHostHopperRevisionContext
}>

const buildValidatedHopperBlockWrite = <BuildError>(context: HopperBlockWriteBuildContext<BuildError>) =>
  Effect.gen(function* buildValidatedHopperBlockWriteGenerator() {
    const built = context.port.buildHopperBlockWrite(context.event, context.blockId, context.revisions)
    if (Result.isFailure(built)) {
      return yield* Effect.fail(built.failure)
    }
    const decoded = Schema.decodeUnknownResult(WorldWriteBatchSchema, STRICT_DECODE_OPTIONS)(built.success)
    if (Result.isFailure(decoded)) {
      return yield* Effect.fail(decoded.failure)
    }
    if (!blockWriteMatchesHopper({
      blockId: context.blockId,
      blockWrite: decoded.success,
      coordinator: context.port.coordinator,
      event: context.event,
      revisions: context.revisions,
    })) {
      return yield* Effect.fail<RedstoneHostHopperFailure>({
        _tag: 'RedstoneHostHopperBlockWriteMismatch',
        event: context.event,
      })
    }
    return decoded.success
  })

const isHopperCandidateOutcome = (
  outcome: SelectedHopperEvent['outcome'],
): outcome is HopperCandidateOutcome => outcome['_tag'] === 'Candidates'

type PreparedHopperTransfer<BuildError> = Readonly<{
  blockWrite: WorldWriteBatch
  candidates: HopperCandidateOutcome['candidates']
  event: HopperTransferEvent
  hopperAddress: BlockAddress
  port: RedstoneHostWritePort<BuildError>
}>

type HopperTransferPreparationContext<BuildError> = Readonly<{
  port: RedstoneHostWritePort<BuildError>
  realm: RedstoneHostRealm
  selected: SelectedHopperEvent
}>

type PreparedHopperTransferBuildContext<BuildError> = Readonly<{
  blockId: BlockId
  candidates: HopperCandidateOutcome['candidates']
  event: HopperTransferEvent
  hopperAddress: BlockAddress
  port: RedstoneHostWritePort<BuildError>
}>

const buildPreparedHopperTransfer = <BuildError>(context: PreparedHopperTransferBuildContext<BuildError>) =>
  Effect.gen(function* buildPreparedHopperTransferGenerator() {
    const revisions: RedstoneHostHopperRevisionContext = {
      expectedDimensionRevision: yield* context.port.coordinator.dimensionRevision(context.event.dimension),
      expectedRevision: yield* context.port.coordinator.revision,
    }
    const blockWrite = yield* buildValidatedHopperBlockWrite({
      blockId: context.blockId,
      event: context.event,
      port: context.port,
      revisions,
    })
    return {
      blockWrite,
      candidates: context.candidates,
      event: context.event,
      hopperAddress: context.hopperAddress,
      port: context.port,
    }
  })

const readHopperBlockId = (
  realm: RedstoneHostRealm,
  event: HopperTransferEvent,
): Effect.Effect<BlockId, RedstoneHostHopperFailure> => {
  const blockId = realm.lookup.readHopperBlockId(event.position)
  if (blockId === null) {
    return Effect.fail({
      _tag: 'RedstoneHostHopperBlockMissing',
      event,
    })
  }
  return Effect.succeed(blockId)
}

const prepareHopperTransfer = <BuildError>(context: HopperTransferPreparationContext<BuildError>) =>
  Effect.gen(function* prepareHopperTransferGenerator() {
    const { event } = context.selected
    if (!hopperTransferDue(context.selected.dueRequest)) {
      return Option.none<PreparedHopperTransfer<BuildError>>()
    }
    const hopperAddress: BlockAddress = { dimension: event.dimension, position: event.position }
    const blockId = yield* readHopperBlockId(context.realm, event)
    yield* advanceHopperCooldown({
      coordinator: context.port.coordinator,
      event,
      hopperAddress,
      hopperService: context.port.hopperService,
    })
    if (!isHopperCandidateOutcome(context.selected.outcome)) {
      return Option.none<PreparedHopperTransfer<BuildError>>()
    }
    const prepared = yield* buildPreparedHopperTransfer({
      blockId,
      candidates: context.selected.outcome.candidates,
      event,
      hopperAddress,
      port: context.port,
    })
    return Option.some(prepared)
  })

type HopperCandidateTransferContext<BuildError> = Readonly<{
  candidate: HopperTransferCandidate
  prepared: PreparedHopperTransfer<BuildError>
}>

const transferHopperCandidate = <BuildError>(context: HopperCandidateTransferContext<BuildError>) =>
  Effect.gen(function* transferHopperCandidateGenerator() {
    const request: HopperTransferRequest = {
      blockWrite: context.prepared.blockWrite,
      destination: context.candidate.destination,
      hopperAddress: context.prepared.hopperAddress,
      source: context.candidate.source,
    }
    const outcome: HopperTransferOutcome = yield* context.prepared.port.hopperService.transfer(request)
    if (outcome['_tag'] === 'Committed') {
      return true
    }
    if (outcome['_tag'] === 'TransferRejected') {
      return false
    }
    if (outcome['_tag'] === 'CoolingDown') {
      return yield* Effect.fail<RedstoneHostHopperFailure>({
        _tag: 'RedstoneHostHopperCooldownNotReady',
        event: context.prepared.event,
        ticks: outcome.ticks,
      })
    }
    return yield* Effect.fail<RedstoneHostHopperFailure>({
      _tag: 'RedstoneHostHopperTransferInvalid',
      event: context.prepared.event,
      reason: outcome.reason,
    })
  })

const transferHopperCandidates = <BuildError>(prepared: PreparedHopperTransfer<BuildError>) =>
  Effect.gen(function* transferHopperCandidatesGenerator() {
    for (const candidate of prepared.candidates) {
      const committed = yield* transferHopperCandidate({ candidate, prepared })
      if (committed) {
        return
      }
    }
  })

const applyHopperTransferEvent = <BuildError>(
  port: RedstoneHostWritePort<BuildError>,
  realm: RedstoneHostRealm,
  selected: SelectedHopperEvent,
): Effect.Effect<
  void,
  BuildError | Schema.SchemaError | WorldCommitCoordinatorError | HopperServiceError | RedstoneHostHopperFailure
> =>
  Effect.gen(function* applyHopperTransferEventGenerator() {
    const prepared = yield* prepareHopperTransfer({ port, realm, selected })
    if (Option.isNone(prepared)) {
      return
    }
    yield* transferHopperCandidates(prepared.value)
  })

const restoreAfterRedstoneFailure = (
  runtime: RedstoneWorldRuntimeService,
  events: RedstoneEventBatch,
  progress: RedstoneHostEventProgress,
): Effect.Effect<void> => {
  if (!progress.nonHopperEventsCommitted) {
    return runtime.restoreEvents(events)
  }
  const remainingHoppers = events.hopper.slice(progress.completedHopperEvents)
  return runtime.restoreEvents({
    hopper: remainingHoppers,
    lamp: [],
    piston: [],
    powered: [],
    trigger: [],
  })
}

const buildAndCommitRedstoneEvents = <BuildError>(
  port: RedstoneHostWritePort<BuildError>,
  events: RedstoneEventBatch,
  pistonPlans: ReadonlyArray<PistonMovementPlan>,
): Effect.Effect<void, BuildError | WorldCommitCoordinatorError> =>
  Effect.gen(function* buildAndCommitRedstoneEventsGenerator() {
    const built = port.buildCommitRequest(events, pistonPlans)
    if (Result.isFailure(built)) {
      return yield* Effect.fail(built.failure)
    }
    yield* port.coordinator.commit(built.success)
  })

type RedstoneCommitContext<BuildError> = Readonly<{
  events: RedstoneEventBatch
  port: RedstoneHostWritePort<BuildError>
  progress: RedstoneHostEventProgress
  realms: ReadonlyArray<RedstoneHostRealm>
}>

const commitPlannedPistons = <BuildError>(
  port: RedstoneHostWritePort<BuildError>,
  events: RedstoneEventBatch,
  plannedPistons: ReadonlyArray<Readonly<{ event: PoweredPistonTransition; plan: Option.Option<PistonMovementPlan> }>>,
) => {
  const pistonPlans = plannedPistons.flatMap(({ plan }) =>
    Option.match(plan, { onNone: () => [], onSome: (value) => [value] }),
  )
  const commitEvents: RedstoneEventBatch = {
    ...events,
    hopper: [],
    piston: plannedPistons.flatMap(({ event, plan }) =>
      Option.match(plan, { onNone: () => [], onSome: () => [event] }),
    ),
  }
  if (redstoneEventBatchIsEmpty(commitEvents)) {
    return Effect.void
  }
  return buildAndCommitRedstoneEvents(port, commitEvents, pistonPlans)
}

const applySelectedHopperEvents = <BuildError>(
  context: Readonly<{
    port: RedstoneHostWritePort<BuildError>
    progress: RedstoneHostEventProgress
    realm: RedstoneHostRealm
    selected: ReadonlyArray<SelectedHopperEvent>
  }>,
) =>
  Effect.gen(function* applySelectedHopperEventsGenerator() {
    for (const selected of context.selected) {
      yield* applyHopperTransferEvent(context.port, context.realm, selected)
      context.progress.completedHopperEvents += 1
    }
  })

const commitRedstoneEvents = <BuildError>(
  context: RedstoneCommitContext<BuildError>,
): Effect.Effect<
  void,
  BlockRegistryResolutionFailure | RedstoneHostEventFailure | RedstoneHostPositionFailure | RedstoneHostHopperFailure | BuildError | Schema.SchemaError | WorldCommitCoordinatorError | HopperServiceError
> =>
  Effect.gen(function* commitRedstoneEventsGenerator() {
    const realm = yield* realmForRedstoneEvents(context.realms, context.events)
    if (Option.isNone(realm)) {
      return
    }
    const plannedPistons = yield* planEventPistons(realm.value, context.events)
    const selectedHoppers = yield* selectHopperEvents(realm.value, context.events.hopper)
    yield* commitPlannedPistons(context.port, context.events, plannedPistons)
    context.progress.nonHopperEventsCommitted = true
    yield* applySelectedHopperEvents({
      port: context.port,
      progress: context.progress,
      realm: realm.value,
      selected: selectedHoppers,
    })
  })

/**
 * Drains every queue accumulated by `RedstoneWorldRuntime` and passes all
 * event categories to one request builder and coordinator commit. Call this
 * after the registered redstone stages (`redstone:power`, then
 * `redstone:effects`); `runtime.syncSnapshot` runs first through
 * `redstoneSnapshotFromRealm`. The batch is restored after a failed or
 * interrupted preflight/build/commit.
 */
export const applyRedstoneHostEvents = <BuildError>(
  runtime: RedstoneWorldRuntimeService,
  realms: ReadonlyArray<RedstoneHostRealm>,
  port: RedstoneHostWritePort<BuildError>,
): Effect.Effect<
  void,
  BlockRegistryResolutionFailure | RedstoneHostEventFailure | RedstoneHostPositionFailure | RedstoneHostHopperFailure | BuildError | Schema.SchemaError | WorldCommitCoordinatorError | HopperServiceError
> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* applyRedstoneHostEventsGenerator() {
      const events = yield* drainRedstoneEvents(runtime)
      const progress: RedstoneHostEventProgress = {
        completedHopperEvents: ZERO_EVENT_COUNT,
        nonHopperEventsCommitted: false,
      }
      const result = yield* Effect.exit(restore(commitRedstoneEvents({
        events,
        port,
        progress,
        realms,
      })))
      if (Exit.isFailure(result)) {
        yield* restoreAfterRedstoneFailure(runtime, events, progress)
        return yield* Effect.failCause(result.cause)
      }
    }),
  )
