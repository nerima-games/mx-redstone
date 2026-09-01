/**
 * Named regression tests for the frame contract.
 *
 * These encode plan.md §2.3-1 and §2.3-3, both of which are invisible to the
 * type checker and to `pnpm check:deps` because both are violated with STRINGS
 * rather than with imports.
 */
import { describe, expect, it } from '@effect/vitest'
import { Effect, Ref } from 'effect'
import {
  RedstoneWorldRuntime,
  RedstoneWorldRuntimeLayer,
} from '../src/application/world-runtime'
import { DeltaTimeSecs, StageId, type GameModule, type StageRegistration } from '@nerima-games/mc-kernel'
import { MAX_POWER_LEVEL, powerAt, type CircuitBoard, type Component } from '../src/domain/power-graph'
import {
  makeRedstoneFrameState,
  makeRuntimeRedstoneStages,
  makeRedstoneStages,
  MAX_TICKS_PER_FRAME,
  redstoneModule,
  redstoneStages,
  REDSTONE_TICK_SECS,
  ticksForFrame,
} from '../src/stages/registration'
import {
  EXPERIENCE_MODULE_STAGE_PREFIXES,
  OWN_STAGE_PREFIX,
  REDSTONE_STAGE_IDS,
  UPSTREAM_STAGE_IDS,
} from '../src/stages/stage-ids'
import { FrameServicesLayer } from './frame-services'

const allAfterEdges = (stages: ReadonlyArray<StageRegistration>): ReadonlyArray<string> =>
  stages.flatMap((stage) => [...(stage.after ?? [])])

const leverAndWire: CircuitBoard = {
  components: new Map<string, Component>([
    ['lever', { kind: 'lever', active: true }],
    ['w0', { kind: 'wire' }],
  ]),
  adjacency: new Map([
    ['lever', ['w0']],
    ['w0', ['lever']],
  ]),
}

/** A lever driving a repeater of `delayTicks`, so the frame test below can watch one delayed transition. */
const leverRepeaterWire = (delayTicks: number): CircuitBoard => ({
  components: new Map<string, Component>([
    ['lever', { kind: 'lever', active: true }],
    ['rear', { kind: 'wire' }],
    ['repeater', { delayTicks, inputFrom: 'rear', kind: 'repeater', outputTo: 'out' }],
    ['out', { kind: 'wire' }],
  ]),
  adjacency: new Map([
    ['lever', ['rear']],
    ['rear', ['lever', 'repeater']],
    ['repeater', ['rear', 'out']],
    ['out', ['repeater']],
  ]),
})

describe('§2.3-1 zero edges between experience modules', () => {
  it.effect(
    'REGRESSION: no `after` edge names another experience module, even though §4.2 puts redstone between gameplay stages',
    () =>
      Effect.gen(function* () {
        const stages = yield* makeRedstoneStages
        const foreign = allAfterEdges(stages).filter((edge) =>
          EXPERIENCE_MODULE_STAGE_PREFIXES.some(
            (prefix) => prefix !== OWN_STAGE_PREFIX && edge.startsWith(prefix),
          ),
        )

        // plan.md §4.2's skeleton reads
        //   … fluids -> redstone -> time/weather …
        // and both of those neighbours are mx-gameplay's stages. Declaring
        // `after: [StageId('gameplay:fluids')]` would satisfy the skeleton and
        // couple redstone's frame position to another experience module's
        // existence. The skeleton is mc-compose's to state (§2.3-3).
        expect(foreign).toStrictEqual([])
      }),
  )

  it.effect('REGRESSION: every declared upstream stage belongs to a foundation repository', () =>
    Effect.sync(() => {
      for (const id of Object.values(UPSTREAM_STAGE_IDS)) {
        const isSibling = EXPERIENCE_MODULE_STAGE_PREFIXES.some(
          (prefix) => prefix !== OWN_STAGE_PREFIX && id.startsWith(prefix),
        )
        expect(isSibling).toBe(false)
      }
    }),
  )
})

