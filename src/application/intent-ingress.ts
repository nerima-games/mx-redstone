import {
  IntentQueue,
  IntentSchema,
  type Intent,
  type IntentQueueFull,
  type IntentSequence,
} from '@nerima-games/mc-sim'
import { Effect, Schema } from 'effect'

export type RedstoneTargetedPayload = Extract<
  Intent['payload'],
  { readonly _tag: 'UseBlock' | 'UseItemOnBlock' }
>

export type RedstoneTargetedIntent = Intent & Readonly<{
  payload: RedstoneTargetedPayload
}>

export type RedstoneIntentNotTargeted = Readonly<{
  _tag: 'RedstoneIntentNotTargeted'
  intentTag: Intent['payload']['_tag']
}>

export type RedstoneIntentIngressFailure =
  | IntentQueueFull
  | RedstoneIntentNotTargeted
  | Schema.SchemaError

const isTargetedIntent = (intent: Intent): intent is RedstoneTargetedIntent =>
  intent.payload._tag === 'UseBlock' || intent.payload._tag === 'UseItemOnBlock'

export const decodeRedstoneTargetedIntent = (
  input: unknown,
): Effect.Effect<RedstoneTargetedIntent, Schema.SchemaError | RedstoneIntentNotTargeted> =>
  Schema.decodeUnknownEffect(IntentSchema)(input).pipe(
    Effect.flatMap((intent) =>
      isTargetedIntent(intent)
        ? Effect.succeed(intent)
        : Effect.fail<RedstoneIntentNotTargeted>({
            _tag: 'RedstoneIntentNotTargeted',
            intentTag: intent.payload._tag,
          }),
    ),
  )

export const enqueueRedstoneIntent = (
  input: unknown,
): Effect.Effect<IntentSequence, RedstoneIntentIngressFailure, IntentQueue> =>
  Effect.gen(function* () {
    const intent = yield* decodeRedstoneTargetedIntent(input)
    const queue = yield* IntentQueue

    return yield* queue.enqueue(intent)
  })
