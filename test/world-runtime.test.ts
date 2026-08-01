import { describe, expect, it } from '@effect/vitest'
import { Effect, Ref } from 'effect'
import {
  RedstoneWorldRuntime,
  RedstoneWorldRuntimeLayer,
  redstoneNodeId,
  redstoneWorldStateFor,
  type RedstoneComponentSnapshot,
  type RedstoneWorldRuntimeService,
  type RedstoneWorldSnapshot,
} from '../src/application/world-runtime'
import { DeltaTimeSecs, type StageRegistration } from '../src/domain/frame-contract'
import { makeRuntimeRedstoneStages } from '../src/stages/registration'
import { REDSTONE_STAGE_IDS } from '../src/stages/stage-ids'

const component = (
  x: number,
  kind: RedstoneComponentSnapshot['kind'],
  active?: boolean,
  y = 0,
  z = 0,
  timing: Pick<RedstoneComponentSnapshot, 'delayTicks' | 'pulseTicks'> = {},
): RedstoneComponentSnapshot => ({
  position: { x, y, z },
  kind,
  ...(active === undefined ? {} : { active }),
  ...timing,
})

const snapshot = (
  dimension: string,
  components: ReadonlyArray<RedstoneComponentSnapshot>,
): RedstoneWorldSnapshot => ({ dimension, components })

const stageById = (
  stages: ReadonlyArray<StageRegistration>,
  id: string,
): StageRegistration => {
  const stage = stages.find((candidate) => candidate.id === id)
  if (stage === undefined) throw new Error(`missing stage ${id}`)
  return stage
}

const runFrame = (
  stages: ReadonlyArray<StageRegistration>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* stageById(stages, REDSTONE_STAGE_IDS.power).run(DeltaTimeSecs(0.1))
    yield* stageById(stages, REDSTONE_STAGE_IDS.effects).run(DeltaTimeSecs(0.1))
  })

const runtimeProgram = <A>(
  use: (
    runtime: RedstoneWorldRuntimeService,
    stages: ReadonlyArray<StageRegistration>,
  ) => Effect.Effect<A>,
): Effect.Effect<A> =>
  Effect.gen(function* () {
    const runtime = yield* RedstoneWorldRuntime
    const stages = yield* makeRuntimeRedstoneStages
    return yield* use(runtime, stages)
  }).pipe(Effect.provide(RedstoneWorldRuntimeLayer))