describe('§2.3-3 the total order belongs to mc-compose', () => {
  it.effect('REGRESSION: a registration carries constraints and nothing else — no priority, no index', () =>
    Effect.gen(function* () {
      const stages = yield* makeRedstoneStages
      for (const stage of stages) {
        expect(Object.keys(stage).sort()).toStrictEqual(['after', 'id', 'run'])
      }
    }),
  )

  it.effect('the two registered stages split at the purity boundary: power, then effects', () =>
    Effect.gen(function* () {
      const stages = yield* makeRedstoneStages
      const byId = new Map(stages.map((stage) => [stage.id, stage]))

      expect(stages.map((stage) => stage.id)).toStrictEqual([
        REDSTONE_STAGE_IDS.power,
        REDSTONE_STAGE_IDS.effects,
      ])
      expect(byId.get(REDSTONE_STAGE_IDS.power)?.after).toStrictEqual([
        UPSTREAM_STAGE_IDS.simPhysics,
      ])
      expect(byId.get(REDSTONE_STAGE_IDS.effects)?.after).toStrictEqual([REDSTONE_STAGE_IDS.power])
    }),
  )

  it.effect('StageId rejects a blank id', () =>
    Effect.sync(() => {
      expect(() => StageId('  ')).toThrow()
      expect(StageId('redstone:power')).toBe('redstone:power')
    }),
  )
})

describe('fixed-rate redstone ticks', () => {
  it.effect('REGRESSION: the tick remainder is carried across frames, so redstone does not stop dead at 60 fps', () =>
    Effect.sync(() => {
      // One 60 fps frame is 0.167 of a redstone tick. Reset the accumulator each
      // frame — the obvious implementation — and `floor(0.0167 / 0.1)` is zero
      // every single frame: redstone never runs at all. Carrying the remainder
      // is the entire mechanism.
      const FRAMES = 600
      const DT = 1 / 60

      let accumulated = 0
      let executed = 0
      for (let frame = 0; frame < FRAMES; frame += 1) {
        const { ticks, remainderSecs } = ticksForFrame(accumulated, DT)
        executed += ticks
        accumulated = remainderSecs
      }

      const elapsed = FRAMES * DT
      expect(executed).toBeGreaterThan(0)

      // The real invariant: no simulation time is lost. Everything is either
      // executed as a tick or still sitting in the accumulator. (`executed` is
      // 99 rather than 100 here purely because repeated float subtraction
      // leaves the last tick a hair below threshold — the time is not lost, it
      // is in `accumulated`, which is what this assertion pins down.)
      expect(executed * REDSTONE_TICK_SECS + accumulated).toBeCloseTo(elapsed, 6)
      expect(accumulated).toBeLessThan(REDSTONE_TICK_SECS + 1e-9)

      // The naive version, for contrast: reset every frame, run nothing ever.
      let naive = 0
      for (let frame = 0; frame < FRAMES; frame += 1) {
        naive += ticksForFrame(0, DT).ticks
      }
      expect(naive).toBe(0)
    }),
  )

  it.effect('a frame shorter than one tick runs nothing and banks the time', () =>
    Effect.sync(() => {
      const { ticks, remainderSecs } = ticksForFrame(0, 0.016)
      expect(ticks).toBe(0)
      expect(remainderSecs).toBeCloseTo(0.016, 10)
    }),
  )

  it.effect('REGRESSION: a long frame is capped and the excess is DISCARDED, not banked (no spiral of death)', () =>
    Effect.sync(() => {
      const { ticks, remainderSecs } = ticksForFrame(0, 10)
      expect(ticks).toBe(MAX_TICKS_PER_FRAME)
      // Banking the other ~96 ticks' worth of time guarantees the next frame is
      // also over budget, and the one after that.
      expect(remainderSecs).toBe(0)
    }),
  )

  it.effect('dt = 0 runs nothing and loses nothing', () =>
    Effect.sync(() => {
      expect(ticksForFrame(0.05, 0)).toStrictEqual({ ticks: 0, remainderSecs: 0.05 })
    }),
  )

  it.effect('a negative dt is treated as zero rather than rewinding the accumulator', () =>
    Effect.sync(() => {
      expect(ticksForFrame(0.05, -1)).toStrictEqual({ ticks: 0, remainderSecs: 0.05 })
    }),
  )

  it.effect('a zero tick rate runs nothing instead of dividing by zero', () =>
    Effect.sync(() => {
      // `tickSecs` is an override so a preview can slow redstone down to watch a
      // circuit propagate. Sliding it to zero must stall the simulation, not
      // produce `Infinity` ticks.
      expect(ticksForFrame(0.5, 1, { tickSecs: 0 })).toStrictEqual({
        ticks: 0,
        remainderSecs: 0.5,
      })
    }),
  )
})

