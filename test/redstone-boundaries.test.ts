import { describe, expect, it } from '@effect/vitest'
import { Effect, Option, Result, Schema } from 'effect'
import {
  BlockAddressSchema,
  BlockPositionSchema,
  blockIdOf,
  DomainEventSchema,
  DimensionIdSchema,
  DimensionRevisionSchema,
  encodeBlockState,
  SimulationTickSchema,
  WorldIdSchema,
  WorldRevisionSchema,
} from '@nerima-games/mc-kernel'
import {
  CONTAINER_STORAGE_SNAPSHOT_VERSION,
  HOPPER_REPLICATED_OWNER_ID,
  type DomainEvent,
} from '@nerima-games/mc-sim'
import {
  applyRedstoneHostEvents,
  componentForBlock,
  type RedstoneHostLookup,
  type RedstoneHostRealm,
  type RedstoneHostWritePort,
} from '../src/application/redstone-host-port'
import {
  RedstoneEventBatchSchema,
  RedstoneWorldRuntime,
  RedstoneWorldRuntimeLayer,
  RedstoneWorldSnapshotSchema,
  type RedstoneWorldSnapshot,
} from '../src/application/world-runtime'
import { HEAVY_PLATE_CAPACITY, LIGHT_PLATE_CAPACITY, plateSignal } from '../src/domain/pressure-plate'
import { PISTON_PUSH_LIMIT, planPush, type BlockCapabilityLookup } from '../src/domain/piston'
import { MAX_POWER_LEVEL } from '../src/domain/signal-level'
import { targetSignal } from '../src/domain/target-block'

type DimensionId = Schema.Schema.Type<typeof DimensionIdSchema>

const dimensionId = (value: string): DimensionId =>
  Schema.decodeUnknownSync(DimensionIdSchema)(value)

const blockPosition = (x: number, y = 0, z = 0) =>
  Schema.decodeUnknownSync(BlockPositionSchema)({ x, y, z })

const powerSnapshot = (emits: number): RedstoneWorldSnapshot => ({
  components: [{ active: true, emits, kind: 'lever', position: blockPosition(0) }],
  dimension: dimensionId('overworld'),
})

const sensorFixtures = {
  binary: { kind: 'binary' as const },
  light: { capacity: LIGHT_PLATE_CAPACITY, kind: 'weighted' as const },
  heavy: { capacity: HEAVY_PLATE_CAPACITY, kind: 'weighted' as const },
}

const NOTHING_IS_IMMOVABLE: BlockCapabilityLookup = {
  pistonImmovable: () => Result.succeed(false),
}

const testWorldId = Schema.decodeUnknownSync(WorldIdSchema)('redstone-boundaries-test')
const worldRevision = Schema.decodeUnknownSync(WorldRevisionSchema)(0)
const dimensionRevision = Schema.decodeUnknownSync(DimensionRevisionSchema)(0)
const hopperBlockId = Option.getOrThrow(blockIdOf('hopper'))
const postCommitEvent: DomainEvent = Schema.decodeUnknownSync(DomainEventSchema)({
  _tag: 'BlockChangedByWorld',
  address: Schema.decodeUnknownSync(BlockAddressSchema)({
    dimension: 'overworld',
    position: { x: 20, y: 0, z: 0 },
  }),
  cause: 'fire',
  tick: Schema.decodeUnknownSync(SimulationTickSchema)(1),
})

const hopperLookup: RedstoneHostLookup = {
  isLeverActive: () => false,
  isPoweredRailPowered: () => false,
  readContainerSlots: () => undefined,
  readHopperBlockId: () => hopperBlockId,
  readHopperTransferContext: () => ({ powered: false, sourceAbove: null, destinationFacing: null }),
  readPistonCell: () => ({ kind: 'empty' }),
}

const hopperRealm = (dimension: DimensionId): RedstoneHostRealm => ({ dimension, lookup: hopperLookup })

const hostWritePortWithoutEventBus: RedstoneHostWritePort = {
  buildCommitRequest: () => {
    throw new Error('The event-only fixture must not build a redstone request')
  },
  buildHopperBlockWrite: () => {
    throw new Error('The event-only fixture must not write a hopper block')
  },
  coordinator: {
    worldId: testWorldId,
    revision: Effect.succeed(worldRevision),
    dimensionRevision: () => Effect.succeed(dimensionRevision),
    snapshot: (ownerId, schema) => {
      const state = ownerId === HOPPER_REPLICATED_OWNER_ID
        ? { hoppers: [] }
        : { version: CONTAINER_STORAGE_SNAPSHOT_VERSION, containers: [] }
      return Schema.decodeUnknownEffect(schema)(state).pipe(
        Effect.map((decodedState) => ({ world: testWorldId, revision: worldRevision, state: decodedState })),
      )
    },
    commit: () => Effect.die(new Error('The missing-event-bus path must fail before commit')),
  },
  hopperService: {
    planAdvanceCooldown: (snapshot) => Effect.succeed({
      changes: [{ ownerId: HOPPER_REPLICATED_OWNER_ID, state: snapshot.state }],
      expectedDimensions: [],
      expectedRevision: snapshot.expectedRevision,
      postCommitEvents: [postCommitEvent],
      result: { _tag: 'NoChange' as const },
      world: snapshot.world,
    }),
    planTransferTick: () => Effect.die(new Error('The event-only fixture must not transfer items')),
  },
}

const emptyEvents = (hopper: ReadonlyArray<unknown> = []) =>
  Schema.decodeUnknownSync(RedstoneEventBatchSchema)({
    hopper,
    lamp: [],
    piston: [],
    powered: [],
    trigger: [],
  })

