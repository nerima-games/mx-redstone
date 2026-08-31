/**
 * The host boundary this repository's own stages never cross.
 *
 * §5.3 (W1-L4') of the org runbook moves this file's responsibility out of
 * mc-compose — it used to be `apps/multiplayer-server/redstone-runtime.ts`,
 * hand-rolled per host — and into its real home. Classifying a block string
 * into a `RedstoneComponentSnapshot` is this repository's own component
 * roster (docs/responsibility.md §2-1: 「レッドストーン部品はどれか」という名簿は
 * ここに来る), not a host's; a host reimplementing that switch every time it
 * embeds mx-redstone was duplication this repository could remove.
 *
 * `RedstoneHostLookup` and `RedstoneHostWritePort` are exactly what the
 * mc-compose source's `MultiplayerServerCore` already provided — only the
 * shape moved to a named, host-agnostic Port, not the responsibility. This
 * repository still knows nothing of mx-multiplayer, mc-sim's entity/inventory
 * state, or any concrete world representation (docs/responsibility.md §2):
 * every write stays a callback the host supplies, and `readContainerSlots`
 * returning `undefined` here means exactly what it meant there — the
 * boundary recorded in `domain/comparator.ts`'s `ContainerSlot` doc comment,
 * not an error.
 *
 * Block-name vocabulary stays out of this file on purpose (same doc,
 * non-scope row 1): `applyLampTransition` / `applyDoorTransition` take a
 * boolean, never a block id, so the HOST — not this repository — decides
 * which literal block string a lit lamp or an open door actually is.
 *
 * Two gaps are carried over unchanged from the mc-compose source rather than
 * fixed here, because fixing either needs Port surface this repository does
 * not have yet and no host to verify a fix against:
 *   - `componentForBlock`'s `piston` case always reports `pistonFacing:
 *     'north'` and `pistonKind: 'sticky'`, regardless of the piston's actual
 *     placement — the source never tracked either.
 *   - `applyRedstoneHostEvents` drains but does not act on `'note-block'`
 *     trigger events or `'trapdoor'` powered-component transitions; no host
 *     operation for either existed in the source either.
 *
 * `applyPistonTransitionEvent` commits `planPistonTransition`'s `'move'`
 * outcome directly, exactly as the mc-compose source did. An earlier version
 * of this file routed the commit through `domain/piston.ts`'s
 * `applyPistonPlan` (validate-then-commit) instead, on the theory that
 * defense-in-depth costs nothing. `pnpm test:coverage`'s 100% gate proved
 * that theory wrong: `validatePistonPlan` checks exactly the invariants
 * `planPistonTransition` already establishes by construction (fromState !==
 * toState, move directions matching `plan.facing`, no duplicate claims), so
 * the refusal branch was unreachable through this call path — DN-RS-11's
 * discipline (docs/testing.md §6-1) is what caught it.
 */
import {
  type BlockCapabilityLookup,
  type PistonCellRead,
  type PistonMovementPlan,
  pistonPositionAt,
  planPistonTransition,
} from '../domain/piston.js'
import type {
  HopperTransferEvent,
  LampTransition,
  PoweredComponentTransition,
  PoweredPistonTransition,
  RedstoneComponentSnapshot,
  RedstonePosition,
  RedstoneTriggerEvent,
  RedstoneWorldRuntimeService,
  RedstoneWorldSnapshot,
} from './world-runtime.js'
import { blockIdOf, capabilityOfBlockId, isBlockType } from '@nerima-games/mc-kernel'
import type { ContainerSlot } from '../domain/comparator.js'
import { Effect } from 'effect'

/** How far in front of a piston's base its head cell sits. */
const PISTON_HEAD_DISTANCE = 1

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
  pistonImmovable: (block) =>
    isBlockType(block) && capabilityOfBlockId(blockIdOf(block), PISTON_IMMOVABLE_CAPABILITY),
}

/** One block a host is offering for classification, at the position it occupies. */
export type RedstoneHostBlock = {
  readonly block: string | null
  readonly position: RedstonePosition
}

/**
 * Peripheral reads `componentForBlock` needs beyond the bare block string —
 * everything a `RedstoneComponentSnapshot` field can encode that this
 * repository cannot derive from the string alone.
 */
export type RedstoneHostLookup = {
  readonly isLeverActive: (position: RedstonePosition) => boolean
  readonly isPoweredRailPowered: (position: RedstonePosition) => boolean
  readonly readContainerSlots: (position: RedstonePosition) => ReadonlyArray<ContainerSlot> | undefined
  readonly readPistonCell: (position: RedstonePosition) => PistonCellRead
}