// Every test below RUNS a stage, so every one provides `FrameServicesLayer` —
// see `./frame-services.ts` for why a layer that is empty today is not a line
// worth deleting.
describe('stage behaviour', () => {
  it.effect('the power stage advances the graph once a full redstone tick has accumulated', () =>
    Effect.gen(function* () {
      const state = yield* makeRedstoneFrameState
      const power = redstoneStages(state).find((stage) => stage.id === REDSTONE_STAGE_IDS.power)
      yield* Ref.set(state.board, leverAndWire)

      // Half a tick: nothing happens yet.
      yield* power?.run(DeltaTimeSecs(REDSTONE_TICK_SECS / 2)) ?? Effect.void
      expect((yield* Ref.get(state.power)).size).toBe(0)
      expect(yield* Ref.get(state.tickCount)).toBe(0)

      // The other half completes it.
      yield* power?.run(DeltaTimeSecs(REDSTONE_TICK_SECS / 2)) ?? Effect.void
      const settled = yield* Ref.get(state.power)
      expect(powerAt(settled, 'lever')).toBe(MAX_POWER_LEVEL)
      expect(powerAt(settled, 'w0')).toBe(MAX_POWER_LEVEL)
      expect(yield* Ref.get(state.tickCount)).toBe(1)
    }).pipe(Effect.provide(FrameServicesLayer)),
  )

  it.effect('an empty board costs a tick and produces no power, rather than failing', () =>
    Effect.gen(function* () {
      const state = yield* makeRedstoneFrameState
      const power = redstoneStages(state).find((stage) => stage.id === REDSTONE_STAGE_IDS.power)

      yield* power?.run(DeltaTimeSecs(1)) ?? Effect.void
      expect((yield* Ref.get(state.power)).size).toBe(0)
      expect(yield* Ref.get(state.tickCount)).toBe(MAX_TICKS_PER_FRAME)
    }).pipe(Effect.provide(FrameServicesLayer)),
  )

  it.effect(
    "REGRESSION: a repeater's delay holds at the exact redstone-tick count, whatever frame rate chops it into",
    () =>
      Effect.gen(function* () {
        // `ticksForFrame` (tested above in isolation) and the delay logic in
        // `domain/power-timing.ts` (tested above against raw tick counts) are
        // each correct on their own; this is the one test that drives them
        // TOGETHER, because a delay that only ever gets ticked at a whole
        // multiple of its own frame size is the classic place this class of
        // bug hides. None of `FRAME_SECS_CASES` divides `REDSTONE_TICK_SECS`
        // evenly, so every case guarantees some frame straddles a tick
        // boundary rather than landing exactly on one.
        const DELAY_TICKS = 3
        const FRAME_SECS_CASES = [1 / 60, 1 / 50, 1 / 33, 1 / 24, 0.037]

        for (const frameSecs of FRAME_SECS_CASES) {
          const state = yield* makeRedstoneFrameState
          const power = redstoneStages(state).find((stage) => stage.id === REDSTONE_STAGE_IDS.power)
          yield* Ref.set(state.board, leverRepeaterWire(DELAY_TICKS))

          // Run one frame at a time and check `out` against `tickCount`
          // itself, not against a frame count — the frame count for a given
          // redstone tick differs case to case, and hard-coding it back in
          // would just re-derive `ticksForFrame` inside the test.
          let sawOutPowered = false
          const MAX_FRAMES = 2000
          for (let frame = 0; frame < MAX_FRAMES && !sawOutPowered; frame += 1) {
            yield* power?.run(DeltaTimeSecs(frameSecs)) ?? Effect.void
            const tickCount = yield* Ref.get(state.tickCount)
            const settled = yield* Ref.get(state.power)
            if (tickCount <= DELAY_TICKS) {
              expect(powerAt(settled, 'out')).toBe(0)
            } else {
              expect(tickCount).toBe(DELAY_TICKS + 1)
              expect(powerAt(settled, 'out')).toBe(MAX_POWER_LEVEL)
              sawOutPowered = true
            }
          }
          expect(sawOutPowered).toBe(true)
        }
      }).pipe(Effect.provide(FrameServicesLayer)),
  )

  it.effect('every stage tolerates dt = 0', () =>
    Effect.gen(function* () {
      const state = yield* makeRedstoneFrameState
      yield* Ref.set(state.board, leverAndWire)
      yield* Effect.forEach(redstoneStages(state), (stage) => stage.run(DeltaTimeSecs(0)))
      expect((yield* Ref.get(state.power)).size).toBe(0)
    }).pipe(Effect.provide(FrameServicesLayer)),
  )

  it.effect('each call to makeRedstoneFrameState yields independent state (re-entrant initialisation)', () =>
    Effect.gen(function* () {
      // plan.md §3.8: app-scope singletons were among the reference's worst bug
      // sources. Two circuit-board previews in one page must not share a board.
      const first = yield* makeRedstoneFrameState
      const second = yield* makeRedstoneFrameState

      yield* Ref.set(first.board, leverAndWire)

      expect((yield* Ref.get(first.board)).components.size).toBe(2)
      expect((yield* Ref.get(second.board)).components.size).toBe(0)
    }),
  )
})

