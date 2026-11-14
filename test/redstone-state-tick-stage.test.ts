import { describe, expect, it } from '@effect/vitest'
import {
  BlockPositionSchema,
  DeltaTimeSecs,
  DimensionIdSchema,
  type StageRegistration,
} from '@nerima-games/mc-kernel'
import { makeTickService, runStagesForTicks, type TickServiceApi } from '@nerima-games/mc-sim'
import { Effect, Ref, Schema } from 'effect'
import { makeRedstoneFrameState, redstoneStages } from '../src/stages/registration'
import { MAX_POWER_LEVEL, powerAt, type CircuitBoard, type Component } from '../src/domain/power-graph'
import { syncRedstoneSnapshot } from '../src/application/world-runtime'
import { FrameServicesLayer } from './frame-services'

const repeaterBoard = (delayTicks: number): CircuitBoard => ({
  adjacency: new Map([
    ['lever', ['rear']],
    ['rear', ['lever', 'repeater']],
    ['repeater', ['rear', 'output']],
    ['output', ['repeater']],
  ]),
  components: new Map<string, Component>([
    ['lever', { active: true, kind: 'lever' }],
    ['rear', { kind: 'wire' }],
    ['repeater', { delayTicks, inputFrom: 'rear', kind: 'repeater', outputTo: 'output' }],
    ['output', { kind: 'wire' }],
  ]),
})

const runGameTicks = (
  tickService: TickServiceApi,
  stages: ReadonlyArray<StageRegistration>,
  count: number,
) =>
  Effect.gen(function* () {
    for (let tick = 0; tick < count; tick += 1) {
      const advanced = yield* tickService.advanceFrame(DeltaTimeSecs(0.05))
      expect(advanced.ticks).toBe(1)
      yield* runStagesForTicks(stages, advanced.ticks)
    }
  })

