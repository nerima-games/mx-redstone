import { describe, expect, it } from '@effect/vitest'
import { Effect, Option, Result, Schema } from 'effect'
import {
  AIR_BLOCK_ID,
  BlockPositionSchema,
  DimensionRevisionSchema,
  DimensionIdSchema,
  WorldIdSchema,
  WorldRevisionSchema,
  capabilityOfBlockId,
  blockIdOf,
  DeltaTimeSecs,
  type BlockPosition,
  type BlockRegistryResolutionFailure,
  type StageRegistration,
} from '@nerima-games/mc-kernel'
import { vi } from 'vitest'
import {
  applyRedstoneHostEvents,
  kernelPistonCapabilities,
  type RedstoneHostRealm,
  type RedstoneHostWritePort,
} from '../src/application/redstone-host-port'
import {
  RedstoneWorldRuntime,
  RedstoneWorldRuntimeLayer,
} from '../src/application/world-runtime'
import { makeRuntimeRedstoneStages } from '../src/stages/registration'
import { REDSTONE_STAGE_IDS } from '../src/stages/stage-ids'
// eslint-disable-next-line sort-imports
import { FrameServicesLayer } from './frame-services'

vi.mock('@nerima-games/mc-kernel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nerima-games/mc-kernel')>()
  return {
    ...actual,
    blockIdOf: vi.fn(actual.blockIdOf),
    capabilityOfBlockId: vi.fn(actual.capabilityOfBlockId),
  }
})

const capabilityResolutionFailure: BlockRegistryResolutionFailure = {
  _tag: 'BlockCapabilityFailure',
  reason: 'unknown-key',
  message: 'The capability registry could not resolve pistonImmovable',
}

const dimensionId = (value: string): RedstoneHostRealm['dimension'] =>
  Schema.decodeUnknownSync(DimensionIdSchema)(value)
const testWorldId = Schema.decodeUnknownSync(WorldIdSchema)('redstone-host-failure')
const worldRevision = Schema.decodeUnknownSync(WorldRevisionSchema)(0)
const dimensionRevision = Schema.decodeUnknownSync(DimensionRevisionSchema)(0)
const blockPosition = (x: number, y: number, z: number): BlockPosition =>
  Schema.decodeUnknownSync(BlockPositionSchema)({ x, y, z })

const stageById = (stages: ReadonlyArray<StageRegistration>, id: string): StageRegistration => {
  const stage = stages.find((candidate) => candidate.id === id)
  if (stage === undefined) {
    throw new Error(`Missing redstone stage ${id}`)
  }
  return stage
}

const runFrame = (stages: ReadonlyArray<StageRegistration>): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* stageById(stages, REDSTONE_STAGE_IDS.power).run(DeltaTimeSecs(0.1)).pipe(Effect.provide(FrameServicesLayer))
    yield* stageById(stages, REDSTONE_STAGE_IDS.effects).run(DeltaTimeSecs(0.1)).pipe(Effect.provide(FrameServicesLayer))
  })

describe('kernel capability registry failures at the host boundary', () => {
  it.effect('does not treat a registered block with no registry id as immovable', () =>
    Effect.sync(() => {
      vi.mocked(blockIdOf).mockReturnValue(Option.none())

      expect(kernelPistonCapabilities.pistonImmovable('bedrock')).toStrictEqual(Result.succeed(false))
      expect(capabilityOfBlockId).not.toHaveBeenCalled()
    }),
  )

  it.effect('fails the host Effect when a piston capability lookup fails', () =>
    Effect.gen(function* () {
      vi.mocked(blockIdOf).mockReturnValue(Option.some(AIR_BLOCK_ID))
      vi.mocked(capabilityOfBlockId).mockReturnValue(Result.fail(capabilityResolutionFailure))

      const runtime = yield* RedstoneWorldRuntime
      const stages = yield* makeRuntimeRedstoneStages
      let buildCalls = 0
      let commitCalls = 0
      const realm: RedstoneHostRealm = {
        dimension: dimensionId('overworld'),
        lookup: {
          isLeverActive: () => false,
          isPoweredRailPowered: () => false,
          readHopperBlockId: () => AIR_BLOCK_ID,
          readHopperTransferContext: () => ({ powered: false, sourceAbove: null, destinationFacing: null }),
          readContainerSlots: () => undefined,
          readPistonCell: () => ({ kind: 'block', block: 'bedrock' }),
          readPistonFacing: () => 'south',
        },
      }

      const port: RedstoneHostWritePort<BlockRegistryResolutionFailure> = {
        buildCommitRequest: () => {
          buildCalls += 1
          return Result.fail(capabilityResolutionFailure)
        },
        buildHopperBlockWrite: () => Result.fail(capabilityResolutionFailure),
        coordinator: {
          worldId: testWorldId,
          revision: Effect.succeed(worldRevision),
          dimensionRevision: () => Effect.succeed(dimensionRevision),
          commit: () => {
            commitCalls += 1
            return Effect.never
          },
        },
        hopperService: {
          advanceCooldown: () => Effect.never,
          transfer: () => Effect.never,
        },
      }

      yield* runtime.syncSnapshot({
        dimension: dimensionId('overworld'),
        components: [
          { active: true, kind: 'lever', position: blockPosition(0, 0, 0) },
          {
            kind: 'piston',
            pistonFacing: 'south',
            pistonKind: 'normal',
            pistonState: 'retracted',
            position: blockPosition(0, 0, -1),
          },
        ],
      })
      yield* runFrame(stages)

      const result = yield* Effect.result(applyRedstoneHostEvents(runtime, [realm], port))

      expect(result).toStrictEqual(Result.fail(capabilityResolutionFailure))
      expect(buildCalls).toBe(0)
      expect(commitCalls).toBe(0)
    }).pipe(Effect.provide(RedstoneWorldRuntimeLayer)),
  )
})
