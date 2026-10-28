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
  type BlockPosition,
  type BlockRegistryResolutionFailure,
  type BlockType,
  blockIdOf,
  capabilityOfBlockId,
  isBlockType,
} from '@nerima-games/mc-kernel'
import {
  type BlockCapabilityLookup,
  type PistonCellRead,
  type PistonFacing,
  type PistonMovementPlan,
  type PistonPosition,
  pistonPositionAt,
  planPistonTransition,
} from '../domain/piston.js'
import { Effect, Exit, Option, Result, Schema } from 'effect'
import {
  type PoweredPistonTransition,
  type RedstoneComponentSnapshot,
  type RedstoneEventBatch,
  type RedstoneWorldRuntimeService,
  type RedstoneWorldSnapshot,
} from './world-runtime.js'
import type { WorldCommitCoordinatorApi, WorldCommitCoordinatorError, WorldCommitRequest } from '@nerima-games/mc-sim'
import type { ContainerSlot } from '../domain/comparator.js'

const blockAxis = BlockAxis
const schemaLiterals = Schema.Literals
const NO_COMPONENT = Option.getOrUndefined(Option.none<RedstoneComponentSnapshot>())

type RedstoneDimensionId = BlockAddress['dimension']

/** How far in front of a piston's base its head cell sits. */
const PISTON_HEAD_DISTANCE = 1
const FIRST_EVENT_DIMENSION_INDEX = 0
const MAX_EVENT_DIMENSION_COUNT = 1
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
  readonly readPistonCell: (position: BlockPosition) => PistonCellRead
  readonly readPistonFacing: (position: BlockPosition) => PistonFacing
}

/**
 * The host supplies world context and builds the one request; this module
 * stages semantic outcomes but does not choose block ids or write world state.
 */
export type RedstoneHostWritePort<BuildError = never> = {
  readonly buildCommitRequest: (
    events: RedstoneEventBatch,
    pistonPlans: ReadonlyArray<PistonMovementPlan>,
  ) => Result.Result<WorldCommitRequest, BuildError>
  readonly commit: WorldCommitCoordinatorApi['commit']
}

/** One dimension's worth of host reads, addressed by a decoded kernel id. */
export type RedstoneHostRealm = {
  readonly dimension: RedstoneDimensionId
  readonly lookup: RedstoneHostLookup
}

export type RedstoneHostEventFailure =
  | Readonly<{ _tag: 'RedstoneHostMixedDimensions'; dimensions: ReadonlyArray<RedstoneDimensionId> }>
  | Readonly<{ _tag: 'RedstoneHostRealmMissing'; dimension: RedstoneDimensionId }>

export type RedstoneHostPositionFailure = Readonly<{
  _tag: 'RedstoneHostPositionOutOfRange'
  position: PistonPosition
}>

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
    return Result.fail({ _tag: 'RedstoneHostPositionOutOfRange', position: { x, y, z } })
  }
  return Result.succeed({ x: blockAxis(x), y: blockAxis(y), z: blockAxis(z) })
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
  const headPosition = pistonPositionAt(position, facing, PISTON_HEAD_DISTANCE)
  return Result.map(
    blockPositionAt(headPosition.x, headPosition.y, headPosition.z),
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

const planPistonTransitionEvent = (
  realm: RedstoneHostRealm,
  event: PoweredPistonTransition,
): Effect.Effect<
  Option.Option<PistonMovementPlan>,
  BlockRegistryResolutionFailure | RedstoneHostPositionFailure
> => {
  let positionFailure: Option.Option<RedstoneHostPositionFailure> = Option.none()
  const outcome = planPistonTransition(event, {
    read: (position) => {
      const safePosition = blockPositionAt(position.x, position.y, position.z)
      if (Result.isFailure(safePosition)) {
        positionFailure = Option.some(safePosition.failure)
        return { kind: 'out-of-world' }
      }
      return realm.lookup.readPistonCell(safePosition.success)
    },
  }, kernelPistonCapabilities)
  if (Option.isSome(positionFailure)) {
    return Effect.fail(positionFailure.value)
  }
  if (outcome.kind === 'failed') {
    return Effect.fail(outcome.failure)
  }
  if (outcome.kind !== 'move') {
    return Effect.succeed(Option.none())
  }
  return Effect.succeed(Option.some(outcome.plan))
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
    const dimension = dimensions.at(FIRST_EVENT_DIMENSION_INDEX)
    if (!dimension) {
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
    yield* port.commit(built.success)
  })

const commitRedstoneEvents = <BuildError>(
  realms: ReadonlyArray<RedstoneHostRealm>,
  events: RedstoneEventBatch,
  port: RedstoneHostWritePort<BuildError>,
): Effect.Effect<
  void,
  BlockRegistryResolutionFailure | RedstoneHostEventFailure | RedstoneHostPositionFailure | BuildError | WorldCommitCoordinatorError
> =>
  Effect.gen(function* commitRedstoneEventsGenerator() {
    const realm = yield* realmForRedstoneEvents(realms, events)
    if (Option.isNone(realm)) {
      return
    }
    const plannedPistons = yield* planEventPistons(realm.value, events)
    const pistonPlans = plannedPistons.flatMap(({ plan }) =>
      Option.match(plan, { onNone: () => [], onSome: (value) => [value] }),
    )
    const commitEvents: RedstoneEventBatch = {
      ...events,
      piston: plannedPistons.flatMap(({ event, plan }) =>
        Option.match(plan, { onNone: () => [], onSome: () => [event] }),
      ),
    }
    if (redstoneEventBatchIsEmpty(commitEvents)) {
      return
    }
    yield* buildAndCommitRedstoneEvents(port, commitEvents, pistonPlans)
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
  BlockRegistryResolutionFailure | RedstoneHostEventFailure | RedstoneHostPositionFailure | BuildError | WorldCommitCoordinatorError
> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* applyRedstoneHostEventsGenerator() {
      const events = yield* drainRedstoneEvents(runtime)
      const result = yield* Effect.exit(restore(commitRedstoneEvents(realms, events, port)))
      if (Exit.isFailure(result)) {
        yield* runtime.restoreEvents(events)
        return yield* Effect.failCause(result.cause)
      }
    }),
  )
