/**
 * The dispenser: fires on the EDGE, not on the level.
 *
 * A lamp lit by a lever stays lit; a dispenser fed by the same lever fires once
 * and then waits for the lever to go off and on again. That distinction is the
 * redstone behavior this repository owns, and it is worth its own file because
 * getting it wrong is not a subtle failure: a dispenser wired to a lever that a
 * player leaves ON empties a double chest in three seconds.
 *
 * The reference implements it with a rising-edge check against remembered state
 * (`redstone-dispenser-world-effects.ts:59-63`), and remembers it in a
 * module-level `Map` (`:36`) with a `resetDispenserState()` beside it. Same
 * defect, same fix, and the same reasoning as `domain/observer.ts`: the memory
 * is a value in and a value out, so two worlds cannot share one.
 *
 * ---------------------------------------------------------------------------
 * BOUNDARY: it plans the caller-selected item action
 * ---------------------------------------------------------------------------
 *
 * `dispenserEdges` decides WHETHER a dispenser fires. WHAT comes out requires
 * three separate consequences. `planDispenserAction` validates the
 * caller-selected slot in a mc-sim 0.6 dispenser snapshot and returns a
 * one-item action intent, but it does not consume the item or mutate the world:
 *
 *   - the item. Drawing one needs a container at a position. mc-sim 0.6
 *     publishes position-addressed container snapshots and item transfers, but
 *     this package has not connected those APIs to a dispenser host operation;
 *     see the contract note on `ContainerSlot` in `domain/comparator.ts`.
 *     `planDispenserAction` validates the nine-slot container and the selected
 *     occupied slot; B composes the one-item extraction with the action through
 *     the world commit boundary. A rejected action must leave the inventory
 *     unchanged.
 *   - the DROP. `EntityManagerApi.spawn` exists
 *     (`mc-sim/application/entity-manager.ts:100`) and cannot be called from
 *     here: it takes `SpawnRequest<S>` (`mc-sim/domain/entity.ts:347-352`) whose
 *     `behaviour: S` is, in mc-sim's own words, "whatever the rules tier stores
 *     per entity — for a creeper this is mx-gameplay's `CreeperFuse`". Naming
 *     `S` means importing a sibling experience module, and the edge count
 *     between experience modules is zero (plan.md §2.3-1). A dispenser that
 *     spawns a drop is therefore mx-gameplay's rule reacting to redstone's
 *     event, not redstone's rule reaching into mx-gameplay. The `EjectItem`
 *     intent keeps that boundary while describing which item B composes.
 *   - the PROJECTILE. The reference fires arrows by hitscanning over
 *     `entityManager.getEntities()` and calling `applyDamage`
 *     (`redstone-dispenser-world-effects.ts:90-115`). Damage numbers are
 *     explicitly not mc-sim's either — `mc-sim/domain/entity.ts` says
 *     「剣が何ダメージか」「落下で何ダメージか」 is mx-gameplay's — so an arrow's five
 *     points would be a redstone repository inventing a combat constant. The
 *     `SpawnArrow` intent names the item action without spawning an entity or
 *     choosing projectile physics here.
 *
 * What crosses the boundary is the list below: positions that fired, this tick,
 * plus an action intent for a caller-selected slot with its item type and
 * count. That is an EVENT, it names nothing outside this repository, and it is
 * the smallest thing that lets the rule live here and the consequence live
 * there. The action is a typed description; neither performs the inventory,
 * entity, or block mutation that B must compose atomically.
 */
import { Brand, Result, Schema } from 'effect'
import {
  CONTAINER_STORAGE_SNAPSHOT_VERSION,
  type Container,
  ContainerStorageSnapshotSchema,
  DISPENSER_CONTAINER_CAPACITY,
} from '@nerima-games/mc-sim'
import { type ItemType, isItemType } from '@nerima-games/mc-kernel'
import type { PositionKey } from './position-key.js'