/**
 * The writes this repository decides but does not itself perform
 * (docs/responsibility.md §1: レッドストーンは状態を持たない). Each method takes
 * the semantic outcome, never a block id — see the file header.
 */
export type RedstoneHostWritePort = {
  readonly applyDispenserTrigger: (position: RedstonePosition) => void
  readonly applyDoorTransition: (position: RedstonePosition, open: boolean) => void
  readonly applyDropperTrigger: (position: RedstonePosition) => void
  readonly applyHopperTransfer: (position: RedstonePosition) => void
  readonly applyLampTransition: (position: RedstonePosition, lit: boolean) => void
  readonly applyPoweredRailTransition: (position: RedstonePosition, powered: boolean) => void
  readonly commitPistonPlan: (plan: PistonMovementPlan) => void
}

/** One dimension's worth of host boundary: how to read it, and how to write to it. */
export type RedstoneHostRealm = {
  readonly dimension: string
  readonly lookup: RedstoneHostLookup
  readonly port: RedstoneHostWritePort
}

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

const comparatorComponent = (
  lookup: RedstoneHostLookup,
  position: RedstonePosition,
): RedstoneComponentSnapshot => {
  const inputFrom = { x: position.x, y: position.y, z: position.z + COMPARATOR_REAR_DISTANCE }
  const outputTo = { x: position.x, y: position.y, z: position.z - COMPARATOR_REAR_DISTANCE }
  const sideInputs = [
    { x: position.x - COMPARATOR_SIDE_DISTANCE, y: position.y, z: position.z },
    { x: position.x + COMPARATOR_SIDE_DISTANCE, y: position.y, z: position.z },
  ]
  return {
    inputFrom,
    kind: 'comparator',
    mode: 'compare',
    outputTo,
    position,
    sideInputs,
    ...withContainerSlots(lookup.readContainerSlots(inputFrom)),
  }
}

const pistonComponent = (
  lookup: RedstoneHostLookup,
  position: RedstonePosition,
): RedstoneComponentSnapshot => {
  const head = lookup.readPistonCell(pistonPositionAt(position, 'north', PISTON_HEAD_DISTANCE))
  return {
    kind: 'piston',
    pistonFacing: 'north',
    pistonKind: 'sticky',
    pistonState: pistonStateFromHead(head),
    position,
  }
}

type ComponentBuilder = (lookup: RedstoneHostLookup, position: RedstonePosition) => RedstoneComponentSnapshot

/** A builder for the block kinds whose component needs no host lookup at all. */
const fixedKindComponent = (kind: RedstoneComponentSnapshot['kind']): ComponentBuilder => (_lookup, position) => ({
  kind,
  position,
})

const poweredRailComponent: ComponentBuilder = (lookup, position) => ({
  kind: 'powered-rail',
  position,
  powered: lookup.isPoweredRailPowered(position),
})

const leverComponent: ComponentBuilder = (lookup, position) => ({
  active: lookup.isLeverActive(position),
  kind: 'lever',
  position,
})

/**
 * This repository's own component roster (docs/responsibility.md §2-1),
 * keyed by the block string that names each part. `redstone_lamp` /
 * `redstone_lamp_lit` share one builder, as do `door` / `door_open` — the
 * block-name vocabulary tells this repository which STATE a lamp or door is
 * currently in, not that it should be classified any differently.
 */
const COMPONENT_BUILDERS: Readonly<Record<string, ComponentBuilder>> = {
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
}

/**
 * Classifies one host block into this repository's component roster, or
 * `undefined` when the block plays no redstone role. Ported from the
 * mc-compose source's `componentForBlock` — see the file header for the two
 * gaps carried over unchanged.
 */
export const componentForBlock = (
  lookup: RedstoneHostLookup,
  block: string | null,
  position: RedstonePosition,
): RedstoneComponentSnapshot | undefined => {
  if (block === null) {
    return
  }
  const builder = COMPONENT_BUILDERS[block]
  if (typeof builder === 'undefined') {
    return
  }
  return builder(lookup, position)
}

/**
 * Builds one dimension's `RedstoneWorldSnapshot` from a host's raw block
 * list — the replacement for the mc-compose source's per-tick
 * `realm.core.snapshot().blocks.flatMap(componentForBlock)`.
 */
export const redstoneSnapshotFromRealm = (
  realm: RedstoneHostRealm,
  blocks: ReadonlyArray<RedstoneHostBlock>,
): RedstoneWorldSnapshot => ({
  components: blocks.flatMap(({ block, position }) => {
    const component = componentForBlock(realm.lookup, block, position)
    if (typeof component === 'undefined') {
      return []
    }
    return [component]
  }),
  dimension: realm.dimension,
})

