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
  type BlockStateCodecFailure,
  type BlockStateFacing,
  BlockStateFacingSchema,
  type BlockStateValues,
  type BlockType,
  type Dimension,
  type WorldWriteBatch,
  WorldWriteBatchSchema,
  blockIdOf,
  blockPositionKeyOf,
  capabilityOfBlockId,
  decodeBlockState,
  isBlockType,
  NonNegativeTickCount as nonNegativeTickCount,
} from '@nerima-games/mc-kernel'
import {
  type BlockCapabilityLookup,
  PISTON_PUSH_LIMIT,
  type PistonBlockOffset,
  PistonBlockOffsetSchema,
  type PistonCellRead,
  type PistonFacing,
  type PistonMovementOutcome,
  type PistonMovementPlan,
  type PistonPosition,
  planPistonTransition,
} from '../domain/piston.js'
import {
  CONTAINER_STORAGE_REPLICATED_OWNER_ID,
  type ContainerStoragePlanSnapshot,
  ContainerStorageSnapshotSchema,
  type DomainEvent,
  type DomainEventBusApi,
  HOPPER_REPLICATED_OWNER_ID,
  HopperCooldownTicksSchema,
  type HopperElapsedTicks,
  HopperElapsedTicksSchema,
  type HopperServiceApi,
  type HopperServiceError,
  type HopperServiceSnapshot,
  HopperServiceSnapshotSchema,
  type HopperTransferOutcome,
  type HopperTransferTickPlanState,
  type WorldCommitCoordinatorApi,
  type WorldCommitCoordinatorError,
  type WorldCommitPlanConflict,
  type WorldCommitPlanFragment,
  type WorldCommitPlanSnapshot,
  type WorldCommitRequest,
  mergeWorldCommitPlans,
} from '@nerima-games/mc-sim'
import { Effect, Exit, Option, Result, Schema } from 'effect'
import {
  GAME_TICKS_PER_REDSTONE_TICK,
  type HopperAdjacentContainer,
  type HopperTransferSelectionOutcome,
  selectHopperTransferCandidates,
} from '../domain/hopper.js'
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
const structSchema = Schema.Struct
const schemaLiterals = Schema.Literals
const NO_COMPONENT = Option.getOrUndefined(Option.none<RedstoneComponentSnapshot>())

type RedstoneDimensionId = BlockAddress['dimension']

type RefusedPistonOutcome = Extract<PistonMovementOutcome, { readonly kind: 'refused' }>

export type PistonRefusalObservation = Readonly<{
  readonly event: PoweredPistonTransition
  readonly outcome: RefusedPistonOutcome
}>

export type RedstoneHostEventObserver = Readonly<{
  readonly onPistonRefusal: (observation: PistonRefusalObservation) => void
}>

type RedstoneHostEventApplyInput<BuildError> = Readonly<{
  readonly runtime: RedstoneWorldRuntimeService
  readonly realms: ReadonlyArray<RedstoneHostRealm>
  readonly port: RedstoneHostWritePort<BuildError>
  readonly observer: Option.Option<RedstoneHostEventObserver>
}>

const NO_HOST_EVENT_OBSERVER = Option.none<RedstoneHostEventObserver>()

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
const ONE_EVENT_COUNT = 1
const NO_RESULT: void = Option.getOrUndefined(Option.none<void>())
const ZERO_ELAPSED_TICKS = 0

/** The mc-kernel capability name `kernelPistonCapabilities` reads. */
const PISTON_IMMOVABLE_CAPABILITY = 'pistonImmovable'

/** How far to either side of a comparator its two side-input cells sit. */
const COMPARATOR_SIDE_DISTANCE = 1
/** A floor redstone torch is attached to, and inverted by, the block below it. */
const TORCH_SUPPORT_Y_OFFSET = -1

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
const REDSTONE_HOST_BLOCK_TYPES = [...BLOCK_TYPES, 'note_block', 'redstone_wall_torch', 'sticky_piston', 'trapdoor'] as const

export type RedstoneHostBlockType = BlockType | 'note_block' | 'redstone_wall_torch' | 'sticky_piston' | 'trapdoor'
export const RedstoneHostBlockTypeSchema: Schema.Codec<RedstoneHostBlockType, RedstoneHostBlockType> =
  schemaLiterals(REDSTONE_HOST_BLOCK_TYPES)

type BlockStateRequiredFields = Readonly<{
  comparator: readonly ['facing', 'mode', 'powered']
  dispenser: readonly ['facing', 'triggered']
  dropper: readonly ['facing', 'triggered']
  hopper: readonly ['facing', 'enabled']
  observer: readonly ['facing', 'powered']
  piston: readonly ['facing', 'extended']
  redstone_torch: readonly ['lit']
  repeater: readonly ['facing', 'delay', 'locked', 'powered']
}>

type StatefulHostBlockType = keyof BlockStateRequiredFields
type HorizontalFacing = Extract<BlockStateFacing, 'north' | 'east' | 'south' | 'west'>
type RequiredBlockState = {
  readonly [Block in StatefulHostBlockType]: Required<
    Pick<BlockStateValues, BlockStateRequiredFields[Block][number]>
  > & (Block extends 'comparator' | 'repeater' ? Readonly<{ facing: HorizontalFacing }> : unknown)
}
const horizontalFacingSchema = schemaLiterals(['east', 'north', 'south', 'west'] as const)
const comparatorModeSchema = schemaLiterals(['compare', 'subtract'] as const)
const ONE_TICK_DELAY = 1
const TWO_TICK_DELAY = 2
const THREE_TICK_DELAY = 3
const FOUR_TICK_DELAY = 4
const REPEATER_DELAY_VALUES = [ONE_TICK_DELAY, TWO_TICK_DELAY, THREE_TICK_DELAY, FOUR_TICK_DELAY] as const
const repeaterDelaySchema = schemaLiterals(REPEATER_DELAY_VALUES)
const comparatorBlockStateSchema: Schema.Codec<RequiredBlockState['comparator'], BlockStateValues> =
  structSchema({ facing: horizontalFacingSchema, mode: comparatorModeSchema, powered: Schema.Boolean })
const dispenserBlockStateSchema: Schema.Codec<RequiredBlockState['dispenser'], BlockStateValues> =
  structSchema({ facing: BlockStateFacingSchema, triggered: Schema.Boolean })
const hopperBlockStateSchema: Schema.Codec<RequiredBlockState['hopper'], BlockStateValues> =
  structSchema({ enabled: Schema.Boolean, facing: BlockStateFacingSchema })