const hopperEvent = Schema.decodeUnknownSync(RedstoneEventBatchSchema)({
  hopper: [{
    dimension: dimensionId('overworld'),
    elapsedRedstoneTicks: 4,
    position: blockPosition(10, 10, 10),
    powered: false,
  }],
  lamp: [],
  piston: [],
  powered: [],
  trigger: [],
}).hopper

describe('redstone boundary inputs', () => {
  it.effect('accepts power 0 and 15 and returns a typed schema failure just outside the range', () =>
    Effect.gen(function* () {
      // An inclusive-bound error accepts -1 or rejects one of the valid signal endpoints.
      for (const emits of [0, MAX_POWER_LEVEL]) {
        const result = yield* Effect.result(
          Schema.decodeUnknownEffect(RedstoneWorldSnapshotSchema)(powerSnapshot(emits)),
        )
        expect(Result.isSuccess(result)).toBe(true)
      }
      for (const emits of [-1, MAX_POWER_LEVEL + 1]) {
        const result = yield* Effect.result(
          Schema.decodeUnknownEffect(RedstoneWorldSnapshotSchema)(powerSnapshot(emits)),
        )
        expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: 'SchemaError' } })
      }
    }),
  )

  it.effect('maps pressure plate occupant boundaries using explicit sensor fixtures', () =>
    Effect.sync(() => {
      // These sensor fixtures bypass host lookup; an off-by-one capacity changes one of these readings.
      expect(plateSignal(0, sensorFixtures.binary)).toBe(0)
      expect(plateSignal(1, sensorFixtures.binary)).toBe(MAX_POWER_LEVEL)
      expect(plateSignal(0, sensorFixtures.light)).toBe(0)
      expect(plateSignal(1, sensorFixtures.light)).toBe(1)
      expect(plateSignal(15, sensorFixtures.light)).toBe(MAX_POWER_LEVEL)
      expect(plateSignal(16, sensorFixtures.light)).toBe(MAX_POWER_LEVEL)
      expect(plateSignal(15, sensorFixtures.heavy)).toBe(2)
      expect(plateSignal(150, sensorFixtures.heavy)).toBe(MAX_POWER_LEVEL)
      expect(plateSignal(151, sensorFixtures.heavy)).toBe(MAX_POWER_LEVEL)
    }),
  )

  it.effect('keeps target miss, edge, just-outside-edge, and bullseye readings in range', () =>
    Effect.sync(() => {
      // Failing at an edge or centre would collapse the miss-to-hit and weak-to-strong boundaries.
      expect(targetSignal(null)).toBe(0)
      expect(targetSignal({ horizontal: 0, vertical: 0.5 })).toBe(1)
      expect(targetSignal({ horizontal: -0.01, vertical: 0.5 })).toBe(1)
      expect(targetSignal({ horizontal: 0.5, vertical: 0.5 })).toBe(MAX_POWER_LEVEL)
    }),
  )

  it.effect('accepts 12 piston blocks and returns a typed too-long refusal for 13', () =>
    Effect.sync(() => {
      // An off-by-one push limit either refuses a valid 12-block column or accepts the 13th block.
      const atLimit = Array.from({ length: PISTON_PUSH_LIMIT }, () => 'STONE')
      const overLimit = [...atLimit, 'STONE']

      expect(planPush(atLimit, NOTHING_IS_IMMOVABLE).kind).toBe('push')
      expect(planPush(overLimit, NOTHING_IS_IMMOVABLE)).toMatchObject({
        kind: 'refused',
        refusal: { at: PISTON_PUSH_LIMIT, reason: 'too-long' },
      })
    }),
  )

  it.effect('accepts the last safe derived host position and reports the next one as a Result failure', () =>
    Effect.sync(() => {
      // An unchecked neighbor offset would turn the last safe host coordinate into an invalid position.
      const encodedState = encodeBlockState(Option.getOrThrow(blockIdOf('repeater')), {
        delay: 1,
        facing: 'east',
        locked: false,
        powered: false,
      })
      if (Result.isFailure(encodedState)) {
        throw new Error('Expected a valid piston state fixture')
      }
      const lastSafe = componentForBlock(hopperLookup, 'repeater', {
        position: blockPosition(Number.MAX_SAFE_INTEGER - 1),
        encodedState: encodedState.success,
      })
      const outOfRange = componentForBlock(hopperLookup, 'repeater', {
        position: blockPosition(Number.MAX_SAFE_INTEGER),
        encodedState: encodedState.success,
      })

      expect(Result.isSuccess(lastSafe)).toBe(true)
      expect(outOfRange).toStrictEqual(Result.fail({ _tag: 'RedstoneHostPositionOutOfRange' }))
    }),
  )

  it.effect('returns a typed failure when an event has no matching realm', () =>
    Effect.gen(function* () {
      // A missing realm must be reported before any host write method runs.
      const runtime = yield* RedstoneWorldRuntime
      yield* runtime.restoreEvents(emptyEvents(hopperEvent))
      const missingRealm = yield* Effect.result(
        applyRedstoneHostEvents(runtime, [], hostWritePortWithoutEventBus),
      )
      expect(missingRealm).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'RedstoneHostRealmMissing', dimension: dimensionId('overworld') },
      })
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )

  it.effect('returns a typed failure when post-commit events have no event bus', () =>
    Effect.gen(function* () {
      // An absent bus must fail before the fixture can commit or publish its event.
      const runtime = yield* RedstoneWorldRuntime
      yield* runtime.restoreEvents(emptyEvents(hopperEvent))
      const missingEventBus = yield* Effect.result(
        applyRedstoneHostEvents(
          runtime,
          [hopperRealm(dimensionId('overworld'))],
          hostWritePortWithoutEventBus,
        ),
      )
      expect(missingEventBus).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'RedstoneHostEventBusUnavailable' },
      })
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )
})