const applyHopperTransferEvent = (
  realms: ReadonlyMap<string, RedstoneHostRealm>,
  event: HopperTransferEvent,
): void => {
  realms.get(event.dimension)?.port.applyHopperTransfer(event.position)
}

/** `dispenser` and `dropper` are handled; `note-block` is drained and dropped — see the file header. */
const applyTriggerEvent = (
  realms: ReadonlyMap<string, RedstoneHostRealm>,
  event: RedstoneTriggerEvent,
): void => {
  const realm = realms.get(event.dimension)
  if (typeof realm === 'undefined') {
    return
  }
  if (event.kind === 'dispenser') {
    realm.port.applyDispenserTrigger(event.position)
    return
  }
  if (event.kind === 'dropper') {
    realm.port.applyDropperTrigger(event.position)
  }
}

const applyLampTransitionEvent = (
  realms: ReadonlyMap<string, RedstoneHostRealm>,
  event: LampTransition,
): void => {
  realms.get(event.dimension)?.port.applyLampTransition(event.position, event.lit)
}

/** `door` and `powered-rail` are handled; `trapdoor` is drained and dropped — see the file header. */
const applyPoweredComponentTransitionEvent = (
  realms: ReadonlyMap<string, RedstoneHostRealm>,
  event: PoweredComponentTransition,
): void => {
  const realm = realms.get(event.dimension)
  if (typeof realm === 'undefined') {
    return
  }
  if (event.kind === 'door') {
    realm.port.applyDoorTransition(event.position, event.powered)
    return
  }
  if (event.kind === 'powered-rail') {
    realm.port.applyPoweredRailTransition(event.position, event.powered)
  }
}

const applyPistonTransitionEvent = (
  realms: ReadonlyMap<string, RedstoneHostRealm>,
  event: PoweredPistonTransition,
): Effect.Effect<void> => {
  const realm = realms.get(event.dimension)
  if (typeof realm === 'undefined') {
    return Effect.void
  }
  const outcome = planPistonTransition(event, { read: realm.lookup.readPistonCell }, kernelPistonCapabilities)
  if (outcome.kind !== 'move') {
    return Effect.void
  }
  return Effect.sync(() => realm.port.commitPistonPlan(outcome.plan))
}

type DrainedRedstoneEvents = {
  readonly hopper: ReadonlyArray<HopperTransferEvent>
  readonly lamp: ReadonlyArray<LampTransition>
  readonly piston: ReadonlyArray<PoweredPistonTransition>
  readonly powered: ReadonlyArray<PoweredComponentTransition>
  readonly trigger: ReadonlyArray<RedstoneTriggerEvent>
}

/** One `Effect.all` for all five queues, so `applyRedstoneHostEvents` reads as drain-then-apply. */
const drainRedstoneEvents = (runtime: RedstoneWorldRuntimeService): Effect.Effect<DrainedRedstoneEvents> =>
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

/** The four event kinds a realm's `port` applies synchronously — every kind but the piston plan. */
const applySynchronousEvents = (
  byDimension: ReadonlyMap<string, RedstoneHostRealm>,
  events: DrainedRedstoneEvents,
): void => {
  for (const event of events.hopper) {
    applyHopperTransferEvent(byDimension, event)
  }
  for (const event of events.trigger) {
    applyTriggerEvent(byDimension, event)
  }
  for (const event of events.lamp) {
    applyLampTransitionEvent(byDimension, event)
  }
  for (const event of events.powered) {
    applyPoweredComponentTransitionEvent(byDimension, event)
  }
}

/**
 * Drains every queue `RedstoneWorldRuntimeService` accumulated and applies
 * each event through the realm it named — the replacement for the
 * mc-compose source's per-tick drain-then-switch block. Call this after
 * running this repository's registered stages for the frame (`redstone:power`
 * then `redstone:effects`); `runtime.syncSnapshot` still runs first, via
 * `redstoneSnapshotFromRealm`.
 */
export const applyRedstoneHostEvents = (
  runtime: RedstoneWorldRuntimeService,
  realms: ReadonlyArray<RedstoneHostRealm>,
): Effect.Effect<void> =>
  Effect.gen(function* applyRedstoneHostEventsGenerator() {
    const byDimension = new Map(realms.map((realm) => [realm.dimension, realm] as const))
    const events = yield* drainRedstoneEvents(runtime)
    applySynchronousEvents(byDimension, events)
    yield* Effect.forEach(events.piston, (event) => applyPistonTransitionEvent(byDimension, event), {
      discard: true,
    })
  })