const schemaLiteral = Schema.Literal
const schemaStruct = Schema.Struct
const schemaUnion = Schema.Union
const DISPENSER_ACTION_ITEM_COUNT = 1

/** The selected slot index in a nine-slot dispenser. */
export const DispenserSlotIndexSchema: Schema.Codec<DispenserSlotIndex, number> = Schema.Int.check(
  Schema.isBetween({
    maximum: DISPENSER_CONTAINER_CAPACITY - DISPENSER_ACTION_ITEM_COUNT,
    minimum: 0,
  }),
).pipe(Schema.brand('DispenserSlotIndex'))

export type DispenserSlotIndex = number & Brand.Brand<'DispenserSlotIndex'>

const GenericDispenserItemSchema: Schema.Codec<Exclude<ItemType, 'arrow' | 'tnt'>, unknown> = Schema.declare(
  (value: unknown): value is Exclude<ItemType, 'arrow' | 'tnt'> =>
    isItemType(value) && value !== 'arrow' && value !== 'tnt',
)

export const DispenserActionPlanSchema: Schema.Codec<DispenserActionPlan, unknown> = schemaUnion([
  schemaStruct({
    _tag: schemaLiteral('SpawnArrow'),
    count: schemaLiteral(DISPENSER_ACTION_ITEM_COUNT),
    item: schemaLiteral('arrow'),
    slot: DispenserSlotIndexSchema,
  }),
  schemaStruct({
    _tag: schemaLiteral('PrimeTnt'),
    count: schemaLiteral(DISPENSER_ACTION_ITEM_COUNT),
    item: schemaLiteral('tnt'),
    slot: DispenserSlotIndexSchema,
  }),
  schemaStruct({
    _tag: schemaLiteral('EjectItem'),
    count: schemaLiteral(DISPENSER_ACTION_ITEM_COUNT),
    item: GenericDispenserItemSchema,
    slot: DispenserSlotIndexSchema,
  }),
])

export type DispenserActionPlan =
  | {
      readonly _tag: 'SpawnArrow'
      readonly slot: DispenserSlotIndex
      readonly item: 'arrow'
      readonly count: typeof DISPENSER_ACTION_ITEM_COUNT
    }
  | {
      readonly _tag: 'PrimeTnt'
      readonly slot: DispenserSlotIndex
      readonly item: 'tnt'
      readonly count: typeof DISPENSER_ACTION_ITEM_COUNT
    }
  | {
      readonly _tag: 'EjectItem'
      readonly slot: DispenserSlotIndex
      readonly item: Exclude<ItemType, 'arrow' | 'tnt'>
      readonly count: typeof DISPENSER_ACTION_ITEM_COUNT
    }

export const DispenserPlanFailureSchema: Schema.Codec<DispenserPlanFailure, unknown> = schemaUnion([
  schemaStruct({ _tag: schemaLiteral('InvalidContainer') }),
  schemaStruct({ _tag: schemaLiteral('NotDispenser') }),
  schemaStruct({ _tag: schemaLiteral('InvalidSlot') }),
  schemaStruct({
    _tag: schemaLiteral('EmptySlot'),
    slot: DispenserSlotIndexSchema,
  }),
])

export type DispenserPlanFailure =
  | { readonly _tag: 'InvalidContainer' }
  | { readonly _tag: 'NotDispenser' }
  | { readonly _tag: 'InvalidSlot' }
  | { readonly _tag: 'EmptySlot'; readonly slot: DispenserSlotIndex }

const decodeDispenserSlot = (input: unknown): Result.Result<DispenserSlotIndex, DispenserPlanFailure> => {
  const selectedSlotResult = Schema.decodeUnknownResult(DispenserSlotIndexSchema)(input)
  if (Result.isFailure(selectedSlotResult)) {
    return Result.fail({ _tag: 'InvalidSlot' })
  }

  return Result.succeed(selectedSlotResult.success)
}