describe('mc-sim fixed-tick redstone integration', () => {
  it.effect('runs the exported redstone stage through makeTickService and runStagesForTicks', () =>
    Effect.gen(function* () {
      const state = yield* makeRedstoneFrameState
      yield* Ref.set(state.board, repeaterBoard(3))
      const stages = redstoneStages(state)
      const tickService = yield* makeTickService()

      const gameTickCount = 8
      for (let gameTick = 0; gameTick < gameTickCount; gameTick += 1) {
        const advanced = yield* tickService.advanceFrame(DeltaTimeSecs(0.05))
        expect(advanced.ticks).toBe(1)
        yield* runStagesForTicks(stages, advanced.ticks)

        const redstoneTicks = Math.floor((gameTick + 1) / 2)
        expect(yield* Ref.get(state.tickCount)).toBe(redstoneTicks)
        const outputPower = powerAt(yield* Ref.get(state.power), 'output')
        expect(outputPower).toBe(redstoneTicks >= 4 ? MAX_POWER_LEVEL : 0)
      }
    }).pipe(Effect.provide(FrameServicesLayer)),
  )

  it.effect('runs torch inversion as a NOT gate after one redstone-tick dependency', () =>
    Effect.gen(function* () {
      const state = yield* makeRedstoneFrameState
      const stages = redstoneStages(state)
      const tickService = yield* makeTickService()
      const boardFor = (inputActive: boolean): CircuitBoard => ({
        adjacency: new Map([
          ['input', ['torch']],
          ['torch', ['input', 'output']],
          ['output', ['torch']],
        ]),
        components: new Map<string, Component>([
          ['input', { active: inputActive, kind: 'lever' }],
          ['torch', { inputFrom: 'input', invertedBy: 'input', kind: 'torch' }],
          ['output', { kind: 'wire' }],
        ]),
      })

      yield* Ref.set(state.board, boardFor(false))
      yield* runGameTicks(tickService, stages, 2)
      expect(powerAt(yield* Ref.get(state.power), 'torch')).toBe(MAX_POWER_LEVEL)

      yield* Ref.set(state.board, boardFor(true))
      yield* runGameTicks(tickService, stages, 2)
      expect(powerAt(yield* Ref.get(state.power), 'torch')).toBe(MAX_POWER_LEVEL)
      yield* runGameTicks(tickService, stages, 2)
      expect(powerAt(yield* Ref.get(state.power), 'torch')).toBe(0)
    }).pipe(Effect.provide(FrameServicesLayer)),
  )

  it.effect('keeps a two-torch and repeater clock on a three-redstone-tick period', () =>
    Effect.gen(function* () {
      const state = yield* makeRedstoneFrameState
      const stages = redstoneStages(state)
      const tickService = yield* makeTickService()
      const clockBoard: CircuitBoard = {
        adjacency: new Map([
          ['torch-a', ['torch-b']],
          ['torch-b', ['torch-a', 'repeater']],
          ['repeater', ['torch-b']],
        ]),
        components: new Map<string, Component>([
          ['torch-a', { invertedBy: 'torch-b', kind: 'torch' }],
          ['torch-b', { invertedBy: 'repeater', kind: 'torch' }],
          ['repeater', { delayTicks: 1, inputFrom: 'torch-a', kind: 'repeater' }],
        ]),
      }
      yield* Ref.set(state.board, clockBoard)
      const expectedTorchA = [true, false, false, true, false, false, true, false, false]
      const expectedTorchB = [true, true, false, true, true, false, true, true, false]

      for (let tick = 0; tick < expectedTorchA.length; tick += 1) {
        yield* runGameTicks(tickService, stages, 2)
        const timed = yield* Ref.get(state.timedCircuit)
        expect(timed.torches?.get('torch-a')?.output).toBe(expectedTorchA[tick])
        expect(timed.torches?.get('torch-b')?.output).toBe(expectedTorchB[tick])
      }
    }).pipe(Effect.provide(FrameServicesLayer)),
  )

  it.effect('samples observer state per redstone tick and holds output for one tick', () =>
    Effect.gen(function* () {
      const state = yield* makeRedstoneFrameState
      const stages = redstoneStages(state)
      const tickService = yield* makeTickService()
      const observerBoard = (observedBlock: string): CircuitBoard => ({
        adjacency: new Map([
          ['observer', ['output']],
          ['output', ['observer']],
        ]),
        components: new Map<string, Component>([
          ['observer', { kind: 'observer', observedBlock, outputTo: 'output' }],
          ['output', { kind: 'wire' }],
        ]),
      })
      yield* Ref.set(state.board, observerBoard('stone[lit=false]'))

      yield* runGameTicks(tickService, stages, 2)
      expect(powerAt(yield* Ref.get(state.power), 'output')).toBe(0)

      yield* Ref.set(state.board, observerBoard('stone[lit=true]'))
      yield* runGameTicks(tickService, stages, 2)
      expect(powerAt(yield* Ref.get(state.power), 'output')).toBe(MAX_POWER_LEVEL)

      yield* runGameTicks(tickService, stages, 2)
      expect(powerAt(yield* Ref.get(state.power), 'output')).toBe(0)
    }).pipe(Effect.provide(FrameServicesLayer)),
  )

  it.effect('does not emit an initial piston transition before the first redstone power advance', () =>
    Effect.gen(function* () {
      const state = yield* makeRedstoneFrameState
      const stages = redstoneStages(state)
      const tickService = yield* makeTickService()
      const dimension = Schema.decodeUnknownSync(DimensionIdSchema)('overworld')
      const position = Schema.decodeUnknownSync(BlockPositionSchema)({ x: 0, y: 0, z: 0 })
      yield* syncRedstoneSnapshot(state, {
        dimension,
        components: [{
          kind: 'piston',
          pistonFacing: 'east',
          pistonKind: 'normal',
          pistonState: 'extended',
          position,
        }],
      })

      const firstGameTick = yield* tickService.advanceFrame(DeltaTimeSecs(0.05))
      yield* runStagesForTicks(stages, firstGameTick.ticks)
      expect(yield* Ref.get(state.pendingPistonTransitions)).toStrictEqual([])

      const secondGameTick = yield* tickService.advanceFrame(DeltaTimeSecs(0.05))
      yield* runStagesForTicks(stages, secondGameTick.ticks)
      expect(yield* Ref.get(state.pendingPistonTransitions)).toStrictEqual([{
        dimension,
        facing: 'east',
        kind: 'normal',
        piston: position,
        powered: false,
        state: 'extended',
      }])
    }).pipe(Effect.provide(FrameServicesLayer)),
  )

  it.effect('a decoded false triggered flag does not mask adjacent redstone power', () =>
    Effect.gen(function* () {
      const state = yield* makeRedstoneFrameState
      const stages = redstoneStages(state)
      const tickService = yield* makeTickService()
      const dimension = Schema.decodeUnknownSync(DimensionIdSchema)('overworld')
      const leverPosition = Schema.decodeUnknownSync(BlockPositionSchema)({ x: 0, y: 0, z: 0 })
      const dispenserPosition = Schema.decodeUnknownSync(BlockPositionSchema)({ x: 1, y: 0, z: 0 })
      yield* syncRedstoneSnapshot(state, {
        dimension,
        components: [
          { active: true, kind: 'lever', position: leverPosition },
          {
            facing: 'east',
            kind: 'dispenser',
            position: dispenserPosition,
            triggered: false,
          },
        ],
      })

      yield* runGameTicks(tickService, stages, 2)
      expect(yield* Ref.get(state.pendingTriggerEvents)).toStrictEqual([{
        dimension,
        facing: 'east',
        kind: 'dispenser',
        position: dispenserPosition,
      }])
    }).pipe(Effect.provide(FrameServicesLayer)),
  )
})