describe('RedstoneWorldRuntime', () => {
  it.effect('builds stable six-face topology without connecting dimensions or diagonals', () =>
    runtimeProgram((runtime) =>
      Effect.gen(function* () {
        yield* runtime.syncSnapshot(
          snapshot('overworld', [
            component(0, 'lever', true),
            component(1, 'wire'),
            component(1, 'lamp', undefined, 1),
          ]),
        )
        yield* runtime.syncSnapshot(snapshot('nether', [component(1, 'comparator')]))

        const board = yield* Ref.get(redstoneWorldStateFor(runtime).board)
        const lever = redstoneNodeId('overworld', { x: 0, y: 0, z: 0 })
        const wire = redstoneNodeId('overworld', { x: 1, y: 0, z: 0 })
        const diagonal = redstoneNodeId('overworld', { x: 1, y: 1, z: 0 })
        const nether = redstoneNodeId('nether', { x: 1, y: 0, z: 0 })

        expect(redstoneNodeId('overworld', { x: 0, y: 0, z: 0 })).toBe(lever)
        expect(board.adjacency.get(lever)).toStrictEqual([wire])
        expect(board.adjacency.get(lever)).not.toContain(diagonal)
        expect(board.adjacency.get(lever)).not.toContain(nether)
        expect(board.components.get(nether)?.kind).toBe('comparator')
      }),
    ),
  )

  it.effect('preserves the graph signal-distance boundary', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        const wires = Array.from({ length: 14 }, (_, index) => component(index + 1, 'wire'))
        yield* runtime.syncSnapshot(
          snapshot('overworld', [
            component(0, 'lever', true),
            ...wires,
            component(15, 'lamp'),
            component(16, 'lamp'),
          ]),
        )

        yield* runFrame(stages)
        expect(yield* runtime.drainLampTransitions).toStrictEqual([
          { dimension: 'overworld', position: { x: 15, y: 0, z: 0 }, lit: true },
        ])
      }),
    ),
  )

  it.effect('reports lever toggles once and drains transitions atomically', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        const circuit = (active: boolean) =>
          snapshot('overworld', [
            component(0, 'lever', active),
            component(1, 'wire'),
            component(2, 'lamp'),
          ])

        yield* runtime.syncSnapshot(circuit(true))
        yield* runFrame(stages)
        expect(yield* runtime.drainLampTransitions).toStrictEqual([
          { dimension: 'overworld', position: { x: 2, y: 0, z: 0 }, lit: true },
        ])
        expect(yield* runtime.drainLampTransitions).toStrictEqual([])

        yield* runFrame(stages)
        expect(yield* runtime.drainLampTransitions).toStrictEqual([])

        yield* runtime.syncSnapshot(circuit(false))
        yield* runFrame(stages)
        expect(yield* runtime.drainLampTransitions).toStrictEqual([
          { dimension: 'overworld', position: { x: 2, y: 0, z: 0 }, lit: false },
        ])
      }),
    ),
  )

  it.effect('turns lamps off after disconnection and after lamp removal', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        const connected = snapshot('overworld', [
          component(0, 'lever', true),
          component(1, 'wire'),
          component(2, 'lamp'),
        ])

        yield* runtime.syncSnapshot(connected)
        yield* runFrame(stages)
        yield* runtime.drainLampTransitions

        yield* runtime.syncSnapshot(
          snapshot('overworld', [component(0, 'lever', true), component(2, 'lamp')]),
        )
        yield* runFrame(stages)
        expect(yield* runtime.drainLampTransitions).toStrictEqual([
          { dimension: 'overworld', position: { x: 2, y: 0, z: 0 }, lit: false },
        ])

        yield* runtime.syncSnapshot(connected)
        yield* runFrame(stages)
        yield* runtime.drainLampTransitions
        yield* runtime.syncSnapshot(
          snapshot('overworld', [component(0, 'lever', true), component(1, 'wire')]),
        )
        yield* runFrame(stages)
        expect(yield* runtime.drainLampTransitions).toStrictEqual([
          { dimension: 'overworld', position: { x: 2, y: 0, z: 0 }, lit: false },
        ])
      }),
    ),
  )

  it.effect('keeps identical coordinates isolated between dimensions', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        const circuit = (dimension: string, active: boolean) =>
          snapshot(dimension, [
            component(0, 'lever', active),
            component(1, 'wire'),
            component(2, 'lamp'),
          ])

        yield* runtime.syncSnapshot(circuit('overworld', true))
        yield* runtime.syncSnapshot(circuit('nether', false))
        yield* runFrame(stages)
        expect(yield* runtime.drainLampTransitions).toStrictEqual([
          { dimension: 'overworld', position: { x: 2, y: 0, z: 0 }, lit: true },
        ])

        yield* runtime.syncSnapshot(circuit('nether', true))
        yield* runFrame(stages)
        expect(yield* runtime.drainLampTransitions).toStrictEqual([
          { dimension: 'nether', position: { x: 2, y: 0, z: 0 }, lit: true },
        ])
      }),
    ),
  )

  it.effect('runs button pulses and configured repeater delays through the runtime stage', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        yield* runtime.syncSnapshot(
          snapshot('overworld', [
            component(0, 'button', undefined, 0, 0, { pulseTicks: 4 }),
            component(1, 'wire'),
            {
              ...component(2, 'repeater', undefined, 0, 0, { delayTicks: 2 }),
              inputFrom: { x: 1, y: 0, z: 0 },
              outputTo: { x: 3, y: 0, z: 0 },
            },
            component(3, 'lamp'),
          ]),
        )

        yield* runtime.pressButton('overworld', { x: 0, y: 0, z: 0 })
        yield* runFrame(stages)
        expect(yield* runtime.drainLampTransitions).toStrictEqual([])

        yield* runFrame(stages)
        expect(yield* runtime.drainLampTransitions).toStrictEqual([])

        yield* runFrame(stages)
        expect(yield* runtime.drainLampTransitions).toStrictEqual([
          { dimension: 'overworld', position: { x: 3, y: 0, z: 0 }, lit: true },
        ])

        yield* runFrame(stages)
        expect(yield* runtime.drainLampTransitions).toStrictEqual([])

        yield* runFrame(stages)
        expect(yield* runtime.drainLampTransitions).toStrictEqual([])

        yield* runFrame(stages)
        expect(yield* runtime.drainLampTransitions).toStrictEqual([])

        yield* runFrame(stages)
        expect(yield* runtime.drainLampTransitions).toStrictEqual([
          { dimension: 'overworld', position: { x: 3, y: 0, z: 0 }, lit: false },
        ])
      }),
    ),
  )

  it.effect('emits one powered piston transition per power edge', () =>
    runtimeProgram((runtime, stages) =>
      Effect.gen(function* () {
        yield* runtime.syncSnapshot(snapshot('overworld', [
          component(0, 'lever', true),
          {
            ...component(1, 'piston'),
            pistonFacing: 'east',
            pistonKind: 'sticky',
            pistonState: 'retracted',
          },
        ]))

        yield* runFrame(stages)
        expect(yield* runtime.drainPistonTransitions).toStrictEqual([{
          dimension: 'overworld',
          piston: { x: 1, y: 0, z: 0 },
          facing: 'east',
          kind: 'sticky',
          state: 'retracted',
          powered: true,
        }])
        yield* runFrame(stages)
        expect(yield* runtime.drainPistonTransitions).toStrictEqual([])

        yield* runtime.syncSnapshot(snapshot('overworld', [
          component(0, 'lever', false),
          {
            ...component(1, 'piston'),
            pistonFacing: 'east',
            pistonKind: 'sticky',
            pistonState: 'extended',
          },
        ]))
        yield* runFrame(stages)
        expect(yield* runtime.drainPistonTransitions).toStrictEqual([{
          dimension: 'overworld',
          piston: { x: 1, y: 0, z: 0 },
          facing: 'east',
          kind: 'sticky',
          state: 'extended',
          powered: false,
        }])
      }),
    ),
  )
})
