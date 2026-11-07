import { describe, expect, it } from '@effect/vitest'
import { blockIdOf, BlockAddressSchema, BlockPositionSchema, DeltaTimeSecs, DimensionIdSchema, WorldIdSchema, WorldWriteBatchSchema, type BlockAddress, type BlockPosition } from '@nerima-games/mc-kernel'
import {
  CONTAINER_STORAGE_SNAPSHOT_VERSION,
  HOPPER_REPLICATED_OWNER_ID,
  ReplicatedOwnerIdSchema,
  type HopperTransferOutcome,
  type WorldCommitRequest,
} from '@nerima-games/mc-sim'
import { Effect, Option, Ref, Result, Schema } from 'effect'
import {
  applyRedstoneHostEvents,
  type RedstoneHostLookup,
  type RedstoneHostRealm,
  type RedstoneHostWritePort,
} from '../src/application/redstone-host-port'
import {
  RedstoneEventBatchSchema,
  RedstoneWorldRuntime,
  RedstoneWorldRuntimeLayer,
} from '../src/application/world-runtime'
import {
  type CircuitBoard,
  type Component,
  powerAt,
  settle,
} from '../src/domain/power-graph'
import {
  advanceTimedCircuit,
  emptyTimedCircuitState,
} from '../src/domain/power-timing'
import {
  makeRedstoneFrameState,
  redstoneStages,
} from '../src/stages/registration'
import { REDSTONE_STAGE_IDS } from '../src/stages/stage-ids'
import { FrameServicesLayer } from './frame-services'

const line = (cells: ReadonlyArray<readonly [string, Component]>): CircuitBoard => ({
  components: new Map(cells),
  adjacency: new Map(
    cells.map(([key], index) => [
      key,
      [cells[index - 1]?.[0], cells[index + 1]?.[0]].filter(
        (candidate): candidate is string => candidate !== undefined,
      ),
    ]),
  ),
})

const TEST_WORLD_ID = Schema.decodeUnknownSync(WorldIdSchema)('redstone-tick-timing-test')
const TEST_DIMENSION = Schema.decodeUnknownSync(DimensionIdSchema)('overworld')
const HOPPER_BLOCK_ID = Option.getOrThrow(blockIdOf('hopper'))

