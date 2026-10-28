import { describe, expect, it } from '@effect/vitest'
import * as fc from 'fast-check'
import { Effect, Layer, Result, Schema } from 'effect'
import {
  BlockPositionSchema,
  DeltaTimeSecs,
  DimensionIdSchema,
  WorldIdSchema,
  WorldWriteBatchSchema,
  type BlockAddress,
  type BlockPosition,
  type StageRegistration,
} from '@nerima-games/mc-kernel'
import {
  makeWorldCommitCoordinator,
  ReplicatedOwnerChangeSchema,
  WorldCommitCoordinatorErrorSchema,
  WorldCommitResultSchema,
  type WorldCommitRequest,
} from '@nerima-games/mc-sim'
import {
  applyRedstoneHostEvents,
  type RedstoneHostRealm,
  type RedstoneHostWritePort,
} from '../src/application/redstone-host-port'
import {
  RedstoneEventBatchSchema,
  RedstoneWorldRuntime,
  RedstoneWorldRuntimeLayer,
  RedstoneWorldRuntimeStateErrorSchema,
  type RedstoneEventBatch,
  type RedstoneWorldRuntimeService,
} from '../src/application/world-runtime'
import { makeRuntimeRedstoneStages } from '../src/stages/registration'
import { REDSTONE_STAGE_IDS } from '../src/stages/stage-ids'
import { FrameServicesLayer } from './frame-services'

const strictDecode = { onExcessProperty: 'error' } as const
const zero = 0
const one = 1
const two = 2
const frameSeconds = 0.1
const PROPERTY_RUN_COUNT = 50
const testWorldId = Schema.decodeUnknownSync(WorldIdSchema)('redstone-properties')
type RedstoneDimensionId = BlockAddress['dimension']

const commitResultSchema = WorldCommitResultSchema(ReplicatedOwnerChangeSchema)

const dimensionId = (value: string): RedstoneDimensionId =>
  Schema.decodeUnknownSync(DimensionIdSchema)(value)

const blockPosition = (x: number): BlockPosition =>
  Schema.decodeUnknownSync(BlockPositionSchema)({ x, y: zero, z: zero })

const emptyEventBatch: RedstoneEventBatch = {
  hopper: [],
  lamp: [],
  piston: [],
  powered: [],
  trigger: [],
}

const drainEventBatch = (runtime: RedstoneWorldRuntimeService) =>
  Effect.gen(function* drainEventBatchGenerator() {
    return {
      hopper: yield* runtime.drainHopperTransferEvents,
      lamp: yield* runtime.drainLampTransitions,
      piston: yield* runtime.drainPistonTransitions,
      powered: yield* runtime.drainPoweredComponentTransitions,
      trigger: yield* runtime.drainTriggerEvents,
    }
  })

const stageById = (stages: ReadonlyArray<StageRegistration>, id: string): StageRegistration => {
  const stage = stages.find((candidate) => candidate.id === id)
  if (typeof stage === 'undefined') {
    throw new Error(`Missing redstone stage ${id}`)
  }
  return stage
}

const runFrame = (stages: ReadonlyArray<StageRegistration>) =>
  Effect.gen(function* runFrameGenerator() {
    yield* stageById(stages, REDSTONE_STAGE_IDS.power).run(DeltaTimeSecs(frameSeconds))
    yield* stageById(stages, REDSTONE_STAGE_IDS.effects).run(DeltaTimeSecs(frameSeconds))
  })

const makeUnregisteredRuntime = (calls: { count: number }): RedstoneWorldRuntimeService => {
  const mark = () => Effect.sync(() => {
    calls.count += one
  })
  const markDrain = () => Effect.sync(() => {
    calls.count += one
    return []
  })
  return {
    syncSnapshot: mark,
    pressButton: mark,
    restoreEvents: mark,
    drainLampTransitions: markDrain(),
    drainPistonTransitions: markDrain(),
    drainTriggerEvents: markDrain(),
    drainHopperTransferEvents: markDrain(),
    drainPoweredComponentTransitions: markDrain(),
  }
}

const runTick = (positionX: number, active: boolean, useUnregisteredRuntime: boolean) => {
  const dimension = dimensionId('overworld')
  const runtimeCalls = { count: zero }
  let runtimeLayer = RedstoneWorldRuntimeLayer
  if (useUnregisteredRuntime) {
    runtimeLayer = Layer.succeed(RedstoneWorldRuntime, makeUnregisteredRuntime(runtimeCalls))
  }
  const program = Effect.gen(function* runTickGenerator() {
    const runtime = yield* RedstoneWorldRuntime
    const stages = yield* makeRuntimeRedstoneStages
    yield* runtime.syncSnapshot({
      dimension,
      components: [
        { kind: 'lever', active, position: blockPosition(positionX) },
        { kind: 'lamp', position: blockPosition(positionX + one) },
      ],
    })
    yield* runFrame(stages)
    return yield* drainEventBatch(runtime)
  }).pipe(
    Effect.provide(runtimeLayer),
    Effect.provide(FrameServicesLayer),
  )

  return {
    result: Effect.runSync(Effect.result(program)),
    runtimeCalls: runtimeCalls.count,
  }
}

const buildCommitRequest = (
  position: BlockPosition,
  expectedRevision: WorldCommitRequest['expectedRevision'],
  expectedDimensionRevision: WorldCommitRequest['expectedDimensions'][number]['expectedRevision'],
): WorldCommitRequest => {
  const blockWrite = Schema.decodeUnknownSync(WorldWriteBatchSchema, strictDecode)({
    world: testWorldId,
    expectedWorldRevision: expectedRevision,
    dimension: 'overworld',
    expectedDimensionRevision,
    edits: [{ position, block: one }],
  })

  return {
    expectedRevision: blockWrite.expectedWorldRevision,
    expectedDimensions: [{
      dimension: blockWrite.dimension,
      expectedRevision: blockWrite.expectedDimensionRevision,
    }],
    changes: [],
    blockWrite,
  }
}


