import { describe, expect, it } from '@effect/vitest'
import { IntentQueue, IntentQueueCapacitySchema, IntentQueueLayer } from '@nerima-games/mc-sim'
import { SimulationTickSchema } from '@nerima-games/mc-kernel'
import { Effect, Result, Schema } from 'effect'
import { enqueueRedstoneIntent } from '../src/application/intent-ingress'

const queueLayer = () =>
  IntentQueueLayer({
    capacity: Schema.decodeUnknownSync(IntentQueueCapacitySchema)(4),
  })

const deviceOperation: unknown = {
  id: 'redstone:device:1',
  targetTick: 4,
  source: 'local',
  payload: {
    _tag: 'UseBlock',
    actor: 'player:1',
    address: {
      dimension: 'overworld',
      position: { x: 1, y: 2, z: 3 },
    },
    face: 'north',
  },
}

const blockItemUse: unknown = {
  id: 'redstone:item:1',
  targetTick: 4,
  source: 'local',
  payload: {
    _tag: 'UseItemOnBlock',
    actor: 'player:1',
    item: 1,
    address: {
      dimension: 'overworld',
      position: { x: 4, y: 5, z: 6 },
    },
    face: 'up',
  },
}

const untargetedItemUse: unknown = {
  id: 'redstone:item:2',
  targetTick: 4,
  source: 'local',
  payload: {
    _tag: 'UseItem',
    actor: 'player:1',
    item: 1,
  },
}

const readyAtFour = Schema.decodeUnknownSync(SimulationTickSchema)(4)

describe('redstone intent ingress', () => {
  it.effect('decodes and enqueues device operations as UseBlock', () =>
    Effect.gen(function* () {
      const sequence = yield* enqueueRedstoneIntent(deviceOperation)
      const queue = yield* IntentQueue
      const ready = yield* queue.takeReady(readyAtFour)

      expect(sequence).toBe(0)
      expect(ready).toHaveLength(1)
      expect(ready[0]?.intent.payload._tag).toBe('UseBlock')
      expect(ready[0]?.intent.payload).toMatchObject({
        actor: 'player:1',
        address: {
          dimension: 'overworld',
          position: { x: 1, y: 2, z: 3 },
        },
      })
    }).pipe(Effect.provide(queueLayer())),
  )

  it.effect('decodes and enqueues block-item inputs as UseItemOnBlock', () =>
    Effect.gen(function* () {
      const sequence = yield* enqueueRedstoneIntent(blockItemUse)
      const queue = yield* IntentQueue
      const ready = yield* queue.takeReady(readyAtFour)

      expect(sequence).toBe(0)
      expect(ready).toHaveLength(1)
      expect(ready[0]?.intent.payload).toMatchObject({
        _tag: 'UseItemOnBlock',
        actor: 'player:1',
        item: 1,
        address: {
          dimension: 'overworld',
          position: { x: 4, y: 5, z: 6 },
        },
      })
    }).pipe(Effect.provide(queueLayer())),
  )

  it.effect('rejects UseItem with a typed failure and leaves the session queue empty', () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(enqueueRedstoneIntent(untargetedItemUse))
      const queue = yield* IntentQueue
      const ready = yield* queue.takeReady(readyAtFour)

      expect(result).toStrictEqual(
        Result.fail({
          _tag: 'RedstoneIntentNotTargeted',
          intentTag: 'UseItem',
        }),
      )
      expect(ready).toStrictEqual([])
    }).pipe(Effect.provide(queueLayer())),
  )

  it.effect('returns schema failure for malformed target data without enqueueing', () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        enqueueRedstoneIntent({
          id: 'redstone:device:2',
          targetTick: 4,
          source: 'local',
          payload: {
            _tag: 'UseBlock',
            actor: 'player:1',
            address: {
              dimension: 'overworld',
              position: { x: '1', y: 2, z: 3 },
            },
            face: 'north',
          },
        }),
      )
      const queue = yield* IntentQueue
      const ready = yield* queue.takeReady(readyAtFour)

      expect(Result.isFailure(result)).toBe(true)
      expect(ready).toStrictEqual([])
    }).pipe(Effect.provide(queueLayer())),
  )
})