const makeHopperRealmAndPort = (elapsedGameTicks: Array<number>) => {
  const position: BlockPosition = Schema.decodeUnknownSync(BlockPositionSchema)({ x: 0, y: 0, z: 0 })
  const address: BlockAddress = Schema.decodeUnknownSync(BlockAddressSchema)({
    dimension: TEST_DIMENSION,
    position,
  })
  const revisionBatch = Schema.decodeUnknownSync(WorldWriteBatchSchema)({
    world: TEST_WORLD_ID,
    expectedWorldRevision: 5,
    dimension: String(TEST_DIMENSION),
    expectedDimensionRevision: 2,
    edits: [{ position, block: HOPPER_BLOCK_ID }],
  })
  const emptyLookup: RedstoneHostLookup = {
    isLeverActive: () => false,
    isPoweredRailPowered: () => false,
    readContainerSlots: () => undefined,
    readHopperBlockId: () => HOPPER_BLOCK_ID,
    readHopperTransferContext: () => ({
      powered: false,
      sourceAbove: null,
      destinationFacing: null,
    }),
    readPistonCell: () => ({ kind: 'missing' }),
    readPistonFacing: () => 'north',
  }
  const realm: RedstoneHostRealm = { dimension: TEST_DIMENSION, lookup: emptyLookup }
  const transferRejected: HopperTransferOutcome = {
    _tag: 'TransferRejected',
    transfer: { _tag: 'ContainerMove', outcome: { _tag: 'EmptySource' } },
  }
  const port: RedstoneHostWritePort = {
    buildCommitRequest: (events, pistonPlans) => {
      const request: WorldCommitRequest = {
        expectedRevision: revisionBatch.expectedWorldRevision,
        expectedDimensions: [{
          dimension: revisionBatch.dimension,
          expectedRevision: revisionBatch.expectedDimensionRevision,
        }],
        changes: [{
          ownerId: Schema.decodeUnknownSync(ReplicatedOwnerIdSchema)('redstone-tick-timing-test-owner'),
          state: { events: events.hopper.length, pistonPlans: pistonPlans.length },
        }],
        blockWrite: revisionBatch,
      }
      return Result.succeed(request)
    },
    buildHopperBlockWrite: (event, blockId, revisions) =>
      Result.succeed(Schema.decodeUnknownSync(WorldWriteBatchSchema)({
        world: TEST_WORLD_ID,
        expectedWorldRevision: revisions.expectedRevision,
        dimension: event.dimension,
        expectedDimensionRevision: revisions.expectedDimensionRevision,
        edits: [{ position: event.position, block: blockId }],
      })),
    coordinator: {
      worldId: TEST_WORLD_ID,
      revision: Effect.succeed(revisionBatch.expectedWorldRevision),
      dimensionRevision: () => Effect.succeed(revisionBatch.expectedDimensionRevision),
      snapshot: (ownerId, schema) => {
        const state = ownerId === HOPPER_REPLICATED_OWNER_ID
          ? { hoppers: [] }
          : { version: CONTAINER_STORAGE_SNAPSHOT_VERSION, containers: [] }
        return Schema.decodeUnknownEffect(schema)(state).pipe(
          Effect.map((decodedState) => ({
            world: TEST_WORLD_ID,
            revision: revisionBatch.expectedWorldRevision,
            state: decodedState,
          })),
        )
      },
      commit: (request) => Effect.succeed({
        world: request.blockWrite?.world ?? TEST_WORLD_ID,
        revision: request.expectedRevision,
        changes: [],
        blockChanges: [],
      }),
    },
    hopperService: {
      planAdvanceCooldown: (snapshot, request) => Effect.sync(() => {
        elapsedGameTicks.push(request.ticks)
        return {
          world: snapshot.world,
          expectedRevision: snapshot.expectedRevision,
          expectedDimensions: [],
          changes: [],
          result: { _tag: 'NoChange' },
          postCommitEvents: [],
        }
      }),
      planTransferTick: () => Effect.sync(() => ({
        world: TEST_WORLD_ID,
        expectedRevision: revisionBatch.expectedWorldRevision,
        expectedDimensions: [],
        changes: [],
        result: transferRejected,
        postCommitEvents: [],
      })),
    },
  }
  return { address, port, realm }
}