const observerBlockStateSchema: Schema.Codec<RequiredBlockState['observer'], BlockStateValues> =
  structSchema({ facing: BlockStateFacingSchema, powered: Schema.Boolean })
const pistonBlockStateSchema: Schema.Codec<RequiredBlockState['piston'], BlockStateValues> =
  structSchema({ extended: Schema.Boolean, facing: BlockStateFacingSchema })
const torchBlockStateSchema: Schema.Codec<RequiredBlockState['redstone_torch'], BlockStateValues> =
  structSchema({ lit: Schema.Boolean })
const repeaterBlockStateSchema: Schema.Codec<RequiredBlockState['repeater'], BlockStateValues> = structSchema({
  delay: repeaterDelaySchema,
  facing: horizontalFacingSchema,
  locked: Schema.Boolean,
  powered: Schema.Boolean,
})

export type RedstoneHostBlock = {
  readonly address: BlockAddress
  readonly block: RedstoneHostBlockType | null
  readonly encodedState?: unknown
  readonly strongPowerTo?: BlockPosition
}

/** A block and its packed state read from an observer's watched position. */
export type RedstoneHostObservedBlock = Readonly<{
  readonly block: RedstoneHostBlockType
  readonly encodedState: unknown
}>

/**
 * Peripheral reads `componentForBlock` needs beyond the bare block string —
 * everything a `RedstoneComponentSnapshot` field can encode that this
 * repository cannot derive from the string alone.
 */
export type RedstoneHostLookup = {
  readonly isRedstoneConductiveAt?: (position: BlockPosition) => boolean
  readonly isLeverActive: (position: BlockPosition) => boolean
  readonly isButtonActive?: (position: BlockPosition) => boolean
  readonly isPoweredRailPowered: (position: BlockPosition) => boolean
  readonly readContainerSlots: (position: BlockPosition) => ReadonlyArray<ContainerSlot> | undefined
  readonly readHopperBlockId: (position: BlockPosition) => BlockId | null
  readonly readHopperTransferContext: (position: BlockPosition) => Readonly<{
    powered: boolean
    sourceAbove: HopperAdjacentContainer | null
    destinationFacing: HopperAdjacentContainer | null
  }>
  readonly readObservedBlock?: (position: BlockPosition) => RedstoneHostObservedBlock | undefined
  readonly readPistonCell: (position: BlockPosition) => PistonCellRead
}

type ExpectedHopperDimensionRevision = WorldCommitRequest['expectedDimensions'][number]['expectedRevision']

export type RedstoneHostHopperRevisionContext = Readonly<{
  expectedRevision: WorldCommitRequest['expectedRevision']
  expectedDimensionRevision: ExpectedHopperDimensionRevision
}>

type RedstoneHostCoordinatorPort = Pick<
  WorldCommitCoordinatorApi,
  'worldId' | 'commit' | 'revision' | 'dimensionRevision' | 'snapshot'
>
type RedstoneHostHopperService = Pick<HopperServiceApi, 'planAdvanceCooldown' | 'planTransferTick'>
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
  readonly eventBus?: DomainEventBusApi
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
  | Readonly<{ _tag: 'RedstoneHostEventBusUnavailable' }>

export type RedstoneHostPositionFailure = Readonly<{ _tag: 'RedstoneHostPositionOutOfRange' }>

export type RedstoneHostBlockStateFailure =
  | BlockStateCodecFailure
  | Readonly<{ _tag: 'RedstoneHostEncodedBlockStateMissing'; block: StatefulHostBlockType }>
  | Readonly<{ _tag: 'RedstoneHostBlockStateSchemaFailure'; block: StatefulHostBlockType }>
  | Readonly<{ _tag: 'RedstoneHostUnsupportedBlockState'; block: 'redstone_wall_torch' | 'sticky_piston' }>
  | Readonly<{ _tag: 'RedstoneHostObservedBlockUnavailable'; position: BlockPosition }>

export type RedstoneHostHopperFailure =
  | Readonly<{ _tag: 'RedstoneHostHopperSelectionInvalid'; event: HopperTransferEvent }>
  | Readonly<{ _tag: 'RedstoneHostHopperBlockMissing'; event: HopperTransferEvent }>
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

const encodedBlockStateBlockId = <Block extends StatefulHostBlockType>(
  block: Block,
  encodedState: unknown,
): Result.Result<BlockId, RedstoneHostBlockStateFailure> => {
  if (typeof encodedState === 'undefined') {
    return Result.fail({ _tag: 'RedstoneHostEncodedBlockStateMissing', block })
  }
  return Result.fromOption(blockIdOf(block), () => ({ _tag: 'BlockStateCodecFailure', reason: 'unknown-block-id' }))
}

/**
 * The kernel decoder emits every slot declared for the selected block ID.
 * Decode that complete value against a block-specific schema to recover the
 * required fields and horizontal facings without an unchecked assertion.
 */
const decodeRequiredBlockState = <State>(
  block: StatefulHostBlockType,
  encodedState: unknown,
  stateSchema: Schema.Codec<State, BlockStateValues>,
): Result.Result<State, RedstoneHostBlockStateFailure> => {
  const blockId = encodedBlockStateBlockId(block, encodedState)
  if (Result.isFailure(blockId)) {
    return Result.fail(blockId.failure)
  }
  const decoded = decodeBlockState(blockId.success, encodedState)
  if (Result.isFailure(decoded)) {
    return Result.fail(decoded.failure)
  }
  const state = Schema.decodeUnknownResult(stateSchema)(decoded.success)
  if (Result.isFailure(state)) {
    return Result.fail({ _tag: 'RedstoneHostBlockStateSchemaFailure', block })
  }
  return Result.succeed(state.success)
}