const runHostBatch = (positionX: number, mixedDimensions: boolean) => {
  const position = blockPosition(positionX)
  const overworld = dimensionId('overworld')
  const lampEvents = [{ dimension: overworld, position, lit: true }]
  if (mixedDimensions) {
    lampEvents.push({ dimension: dimensionId('nether'), position, lit: false })
  }
  const events = Schema.decodeUnknownSync(RedstoneEventBatchSchema, strictDecode)({
    ...emptyEventBatch,
    lamp: lampEvents,
  })
  const testRealm: RedstoneHostRealm = {
    dimension: overworld,
    lookup: {
      isLeverActive: () => false,
      isPoweredRailPowered: () => false,
      readContainerSlots: () => void 0,
      readPistonCell: () => ({ kind: 'empty' }),
      readPistonFacing: () => 'north',
    },
  }
  const coordinatorResult = Effect.runSync(Effect.result(makeWorldCommitCoordinator({
    world: testWorldId,
    owners: [],
    dimensions: ['overworld'],
  })))
  if (Result.isFailure(coordinatorResult)) {
    throw new Error('The property-test coordinator options must be valid')
  }
  const coordinator = coordinatorResult.success
  const expectedRevision = Effect.runSync(coordinator.revision)
  const expectedDimensionRevision = Effect.runSync(coordinator.dimensionRevision(overworld))
  let buildCalls = zero
  let commitCalls = zero
  const port: RedstoneHostWritePort = {
    buildCommitRequest: () => {
      buildCalls += one
      return Result.succeed(buildCommitRequest(position, expectedRevision, expectedDimensionRevision))
    },
    commit: (request) => {
      commitCalls += one
      return coordinator.commit(request)
    },
  }

  const program = Effect.gen(function* runHostBatchGenerator() {
    const runtime = yield* RedstoneWorldRuntime
    yield* runtime.restoreEvents(events)
    const result = yield* Effect.result(applyRedstoneHostEvents(runtime, [testRealm], port))
    const remaining = yield* drainEventBatch(runtime)
    const revision = yield* coordinator.revision
    const dimensionRevision = yield* coordinator.dimensionRevision(overworld)
    return { result, remaining, revision, dimensionRevision }
  }).pipe(Effect.provide(RedstoneWorldRuntimeLayer))

  const execution = Effect.runSync(program)

  return {
    buildCalls,
    commitCalls,
    events,
    expectedRevision,
    expectedDimensionRevision,
    execution,
  }
}

describe('redstone property boundaries', () => {
  it('returns typed tick failures or strictly decoded batches with kernel-branded coordinates', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -Number.MAX_SAFE_INTEGER + one, max: Number.MAX_SAFE_INTEGER - two }),
        fc.boolean(),
        fc.boolean(),
        (positionX, active, useUnregisteredRuntime) => {
          const output = runTick(positionX, active, useUnregisteredRuntime)
          if (Result.isFailure(output.result)) {
            const failure = Schema.decodeUnknownSync(RedstoneWorldRuntimeStateErrorSchema, strictDecode)(
              output.result.failure,
            )
            expect(failure['_tag']).toBe('UnregisteredRedstoneWorldRuntime')
            expect(output.runtimeCalls).toBe(zero)
            return
          }

          const decoded = Schema.decodeUnknownSync(RedstoneEventBatchSchema, strictDecode)(output.result.success)
          expect(decoded).toStrictEqual(output.result.success)
          expect(output.runtimeCalls).toBe(zero)
          for (const event of decoded.lamp) {
            expect(Schema.decodeUnknownSync(BlockPositionSchema)(event.position)).toStrictEqual(event.position)
            expect(Schema.decodeUnknownSync(DimensionIdSchema)(event.dimension)).toBe(event.dimension)
          }
        },
      ),
      { numRuns: PROPERTY_RUN_COUNT },
    )
  })

  it('restores events and preserves world revisions after host or coordinator failure', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
        fc.boolean(),
        (positionX, mixedDimensions) => {
          const output = runHostBatch(positionX, mixedDimensions)
          expect(Result.isFailure(output.execution.result)).toBe(true)
          if (Result.isFailure(output.execution.result)) {
            if (mixedDimensions) {
              expect(output.execution.result.failure).toMatchObject({ _tag: 'RedstoneHostMixedDimensions' })
              expect(output.buildCalls).toBe(zero)
              expect(output.commitCalls).toBe(zero)
            } else {
              const failure = Schema.decodeUnknownSync(WorldCommitCoordinatorErrorSchema, strictDecode)(
                output.execution.result.failure,
              )
              const failureResult = Result.fail(failure)
              const decoded = Schema.decodeUnknownSync(commitResultSchema, strictDecode)(failureResult)
              expect(decoded).toStrictEqual(failureResult)
              expect(output.buildCalls).toBe(one)
              expect(output.commitCalls).toBe(one)
            }
          }
          expect(output.execution.revision).toStrictEqual(output.expectedRevision)
          expect(output.execution.dimensionRevision).toStrictEqual(output.expectedDimensionRevision)
          expect(output.execution.remaining).toStrictEqual(output.events)
        },
      ),
      { numRuns: PROPERTY_RUN_COUNT },
    )
  })
})