const decodeDispenserContainer = (input: unknown): Result.Result<Container, DispenserPlanFailure> => {
  const snapshotResult = Schema.decodeUnknownResult(ContainerStorageSnapshotSchema, {
    onExcessProperty: 'error',
  })({
    containers: [input],
    version: CONTAINER_STORAGE_SNAPSHOT_VERSION,
  })
  if (Result.isFailure(snapshotResult)) {
    return Result.fail({ _tag: 'InvalidContainer' })
  }

  const [container] = snapshotResult.success.containers
  if (container?.kind !== 'dispenser') {
    return Result.fail({ _tag: 'NotDispenser' })
  }

  return Result.succeed(container)
}

const planDispenserSlot = (
  container: Container,
  slot: DispenserSlotIndex,
): Result.Result<DispenserActionPlan, DispenserPlanFailure> => {
  const stack = container.slots[slot]
  if (!stack) {
    return Result.fail({ _tag: 'EmptySlot', slot })
  }

  if (stack.item === 'arrow') {
    return Result.succeed({
      _tag: 'SpawnArrow',
      count: DISPENSER_ACTION_ITEM_COUNT,
      item: 'arrow',
      slot,
    })
  }
  if (stack.item === 'tnt') {
    return Result.succeed({
      _tag: 'PrimeTnt',
      count: DISPENSER_ACTION_ITEM_COUNT,
      item: 'tnt',
      slot,
    })
  }

  return Result.succeed({
    _tag: 'EjectItem',
    count: DISPENSER_ACTION_ITEM_COUNT,
    item: stack.item,
    slot,
  })
}

/** Plans the action for the caller-selected slot without mutating inventory or world state. */
export const planDispenserAction = (
  containerInput: unknown,
  selectedSlotInput: unknown,
): Result.Result<DispenserActionPlan, DispenserPlanFailure> => {
  const selectedSlotResult = decodeDispenserSlot(selectedSlotInput)
  if (Result.isFailure(selectedSlotResult)) {
    return Result.fail(selectedSlotResult.failure)
  }

  const containerResult = decodeDispenserContainer(containerInput)
  if (Result.isFailure(containerResult)) {
    return Result.fail(containerResult.failure)
  }

  return planDispenserSlot(containerResult.success, selectedSlotResult.success)
}
export type PowerEdgeMemory = ReadonlyMap<PositionKey, boolean>

export type DispenserSweep = {
  /** Dispensers that fire this tick, in key order. */
  readonly fired: ReadonlyArray<PositionKey>
  /** What to pass as `previous` next tick. Entries for departed dispensers are gone. */
  readonly powered: PowerEdgeMemory
}

/**
 * Which dispensers fire, given who is powered now and who was powered before.
 *
 * An ABSENT previous entry counts as unpowered, which means a dispenser placed
 * into a circuit that is already live fires immediately. That is deliberate and
 * it is the opposite of the observer's first-sighting rule
 * (`domain/observer.ts`), so it is worth being explicit about why the two differ:
 *
 *   - an observer watches a block, and a block that was already there did not
 *     change. Arming without firing is the only reading of "no change".
 *   - a dispenser watches ITSELF, and a dispenser that has just been placed was
 *     unpowered a moment ago because it did not exist. The edge is real, vanilla
 *     fires it, and a player placing a dispenser into a powered circuit expects
 *     it to go off.
 *
 * The asymmetry is not an accident of implementation; both are what the player
 * sees. `test/dispenser.test.ts` pins both halves so that "making them
 * consistent" is a failing test rather than a tidy-up.
 */
export const dispenserEdges = (
  current: ReadonlyMap<PositionKey, boolean>,
  previous: PowerEdgeMemory,
): DispenserSweep => {
  const fired: Array<PositionKey> = []
  const powered = new Map<PositionKey, boolean>()

  for (const [key, isPowered] of current) {
    powered.set(key, isPowered)
    if (isPowered && previous.get(key) !== true) {
      fired.push(key)
    }
  }

  return { fired: fired.sort(), powered }
}