const oppositeFacing: Readonly<Record<BlockStateFacing, BlockStateFacing>> = {
  down: 'up',
  east: 'west',
  north: 'south',
  south: 'north',
  up: 'down',
  west: 'east',
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

type ComponentBuilderInput = Readonly<{
  block: RedstoneHostBlockType
  encodedState?: unknown
  lookup: RedstoneHostLookup
  position: BlockPosition
  strongPowerTo?: BlockPosition
}>

type RedstoneHostComponentFailure = RedstoneHostPositionFailure | RedstoneHostBlockStateFailure

const directionalCells = (
  position: BlockPosition,
  facing: BlockStateFacing,
): Result.Result<Readonly<{ inputFrom: BlockPosition; outputTo: BlockPosition }>, RedstoneHostPositionFailure> =>
  Result.gen(function* directionalCellsGenerator() {
    const inputFrom = yield* safePistonPositionAt(position, oppositeFacing[facing], PISTON_HEAD_DISTANCE)
    const outputTo = yield* safePistonPositionAt(position, facing, PISTON_HEAD_DISTANCE)
    return { inputFrom, outputTo }
  })

const comparatorSideInputs = (
  position: BlockPosition,
  facing: HorizontalFacing,
): Result.Result<ReadonlyArray<BlockPosition>, RedstoneHostComponentFailure> => {
  if (facing === 'north' || facing === 'south') {
    return Result.all([
      blockPositionAt(position.x - COMPARATOR_SIDE_DISTANCE, position.y, position.z),
      blockPositionAt(position.x + COMPARATOR_SIDE_DISTANCE, position.y, position.z),
    ])
  }
  return Result.all([
    blockPositionAt(position.x, position.y, position.z - COMPARATOR_SIDE_DISTANCE),
    blockPositionAt(position.x, position.y, position.z + COMPARATOR_SIDE_DISTANCE),
  ])
}

const comparatorComponent: ComponentBuilder = (input) =>
  Result.gen(function* comparatorComponentGenerator() {
    const state = yield* decodeRequiredBlockState('comparator', input.encodedState, comparatorBlockStateSchema)
    const cells = yield* directionalCells(input.position, state.facing)
    const sideInputs = yield* comparatorSideInputs(input.position, state.facing)
    return {
      facing: state.facing,
      inputFrom: cells.inputFrom,
      kind: 'comparator',
      mode: state.mode,
      outputTo: cells.outputTo,
      position: input.position,
      powered: state.powered,
      sideInputs,
      ...withContainerSlots(input.lookup.readContainerSlots(cells.inputFrom)),
    }
  })

const repeaterComponent: ComponentBuilder = (input) =>
  Result.gen(function* repeaterComponentGenerator() {
    const state = yield* decodeRequiredBlockState('repeater', input.encodedState, repeaterBlockStateSchema)
    const cells = yield* directionalCells(input.position, state.facing)
    return {
      delayTicks: nonNegativeTickCount(state.delay),
      facing: state.facing,
      inputFrom: cells.inputFrom,
      kind: 'repeater',
      locked: state.locked,
      outputTo: cells.outputTo,
      position: input.position,
      powered: state.powered,
    }
  })

const pistonStateFor = (extended: boolean): 'extended' | 'retracted' => {
  if (extended) {
    return 'extended'
  }
  return 'retracted'
}

const pistonComponent: ComponentBuilder = (input) =>
  Result.map(decodeRequiredBlockState('piston', input.encodedState, pistonBlockStateSchema), (state) => ({
      kind: 'piston',
      pistonFacing: state.facing,
      pistonKind: 'normal',
      pistonState: pistonStateFor(state.extended),
      position: input.position,
    }))

const observedBlockId = (block: RedstoneHostBlockType): Result.Result<BlockId, RedstoneHostBlockStateFailure> => {
  if (block === 'sticky_piston' || block === 'redstone_wall_torch') {
    return Result.fail({ _tag: 'RedstoneHostUnsupportedBlockState', block })
  }
  if (!isBlockType(block)) {
    return Result.fail({ _tag: 'BlockStateCodecFailure', reason: 'unknown-block-id' })
  }
  return Result.fromOption(blockIdOf(block), () => ({ _tag: 'BlockStateCodecFailure', reason: 'unknown-block-id' }))
}

const observerIdentityFromState = (
  block: RedstoneHostBlockType,
  encodedState: unknown,
): Result.Result<string, RedstoneHostBlockStateFailure> => {
  const blockId = observedBlockId(block)
  if (Result.isFailure(blockId)) {
    return Result.fail(blockId.failure)
  }
  const state = decodeBlockState(blockId.success, encodedState)
  if (Result.isFailure(state)) {
    return Result.fail(state.failure)
  }
  return Result.succeed(`${block}:${encodedState}`)
}

const observerIdentityAt = (
  lookup: RedstoneHostLookup,
  position: BlockPosition,
): Result.Result<string, RedstoneHostBlockStateFailure> => {
  const observed = lookup.readObservedBlock?.(position)
  if (typeof observed === 'undefined') {
    return Result.fail({ _tag: 'RedstoneHostObservedBlockUnavailable', position })
  }
  return observerIdentityFromState(observed.block, observed.encodedState)
}

const observerComponent: ComponentBuilder = (input) =>
  Result.gen(function* observerComponentGenerator() {
    const state = yield* decodeRequiredBlockState('observer', input.encodedState, observerBlockStateSchema)
    const inputFrom = yield* safePistonPositionAt(input.position, state.facing, PISTON_HEAD_DISTANCE)
    const outputTo = yield* safePistonPositionAt(input.position, oppositeFacing[state.facing], PISTON_HEAD_DISTANCE)
    const observedBlock = yield* observerIdentityAt(input.lookup, inputFrom)
    return {
      active: state.powered,
      facing: state.facing,
      inputFrom,
      kind: 'observer',
      observedBlock,
      outputTo,
      position: input.position,
      powered: state.powered,
    }
  })

const hopperComponent: ComponentBuilder = (input) =>
  Result.map(decodeRequiredBlockState('hopper', input.encodedState, hopperBlockStateSchema), (state) => ({
    enabled: state.enabled,
    facing: state.facing,
    kind: 'hopper',
    position: input.position,
  }))

const dispenserComponent = (kind: 'dispenser' | 'dropper'): ComponentBuilder => (input) =>
  Result.map(decodeRequiredBlockState(kind, input.encodedState, dispenserBlockStateSchema), (state) => ({
    facing: state.facing,
    kind,
    position: input.position,
    triggered: state.triggered,
  }))

const torchComponent: ComponentBuilder = (input) =>
  Result.gen(function* torchComponentGenerator() {
    const state = yield* decodeRequiredBlockState('redstone_torch', input.encodedState, torchBlockStateSchema)
    const invertedBy = yield* blockPositionAt(
      input.position.x,
      input.position.y + TORCH_SUPPORT_Y_OFFSET,
      input.position.z,
    )
    return {
      active: state.lit,
      invertedBy,
      kind: 'torch',
      position: input.position,
    }
  })

type ComponentPlacement = BlockPosition | Readonly<{
  position: BlockPosition
  encodedState?: unknown
  strongPowerTo?: BlockPosition
}>

const componentPlacement = (
  position: BlockPosition,
  strongPowerTo?: BlockPosition,
  encodedState?: unknown,
): ComponentPlacement => {
  if (typeof encodedState !== 'undefined') {
    if (typeof strongPowerTo !== 'undefined') {
      return { encodedState, position, strongPowerTo }
    }
    return { encodedState, position }
  }
  if (typeof strongPowerTo !== 'undefined') {
    return { position, strongPowerTo }
  }
  return position
}

type ComponentBuilder = (
  input: ComponentBuilderInput,
) => Result.Result<RedstoneComponentSnapshot, RedstoneHostComponentFailure>

/** A builder for the block kinds whose component needs no host lookup at all. */
const fixedKindComponent = (kind: RedstoneComponentSnapshot['kind']): ComponentBuilder => ({ position }) =>
  Result.succeed({ kind, position })

const poweredRailComponent: ComponentBuilder = ({ lookup, position }) =>
  Result.succeed({ kind: 'powered-rail', position, powered: lookup.isPoweredRailPowered(position) })

const strongPowerTarget = (strongPowerTo: BlockPosition | undefined): Partial<Pick<RedstoneComponentSnapshot, 'strongPowerTo'>> => {
  if (strongPowerTo) {
    return {
      strongPowerTo,
    }
  }
  return {}
}

const leverComponent: ComponentBuilder = ({ lookup, position, strongPowerTo }) =>
  Result.succeed({
    active: lookup.isLeverActive(position),
    kind: 'lever',
    position,
    ...strongPowerTarget(strongPowerTo),
  })

const buttonComponent: ComponentBuilder = ({ lookup, position, strongPowerTo }) =>
  Result.succeed({
    active: lookup.isButtonActive?.(position) ?? false,
    kind: 'button',
    position,
    ...strongPowerTarget(strongPowerTo),
  })

/**
 * This repository's own component roster (docs/responsibility.md §2-1),
 * keyed by the block string that names each part. `redstone_lamp` /
 * `redstone_lamp_lit` share one builder, as do `door` / `door_open` — the
 * block-name vocabulary tells this repository which STATE a lamp or door is
 * currently in, not that it should be classified any differently.
 */
const COMPONENT_BUILDERS: Readonly<Partial<Record<RedstoneHostBlockType, ComponentBuilder>>> = {
  comparator: comparatorComponent,
  dispenser: dispenserComponent('dispenser'),
  door: fixedKindComponent('door'),
  door_open: fixedKindComponent('door'),
  dropper: dispenserComponent('dropper'),
  hopper: hopperComponent,
  lever: leverComponent,
  note_block: fixedKindComponent('note-block'),
  observer: observerComponent,
  piston: pistonComponent,
  powered_rail: poweredRailComponent,
  redstone_lamp: fixedKindComponent('lamp'),
  redstone_lamp_lit: fixedKindComponent('lamp'),
  redstone_torch: torchComponent,
  redstone_wire: fixedKindComponent('wire'),
  repeater: repeaterComponent,
  stone_button: buttonComponent,
  trapdoor: fixedKindComponent('trapdoor'),
}

const componentBuilderInput = (
  lookup: RedstoneHostLookup,
  block: RedstoneHostBlockType,
  placement: ComponentPlacement,
): ComponentBuilderInput => {
  if (!('position' in placement)) {
    return { block, lookup, position: placement }
  }
  const input: ComponentBuilderInput = {
    block,
    lookup,
    position: placement.position,
    ...strongPowerTarget(placement.strongPowerTo),
  }
  if (typeof placement.encodedState === 'undefined') {
    return input
  }
  return { ...input, encodedState: placement.encodedState }
}

/**
 * Classifies one host block into this repository's component roster, or
 * `undefined` when the block plays no redstone role. Stateful components use
 * their packed kernel state; dynamic world facts remain host reads.
 */
export const componentForBlock = (
  lookup: RedstoneHostLookup,
  block: RedstoneHostBlockType | null,
  placement: ComponentPlacement,
): Result.Result<RedstoneComponentSnapshot | undefined, RedstoneHostComponentFailure> => {
  if (block === null) {
    return Result.succeed(NO_COMPONENT)
  }
  if (block === 'sticky_piston' || block === 'redstone_wall_torch') {
    return Result.fail({ _tag: 'RedstoneHostUnsupportedBlockState', block })
  }
  const builder = COMPONENT_BUILDERS[block]
  if (!builder) {
    return Result.succeed(NO_COMPONENT)
  }
  return builder(componentBuilderInput(lookup, block, placement))
}

/**
 * Builds one dimension's `RedstoneWorldSnapshot` from a host's raw block
 * list — the replacement for the mc-compose source's per-tick
 * `realm.core.snapshot().blocks.flatMap(componentForBlock)`.
 */
export const redstoneSnapshotFromRealm = (
  realm: RedstoneHostRealm,
  blocks: ReadonlyArray<RedstoneHostBlock>,
): Result.Result<RedstoneWorldSnapshot, RedstoneHostComponentFailure> =>
  Result.gen(function* redstoneSnapshotFromRealmGenerator() {
    const components = yield* Result.all(blocks.map(({ address, block, strongPowerTo, encodedState }) =>
      componentForBlock(realm.lookup, block, componentPlacement(address.position, strongPowerTo, encodedState)),
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
  event: PoweredPistonTransition,
  outcome: ReturnType<typeof planPistonTransition>,
  observer: Option.Option<RedstoneHostEventObserver>,
): Effect.Effect<Option.Option<PistonMovementPlan>, BlockRegistryResolutionFailure> => {
  if (outcome.kind === 'failed') {
    return Effect.fail(outcome.failure)
  }
  if (outcome.kind === 'move') {
    return Effect.succeed(Option.some(outcome.plan))
  }
  if (outcome.kind === 'refused' && Option.isSome(observer)) {
    observer.value.onPistonRefusal({ event, outcome })
  }
  return Effect.succeed(Option.none())
}

const planPistonTransitionEvent = (
  realm: RedstoneHostRealm,
  event: PoweredPistonTransition,
  observer: Option.Option<RedstoneHostEventObserver>,
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
    onNone: () => pistonPlanEffect(event, outcome, observer),
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
  observer: Option.Option<RedstoneHostEventObserver>,
) => Effect.forEach(events.piston, (event) =>
  Effect.map(planPistonTransitionEvent(realm, event, observer), (plan) => ({ event, plan })),
  )

type SelectedHopperEvent = Readonly<{
  elapsedTicks: HopperElapsedTicks
  event: HopperTransferEvent
  outcome: Exclude<HopperTransferSelectionOutcome, { readonly _tag: 'InvalidRequest' }>
  powered: boolean
}>

type RedstonePlanBase = Readonly<{
  world: WorldCommitPlanSnapshot<unknown>['world']
  expectedRevision: WorldCommitPlanSnapshot<unknown>['expectedRevision']
  expectedDimensions: WorldCommitPlanSnapshot<unknown>['expectedDimensions']
  hoppers: HopperServiceSnapshot
  containers: Schema.Schema.Type<typeof ContainerStorageSnapshotSchema>
}>

type VirtualHopperState = Readonly<{
  hoppers: HopperServiceSnapshot
  containers: Schema.Schema.Type<typeof ContainerStorageSnapshotSchema>
}>

const captureRedstonePlanBase = (
  port: RedstoneHostWritePort<unknown>,
  dimension: RedstoneDimensionId,
) => Effect.gen(function* captureRedstonePlanBaseGenerator() {
  const [hoppers, containers, revisionBefore, expectedDimensionRevision] = yield* Effect.all([
    port.coordinator.snapshot(HOPPER_REPLICATED_OWNER_ID, HopperServiceSnapshotSchema),
    port.coordinator.snapshot(CONTAINER_STORAGE_REPLICATED_OWNER_ID, ContainerStorageSnapshotSchema),
    port.coordinator.revision,
    port.coordinator.dimensionRevision(dimension),
  ])
  const revisionAfter = yield* port.coordinator.revision
  if (hoppers.world !== containers.world || hoppers.world !== port.coordinator.worldId) {
    return yield* Effect.fail<WorldCommitPlanConflict>({
      _tag: 'WorldCommitPlanWorldConflict',
      actual: containers.world,
      expected: port.coordinator.worldId,
    })
  }
  for (const actualRevision of [containers.revision, revisionBefore, revisionAfter]) {
    if (actualRevision !== hoppers.revision) {
      return yield* Effect.fail<WorldCommitPlanConflict>({
        _tag: 'WorldCommitPlanRevisionConflict',
        actual: actualRevision,
        expected: hoppers.revision,
      })
    }
  }
  return {
    containers: containers.state,
    expectedDimensions: [{ dimension, expectedRevision: expectedDimensionRevision }],
    expectedRevision: hoppers.revision,
    hoppers: hoppers.state,
    world: hoppers.world,
  } satisfies RedstonePlanBase
})

const selectHopperEventPower = (
  contextPowered: boolean,
  sampledPower: boolean,
  preserveSampledPower: boolean,
): boolean => {
  if (preserveSampledPower) {
    return sampledPower
  }
  return contextPowered || sampledPower
}

const selectHopperEvent = (
  realm: RedstoneHostRealm,
  event: HopperTransferEvent,
  preserveSampledPower: boolean,
): Effect.Effect<SelectedHopperEvent, Schema.SchemaError | RedstoneHostHopperFailure> => {
  const { dimension, elapsedRedstoneTicks, powered: sampledPower, position } = event
  const context = realm.lookup.readHopperTransferContext(position)
  const elapsedTicks = Schema.decodeUnknownResult(HopperElapsedTicksSchema, STRICT_DECODE_OPTIONS)(
    elapsedRedstoneTicks * GAME_TICKS_PER_REDSTONE_TICK,
  )
  if (Result.isFailure(elapsedTicks)) {
    return Effect.fail(elapsedTicks.failure)
  }
  const powered = selectHopperEventPower(context.powered, sampledPower, preserveSampledPower)
  const outcome = selectHopperTransferCandidates({
    ...context,
    hopperAddress: { dimension, position },
    powered,
  })
  if (outcome['_tag'] === 'InvalidRequest') {
    return Effect.fail<RedstoneHostHopperFailure>({
      _tag: 'RedstoneHostHopperSelectionInvalid',
      event,
    })
  }
  return Effect.succeed({ elapsedTicks: elapsedTicks.success, event, outcome, powered })
}

const selectHopperEvents = (
  realm: RedstoneHostRealm,
  events: ReadonlyArray<HopperTransferEvent>,
): Effect.Effect<ReadonlyArray<SelectedHopperEvent>, Schema.SchemaError | RedstoneHostHopperFailure> => {
  const eventCounts = new Map<string, number>()
  for (const event of events) {
    const key = blockPositionKeyOf(event.position)
    eventCounts.set(key, (eventCounts.get(key) ?? ZERO_EVENT_COUNT) + ONE_EVENT_COUNT)
  }
  const repeatedPositions = new Set<string>()
  for (const [key, count] of eventCounts) {
    if (count > ONE_EVENT_COUNT) {
      repeatedPositions.add(key)
    }
  }
  return Effect.forEach(events, (event) =>
    selectHopperEvent(
      realm,
      event,
      repeatedPositions.has(blockPositionKeyOf(event.position)),
    ),
  )
}

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

const planSnapshotForHopper = (
  base: RedstonePlanBase,
  virtual: VirtualHopperState,
  intent: HopperTransferTickPlanState['intent'],
): WorldCommitPlanSnapshot<HopperTransferTickPlanState> => ({
  expectedDimensions: base.expectedDimensions,
  expectedRevision: base.expectedRevision,
  state: {
    containers: {
      expectedDimensions: base.expectedDimensions,
      expectedRevision: base.expectedRevision,
      state: virtual.containers,
      world: base.world,
    } satisfies ContainerStoragePlanSnapshot,
    hoppers: virtual.hoppers,
    intent,
    player: { _tag: 'None' },
  },
  world: base.world,
})

const virtualStateAfterFragment = (
  virtual: VirtualHopperState,
  fragment: WorldCommitPlanFragment<unknown>,
) => Effect.gen(function* virtualStateAfterFragmentGenerator() {
  const hopperChange = Option.fromUndefinedOr(
    fragment.changes.find(({ ownerId }) => ownerId === HOPPER_REPLICATED_OWNER_ID),
  )
  const containerChange = Option.fromUndefinedOr(
    fragment.changes.find(({ ownerId }) => ownerId === CONTAINER_STORAGE_REPLICATED_OWNER_ID),
  )
  const containers = yield* Option.match(containerChange, {
    onNone: () => Effect.succeed(virtual.containers),
    onSome: ({ state }) => Schema.decodeUnknownEffect(ContainerStorageSnapshotSchema)(state),
  })
  const hoppers = yield* Option.match(hopperChange, {
    onNone: () => Effect.succeed(virtual.hoppers),
    onSome: ({ state }) => Schema.decodeUnknownEffect(HopperServiceSnapshotSchema)(state),
  })
  return { containers, hoppers } satisfies VirtualHopperState
})

type SelectedHopperPlanContext<BuildError> = Readonly<{
  base: RedstonePlanBase
  port: RedstoneHostWritePort<BuildError>
  realm: RedstoneHostRealm
  selected: SelectedHopperEvent
  virtual: VirtualHopperState
}>

type HopperTransferCandidate = Extract<
  HopperTransferSelectionOutcome,
  { readonly _tag: 'Candidates' }
>['candidates'][number]

type CandidateHopperTransferPlanContext<BuildError> = Readonly<{
  blockWrite: WorldWriteBatch
  candidate: HopperTransferCandidate
  planContext: SelectedHopperPlanContext<BuildError>
  virtual: VirtualHopperState
}>

const hopperRevisionContext = (
  base: RedstonePlanBase,
  dimension: Dimension,
): Effect.Effect<RedstoneHostHopperRevisionContext, WorldCommitPlanConflict> => {
  const expected = Option.fromUndefinedOr(
    base.expectedDimensions.find((entry) => entry.dimension === dimension),
  )
  return Option.match(expected, {
    onNone: () => Effect.fail({
      _tag: 'WorldCommitPlanDimensionRevisionMissing',
      dimension,
    }),
    onSome: ({ expectedRevision }) => Effect.succeed({
      expectedDimensionRevision: expectedRevision,
      expectedRevision: base.expectedRevision,
    }),
  })
}

const planCandidateHopperTransfer = <BuildError>(
  context: CandidateHopperTransferPlanContext<BuildError>,
) => Effect.gen(function* planCandidateHopperTransferGenerator() {
  const { event, elapsedTicks, powered } = context.planContext.selected
  const { candidate, planContext } = context
  const fragment = yield* planContext.port.hopperService.planTransferTick(
    planSnapshotForHopper(planContext.base, context.virtual, {
      blockEdits: { dimension: context.blockWrite.dimension, edits: context.blockWrite.edits },
      destination: candidate.destination,
      hopperAddress: { dimension: event.dimension, position: event.position },
      source: candidate.source,
    }),
    elapsedTicks,
    powered,
  )
  if (fragment.result['_tag'] === 'InvalidRequest') {
    return yield* Effect.fail<RedstoneHostHopperFailure>({
      _tag: 'RedstoneHostHopperTransferInvalid',
      event,
      reason: fragment.result.reason,
    })
  }
  return {
    fragment,
    virtual: yield* virtualStateAfterFragment(context.virtual, fragment),
  }
})

const planCandidateHopperTransfers = <BuildError>(
  context: Readonly<{
    blockWrite: WorldWriteBatch
    candidates: ReadonlyArray<HopperTransferCandidate>
    planContext: SelectedHopperPlanContext<BuildError>
  }>,
) => Effect.gen(function* planCandidateHopperTransfersGenerator() {
  const { blockWrite, candidates, planContext } = context
  const plan: {
    fragments: Array<WorldCommitPlanFragment<unknown>>
    virtual: VirtualHopperState
  } = {
    fragments: [],
    virtual: planContext.virtual,
  }
  for (const candidate of candidates) {
    const { fragment, virtual: nextVirtual } = yield* planCandidateHopperTransfer({
      blockWrite,
      candidate,
      planContext,
      virtual: plan.virtual,
    })
    plan.fragments.push(fragment)
    plan.virtual = nextVirtual
    if (fragment.result['_tag'] !== 'TransferRejected') {
      break
    }
  }
  return plan
})

const planCandidateHopperEvent = <BuildError>(
  context: Readonly<{
    candidates: ReadonlyArray<HopperTransferCandidate>
    planContext: SelectedHopperPlanContext<BuildError>
  }>,
) => Effect.gen(function* planCandidateHopperEventGenerator() {
  const { event } = context.planContext.selected
  const blockId = yield* readHopperBlockId(context.planContext.realm, event)
  const revisions = yield* hopperRevisionContext(context.planContext.base, event.dimension)
  const blockWrite = yield* buildValidatedHopperBlockWrite({
    blockId,
    event,
    port: context.planContext.port,
    revisions,
  })
  return yield* planCandidateHopperTransfers({
    blockWrite,
    candidates: context.candidates,
    planContext: context.planContext,
  })
})

const planHopperCooldownEvent = <BuildError>(
  context: SelectedHopperPlanContext<BuildError>,
) => Effect.gen(function* planHopperCooldownEventGenerator() {
  const { elapsedTicks, event } = context.selected
  const ticks = yield* Schema.decodeUnknownEffect(HopperCooldownTicksSchema)(elapsedTicks)
  const fragment = yield* context.port.hopperService.planAdvanceCooldown({
    expectedDimensions: context.base.expectedDimensions,
    expectedRevision: context.base.expectedRevision,
    state: context.virtual.hoppers,
    world: context.base.world,
  }, { address: { dimension: event.dimension, position: event.position }, ticks })
  return {
    fragments: [fragment],
    virtual: yield* virtualStateAfterFragment(context.virtual, fragment),
  }
})

const planSelectedHopperEvent = <BuildError>(
  context: SelectedHopperPlanContext<BuildError>,
) => Effect.gen(function* planSelectedHopperEventGenerator() {
  const { elapsedTicks, outcome, powered } = context.selected
  if (powered) {
    if (elapsedTicks > ZERO_ELAPSED_TICKS) {
      return yield* planHopperCooldownEvent(context)
    }
    return { fragments: [], virtual: context.virtual }
  }
  if (outcome['_tag'] === 'Candidates') {
    return yield* planCandidateHopperEvent({
      candidates: outcome.candidates,
      planContext: context,
    })
  }
  if (outcome['_tag'] === 'NoCandidates' && elapsedTicks > ZERO_ELAPSED_TICKS) {
    return yield* planHopperCooldownEvent(context)
  }
  return { fragments: [], virtual: context.virtual }
})

type HopperPlanMergeAccumulator = {
  changesByOwner: Map<string, WorldCommitPlanFragment<unknown>['changes'][number]>
  dimensions: Set<Dimension>
  editsByPosition: Map<string, WorldWriteBatch['edits'][number]>
  postCommitEvents: Array<WorldCommitPlanFragment<unknown>['postCommitEvents'][number]>
}

const addHopperBlockEdits = (
  accumulator: HopperPlanMergeAccumulator,
  blockEdits: NonNullable<WorldCommitPlanFragment<unknown>['blockEdits']>,
): Option.Option<WorldCommitPlanConflict> => {
  accumulator.dimensions.add(blockEdits.dimension)
  for (const edit of blockEdits.edits) {
    const key = blockPositionKeyOf(edit.position)
    const existing = Option.fromUndefinedOr(accumulator.editsByPosition.get(key))
    if (Option.isSome(existing) && existing.value.block !== edit.block) {
      return Option.some({
        _tag: 'WorldCommitPlanBlockConflict',
        dimension: blockEdits.dimension,
        position: edit.position,
      })
    }
    accumulator.editsByPosition.set(key, edit)
  }
  return Option.none()
}

const accumulateHopperPlanFragment = (
  accumulator: HopperPlanMergeAccumulator,
  fragment: WorldCommitPlanFragment<unknown>,
): Option.Option<WorldCommitPlanConflict> => {
  for (const change of fragment.changes) {
    accumulator.changesByOwner.set(change.ownerId, change)
  }
  accumulator.postCommitEvents.push(...fragment.postCommitEvents)
  return Option.match(Option.fromUndefinedOr(fragment.blockEdits), {
    onNone: () => Option.none(),
    onSome: (blockEdits) => addHopperBlockEdits(accumulator, blockEdits),
  })
}

const combineHopperPlanFragments = (
  base: RedstonePlanBase,
  fragments: ReadonlyArray<WorldCommitPlanFragment<unknown>>,
): Result.Result<WorldCommitPlanFragment<void>, WorldCommitPlanConflict> => {
  const accumulator: HopperPlanMergeAccumulator = {
    changesByOwner: new Map(),
    dimensions: new Set(),
    editsByPosition: new Map(),
    postCommitEvents: [],
  }
  for (const fragment of fragments) {
    const conflict = accumulateHopperPlanFragment(accumulator, fragment)
    if (Option.isSome(conflict)) {
      return Result.fail(conflict.value)
    }
  }
  if (accumulator.dimensions.size > MAX_EVENT_DIMENSION_COUNT) {
    return Result.fail({
      _tag: 'WorldCommitPlanDimensionConflict',
      dimensions: [...accumulator.dimensions],
    })
  }
  const dimension = Option.fromUndefinedOr(
    Array.from(accumulator.dimensions)[FIRST_EVENT_DIMENSION_INDEX],
  )
  const optionalBlockEdits = Option.match(dimension, {
    onNone: () => ({}),
    onSome: (value) => ({
      blockEdits: { dimension: value, edits: [...accumulator.editsByPosition.values()] },
    }),
  })
  return Result.succeed({
    ...optionalBlockEdits,
    changes: [...accumulator.changesByOwner.values()],
    expectedDimensions: base.expectedDimensions,
    expectedRevision: base.expectedRevision,
    postCommitEvents: accumulator.postCommitEvents,
    result: NO_RESULT,
    world: base.world,
  })
}

const planHopperEvents = <BuildError>(
  context: Readonly<{
    base: RedstonePlanBase
    events: ReadonlyArray<HopperTransferEvent>
    port: RedstoneHostWritePort<BuildError>
    realm: RedstoneHostRealm
  }>,
) => Effect.gen(function* planHopperEventsGenerator() {
  const { base, events, port, realm } = context
  const selected = yield* selectHopperEvents(realm, events)
  const plan: {
    fragments: Array<WorldCommitPlanFragment<unknown>>
    virtual: VirtualHopperState
  } = {
    fragments: [],
    virtual: { containers: base.containers, hoppers: base.hoppers },
  }
  for (const hopperEvent of selected) {
    const { fragments, virtual } = yield* planSelectedHopperEvent({
      base,
      port,
      realm,
      selected: hopperEvent,
      virtual: plan.virtual,
    })
    plan.virtual = virtual
    plan.fragments.push(...fragments)
  }
  if (plan.fragments.length === ZERO_EVENT_COUNT) {
    return Option.none<WorldCommitPlanFragment<void>>()
  }
  return yield* Effect.fromResult(combineHopperPlanFragments(base, plan.fragments)).pipe(
    Effect.map(Option.some),
  )
})

type RedstoneBlockWrite = NonNullable<WorldCommitRequest['blockWrite']>

const validateExpectedDimensionRevisions = (
  base: RedstonePlanBase,
  expectedDimensions: WorldCommitRequest['expectedDimensions'],
) => Effect.gen(function* validateExpectedDimensionRevisionsGenerator() {
  for (const expectation of expectedDimensions) {
    const common = yield* hopperRevisionContext(base, expectation.dimension)
    if (common.expectedDimensionRevision !== expectation.expectedRevision) {
      return yield* Effect.fail<WorldCommitPlanConflict>({
        _tag: 'WorldCommitPlanDimensionRevisionConflict',
        actual: expectation.expectedRevision,
        dimension: expectation.dimension,
        expected: common.expectedDimensionRevision,
      })
    }
  }
})

const validateRedstoneBlockWriteRevision = (
  base: RedstonePlanBase,
  blockWrite: RedstoneBlockWrite,
) => Effect.gen(function* validateRedstoneBlockWriteRevisionGenerator() {
  const common = yield* hopperRevisionContext(base, blockWrite.dimension)
  if (blockWrite.world !== base.world || blockWrite.expectedWorldRevision !== base.expectedRevision) {
    return yield* Effect.fail<WorldCommitPlanConflict>({
      _tag: 'WorldCommitPlanRevisionConflict',
      actual: blockWrite.expectedWorldRevision,
      expected: base.expectedRevision,
    })
  }
  if (common.expectedDimensionRevision !== blockWrite.expectedDimensionRevision) {
    return yield* Effect.fail<WorldCommitPlanConflict>({
      _tag: 'WorldCommitPlanDimensionRevisionConflict',
      actual: blockWrite.expectedDimensionRevision,
      dimension: blockWrite.dimension,
      expected: common.expectedDimensionRevision,
    })
  }
})

const redstonePlanFromRequest = (
  base: RedstonePlanBase,
  request: WorldCommitRequest,
): Effect.Effect<WorldCommitPlanFragment<void>, WorldCommitPlanConflict> =>
  Effect.gen(function* redstonePlanFromRequestGenerator() {
    if (request.expectedRevision !== base.expectedRevision) {
      return yield* Effect.fail<WorldCommitPlanConflict>({
        _tag: 'WorldCommitPlanRevisionConflict',
        actual: request.expectedRevision,
        expected: base.expectedRevision,
      })
    }
    yield* validateExpectedDimensionRevisions(base, request.expectedDimensions)
    const blockWrite = Option.fromUndefinedOr(request.blockWrite)
    yield* Option.match(blockWrite, {
      onNone: () => Effect.void,
      onSome: (value) => validateRedstoneBlockWriteRevision(base, value),
    })
    const optionalBlockEdits = Option.match(blockWrite, {
      onNone: () => ({}),
      onSome: ({ dimension, edits }) => ({ blockEdits: { dimension, edits } }),
    })
    return {
      ...optionalBlockEdits,
      changes: request.changes,
      expectedDimensions: base.expectedDimensions,
      expectedRevision: base.expectedRevision,
      postCommitEvents: [],
      result: NO_RESULT,
      world: base.world,
    } satisfies WorldCommitPlanFragment<void>
  })

type RedstoneCommitContext<BuildError> = Readonly<{
  events: RedstoneEventBatch
  port: RedstoneHostWritePort<BuildError>
  realms: ReadonlyArray<RedstoneHostRealm>
  observer: Option.Option<RedstoneHostEventObserver>
}>

type RedstonePostCommitPublication = Readonly<{
  events: ReadonlyArray<DomainEvent>
  eventBus: DomainEventBusApi
}>

const planRedstoneEventBatch = <BuildError>(
  context: RedstoneCommitContext<BuildError>,
  base: RedstonePlanBase,
  realm: RedstoneHostRealm,
) => Effect.gen(function* planRedstoneEventBatchGenerator() {
  const plannedPistons = yield* planEventPistons(realm, context.events, context.observer)
  const commitEvents: RedstoneEventBatch = {
    ...context.events,
    hopper: [],
    piston: plannedPistons.flatMap(({ event, plan }) =>
      Option.match(plan, { onNone: () => [], onSome: () => [event] }),
    ),
  }
  const pistonPlans = plannedPistons.flatMap(({ plan }) =>
    Option.match(plan, { onNone: () => [], onSome: (value) => [value] }),
  )
  if (redstoneEventBatchIsEmpty(commitEvents)) {
    return {
      changes: [],
      expectedDimensions: base.expectedDimensions,
      expectedRevision: base.expectedRevision,
      postCommitEvents: [],
      result: NO_RESULT,
      world: base.world,
    } satisfies WorldCommitPlanFragment<void>
  }
  const request = yield* Effect.fromResult(
    context.port.buildCommitRequest(commitEvents, pistonPlans),
  )
  return yield* redstonePlanFromRequest(base, request)
})

const prepareRedstonePostCommitPublication = <BuildError>(
  port: RedstoneHostWritePort<BuildError>,
  plans: ReadonlyArray<WorldCommitPlanFragment<unknown>>,
): Effect.Effect<Option.Option<RedstonePostCommitPublication>, RedstoneHostEventFailure> => {
  const events = plans.flatMap(({ postCommitEvents }) => postCommitEvents)
  if (events.length === ZERO_EVENT_COUNT) {
    return Effect.succeed(Option.none())
  }
  const { eventBus: providedEventBus } = port
  const eventBus = Option.fromUndefinedOr(providedEventBus)
  if (Option.isNone(eventBus)) {
    return Effect.fail({ _tag: 'RedstoneHostEventBusUnavailable' })
  }
  return Effect.succeed(Option.some({ eventBus: eventBus.value, events }))
}

const mergeAndCommitRedstonePlans = <BuildError>(
  port: RedstoneHostWritePort<BuildError>,
  plans: ReadonlyArray<WorldCommitPlanFragment<unknown>>,
): Effect.Effect<
  Option.Option<RedstonePostCommitPublication>,
  WorldCommitPlanConflict | Schema.SchemaError | RedstoneHostEventFailure | WorldCommitCoordinatorError
> => Effect.gen(function* mergeAndCommitRedstonePlansGenerator() {
  const merged = yield* Effect.fromResult(mergeWorldCommitPlans(plans))
  const publication = yield* prepareRedstonePostCommitPublication(port, plans)
  const hasBlockWrite = Option.isSome(Option.fromUndefinedOr(merged.blockWrite))
  if (merged.changes.length > ZERO_EVENT_COUNT || hasBlockWrite) {
    yield* port.coordinator.commit(merged)
  } else if (Option.isSome(publication)) {
    return yield* Effect.fail<WorldCommitPlanConflict>({ _tag: 'WorldCommitPlanEmpty' })
  }
  return publication
})

const commitRedstoneEvents = <BuildError>(
  context: RedstoneCommitContext<BuildError>,
): Effect.Effect<
  Option.Option<RedstonePostCommitPublication>,
  BlockRegistryResolutionFailure | RedstoneHostEventFailure | RedstoneHostPositionFailure | RedstoneHostHopperFailure | BuildError | Schema.SchemaError | WorldCommitPlanConflict | WorldCommitCoordinatorError | HopperServiceError
> =>
  Effect.gen(function* commitRedstoneEventsGenerator() {
    const realm = yield* realmForRedstoneEvents(context.realms, context.events)
    if (Option.isNone(realm)) {
      return Option.none()
    }
    const base = yield* captureRedstonePlanBase(context.port, realm.value.dimension)
    const redstonePlan = yield* planRedstoneEventBatch(context, base, realm.value)
    const hopperPlan = yield* planHopperEvents({
      base,
      events: context.events.hopper,
      port: context.port,
      realm: realm.value,
    })
    const plans = Option.match(hopperPlan, {
      onNone: () => [redstonePlan] as const,
      onSome: (fragment) => [redstonePlan, fragment] as const,
    })
    return yield* mergeAndCommitRedstonePlans(context.port, plans)
  })

const applyRedstoneHostEventsInternal = <BuildError>(input: RedstoneHostEventApplyInput<BuildError>) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* applyRedstoneHostEventsGenerator() {
      const { observer, port, realms, runtime } = input
      const events = yield* drainRedstoneEvents(runtime)
      const result = yield* Effect.exit(restore(commitRedstoneEvents({ events, observer, port, realms })))
      if (Exit.isFailure(result)) {
        yield* runtime.restoreEvents(events)
        return yield* Effect.failCause(result.cause)
      }
      const publication = result.value
      if (Option.isSome(publication)) {
        for (const event of publication.value.events) {
          yield* publication.value.eventBus.publish(event)
        }
      }
    }),
  )

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
> => applyRedstoneHostEventsInternal({ observer: NO_HOST_EVENT_OBSERVER, port, realms, runtime })

export const applyRedstoneHostEventsObserved = <BuildError>(
  input: Readonly<{
    readonly runtime: RedstoneWorldRuntimeService
    readonly realms: ReadonlyArray<RedstoneHostRealm>
    readonly port: RedstoneHostWritePort<BuildError>
    readonly observer: RedstoneHostEventObserver
  }>,
): Effect.Effect<
  void,
  BlockRegistryResolutionFailure | RedstoneHostEventFailure | RedstoneHostPositionFailure | RedstoneHostHopperFailure | BuildError | Schema.SchemaError | WorldCommitCoordinatorError | HopperServiceError
> => applyRedstoneHostEventsInternal({ ...input, observer: Option.some(input.observer) })