describe('tick-by-tick component timing', () => {
  it.effect('holds button power for exactly its default or configured pulse length', () =>
    Effect.sync(() => {
      // A timer that decrements before applying power drops the first pulse tick; one that decrements late adds a tick.
      for (const { pulseTicks, length } of [
        { pulseTicks: undefined, length: 10 },
        { pulseTicks: 4, length: 4 },
      ]) {
        const board = line([
          ['button', pulseTicks === undefined ? { kind: 'button' } : { kind: 'button', pulseTicks }],
          ['wire', { kind: 'wire' }],
        ])
        let state = emptyTimedCircuitState
        for (let tick = 1; tick <= length + 1; tick += 1) {
          state = advanceTimedCircuit(board, state, tick === 1 ? new Set(['button']) : new Set())
          expect(powerAt(state.power, 'wire')).toBe(tick <= length ? 15 : 0)
        }
      }
    }),
  )

  it.effect('applies every repeater delay from one through four on the corresponding tick', () =>
    Effect.sync(() => {
      // Starting a repeater timer one tick early or late shifts its output from the vanilla delay.
      for (const delayTicks of [1, 2, 3, 4]) {
        const board = line([
          ['lever', { active: true, kind: 'lever' }],
          ['rear', { kind: 'wire' }],
          ['repeater', { delayTicks, inputFrom: 'rear', kind: 'repeater', outputTo: 'out' }],
          ['out', { kind: 'wire' }],
        ])
        let state = emptyTimedCircuitState
        for (let tick = 1; tick <= delayTicks + 1; tick += 1) {
          state = advanceTimedCircuit(board, state)
          const expectedPower = tick === delayTicks + 1 ? 15 : 0
          expect(powerAt(state.power, 'repeater')).toBe(expectedPower)
          expect(powerAt(state.power, 'out')).toBe(expectedPower)
        }
      }
    }),
  )

  it.effect('burns out after the eighth rapid off transition and relights after eighty cooldown ticks', () =>
    Effect.sync(() => {
      // Counting the wrong edge or shortening cooldown changes an asserted tick in this sequence.
      const board = line([['torch', { invertedBy: 'torch', kind: 'torch' }]])
      let state = emptyTimedCircuitState
      for (let tick = 1; tick <= 15; tick += 1) {
        state = advanceTimedCircuit(board, state)
        expect(state.torches?.get('torch')?.output).toBe(tick % 2 === 1)
        expect(state.torches?.get('torch')?.burnoutRemainingTicks).toBe(0)
      }

      state = advanceTimedCircuit(board, state)
      expect(state.torches?.get('torch')).toMatchObject({
        burnoutRemainingTicks: 80,
        output: false,
      })
      for (let cooldownTick = 1; cooldownTick <= 79; cooldownTick += 1) {
        state = advanceTimedCircuit(board, state)
        expect(state.torches?.get('torch')).toMatchObject({
          burnoutRemainingTicks: 80 - cooldownTick,
          output: false,
        })
      }
      state = advanceTimedCircuit(board, state)
      expect(state.torches?.get('torch')).toMatchObject({
        burnoutRemainingTicks: 0,
        output: true,
      })
    }),
  )

  it.effect('converts each elapsed redstone hopper tick into two game ticks', () =>
    Effect.gen(function* () {
      // Passing one game tick per redstone tick slowly desynchronizes hopper cooldowns from Minecraft time.
      const elapsedGameTicks: Array<number> = []
      const { address, port, realm } = makeHopperRealmAndPort(elapsedGameTicks)
      const runtime = yield* RedstoneWorldRuntime
      for (let tick = 0; tick < 4; tick += 1) {
        const [event] = Schema.decodeUnknownSync(RedstoneEventBatchSchema)({
          hopper: [{ dimension: TEST_DIMENSION, elapsedRedstoneTicks: 1, powered: false, position: address.position }],
          lamp: [],
          piston: [],
          powered: [],
          trigger: [],
        }).hopper
        if (event === undefined) throw new Error('Expected one hopper event')
        yield* runtime.restoreEvents({ hopper: [event], lamp: [], piston: [], powered: [], trigger: [] })
        yield* applyRedstoneHostEvents(runtime, [realm], port)
        expect(elapsedGameTicks).toStrictEqual(Array.from({ length: tick + 1 }, () => 2))
      }
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )

  it.effect('settles a stable circuit and reports a self-inverting torch as oscillating', () =>
    Effect.sync(() => {
      // A missing fixpoint check mislabels stable power; an unbounded search never returns for the clock.
      const stable = settle(line([
        ['lever', { active: true, kind: 'lever' }],
        ['wire', { kind: 'wire' }],
      ]))
      expect(stable).toMatchObject({ oscillating: false, ticks: 2 })
      expect(powerAt(stable.power, 'wire')).toBe(15)

      const clock = settle(line([['torch', { invertedBy: 'torch', kind: 'torch' }]]))
      expect(clock).toMatchObject({ oscillating: true, ticks: 3 })
    }),
  )

  it.effect('caps each stage frame at four ticks and discards its excess elapsed time', () =>
    Effect.gen(function* () {
      // Banking a capped frame's overflow makes the next ordinary frame exceed the same limit again.
      const state = yield* makeRedstoneFrameState
      const powerStage = redstoneStages(state).find((stage) => stage.id === REDSTONE_STAGE_IDS.power)
      if (powerStage === undefined) throw new Error('Expected the redstone power stage')
      yield* Ref.set(state.board, line([
        ['lever', { active: true, kind: 'lever' }],
        ['wire', { kind: 'wire' }],
      ]))

      yield* powerStage.run(DeltaTimeSecs(1))
      expect(yield* Ref.get(state.tickCount)).toBe(4)
      yield* powerStage.run(DeltaTimeSecs(0.1))
      expect(yield* Ref.get(state.tickCount)).toBe(5)
    }).pipe(Effect.provide(FrameServicesLayer)),
  )
})