describe('the mc-kernel DeltaTimeSecs brand', () => {
  /*
   * REGRESSION. `DeltaTimeSecs` is imported from `@nerima-games/mc-kernel`, so
   * this package cannot silently diverge from the published quantity contract.
   * The kernel refinement is deliberately LOOSE: a zero delta is legal, while
   * the frame-loop clamp [0.001, 0.05] belongs at the boundary that produces
   * the delta rather than in the quantity itself.
   *
   * A frame may be scheduled twice inside one clock tick, and a stage must cope
   * with whatever the loop produced, including a zero or delayed finite delta.
   */
  it.effect('accepts zero and any finite non-negative delta, and rejects nothing else', () =>
    Effect.sync(() => {
      expect(DeltaTimeSecs(0)).toBe(0)
      expect(DeltaTimeSecs(0.0001)).toBe(0.0001)
      // Out of the integrator's safe range, and still a valid quantity: this is
      // what a tab that was backgrounded for thirty seconds produces.
      expect(DeltaTimeSecs(30)).toBe(30)

      expect(() => DeltaTimeSecs(-0.000_001)).toThrow()
      expect(() => DeltaTimeSecs(Number.NaN)).toThrow()
      expect(() => DeltaTimeSecs(Number.POSITIVE_INFINITY)).toThrow()
    }),
  )
})


describe('the module contract has caught up with this file’s shape', () => {
  const stageIds = (stages: ReadonlyArray<StageRegistration>): ReadonlyArray<string> =>
    stages.map((stage) => stage.id)

  /*
   * REGRESSION — the change the vertical-slice spike forced on mc-kernel.
   *
   * `stages/registration.ts` used to carry a comment saying it was "NOT yet a
   * `GameModule`" because the service set could not be named until mc-sim
   * published. That diagnosis was half wrong, and the wrong half is what the
   * spike found: plan.md §3.12 makes stage registration this repository's only public API — the
   * power graph is internal — so its Layer is empty and always was.
   *
   * The real obstacle was that `GameModule.frameStages` was an ARRAY. These
   * stages are built from `Ref`s allocated in an Effect, so there was no way to
   * put them in a field typed `ReadonlyArray` — and, worse, an array gave NO
   * module anywhere a context in which to acquire a service in order to build a
   * stage, which forced every service any stage touched into `FrameServices`
   * and would have made kernel name mc-sim's and mc-render's services.
   *
   * kernel's `frameStages` is now an Effect. This test is what says the
   * repository actually took the shape, rather than the comment merely changing.
   */
  it.effect('REGRESSION: exports a real GameModule, not "stages alone, the Layer comes later"', () =>
    Effect.gen(function* () {
      const module: GameModule<
        RedstoneWorldRuntime,
        never,
        never,
        never
      > = redstoneModule
      const stages = yield* module.frameStages.pipe(Effect.provide(module.layers))

      expect(stageIds(stages)).toStrictEqual(Object.values(REDSTONE_STAGE_IDS))
    }),
  )

  it.effect('its frameStages IS the registration Effect this file already exported', () =>
    Effect.gen(function* () {
      expect(redstoneModule.frameStages).toBe(makeRuntimeRedstoneStages)
      expect(redstoneModule.layers).toBe(RedstoneWorldRuntimeLayer)

      // ...and it is re-entrant: two builds share no state, which is why it was
      // an Effect in the first place (plan.md §3.8 on app-scope singletons).
      const first = yield* redstoneModule.frameStages.pipe(Effect.provide(redstoneModule.layers))
      const second = yield* redstoneModule.frameStages.pipe(Effect.provide(redstoneModule.layers))
      expect(first).not.toBe(second)
    }),
  )

  it.effect('keeps registration bootable for hosts that have not wired the runtime layer yet', () =>
    Effect.gen(function* () {
      const noRequirement: Effect.Effect<unknown, never, never> = redstoneModule.frameStages
      expect(yield* noRequirement).toBeDefined()
    }),
  )
})
