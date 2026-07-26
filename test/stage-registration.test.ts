/**
 * Named regression tests for the frame contract.
 *
 * These encode plan.md §2.3-1 and §2.3-3, both of which are invisible to the
 * type checker and to `pnpm check:deps` because both are violated with STRINGS
 * rather than with imports.
 */
import { describe, expect, it } from '@effect/vitest'
import { Effect, Ref } from 'effect'
import { DeltaTimeSecs, StageId, type StageRegistration } from '../domain/frame-contract'
import { MAX_POWER_LEVEL, powerAt, type CircuitBoard, type Component } from '../domain/power-graph'
import {
  makeRedstoneFrameState,
  makeRedstoneStages,
  MAX_TICKS_PER_FRAME,
  redstoneStages,
  REDSTONE_TICK_SECS,
  ticksForFrame,
} from '../stages/registration'
import {
  EXPERIENCE_MODULE_STAGE_PREFIXES,
  OWN_STAGE_PREFIX,
  REDSTONE_STAGE_IDS,
  UPSTREAM_STAGE_IDS,
} from '../stages/stage-ids'

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
      expect(powerAt(settled, 'w0')).toBe(14)
      expect(yield* Ref.get(state.tickCount)).toBe(1)
    }),
  )

  it.effect('an empty board costs a tick and produces no power, rather than failing', () =>
    Effect.gen(function* () {
      const state = yield* makeRedstoneFrameState
      const power = redstoneStages(state).find((stage) => stage.id === REDSTONE_STAGE_IDS.power)

      yield* power?.run(DeltaTimeSecs(1)) ?? Effect.void
      expect((yield* Ref.get(state.power)).size).toBe(0)
      expect(yield* Ref.get(state.tickCount)).toBe(MAX_TICKS_PER_FRAME)
    }),
  )

  it.effect('every stage tolerates dt = 0', () =>
    Effect.gen(function* () {
      const state = yield* makeRedstoneFrameState
      yield* Ref.set(state.board, leverAndWire)
      yield* Effect.forEach(redstoneStages(state), (stage) => stage.run(DeltaTimeSecs(0)))
      expect((yield* Ref.get(state.power)).size).toBe(0)
    }),
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

describe('the mirrored DeltaTimeSecs brand is kernel’s', () => {
  /*
   * REGRESSION. `domain/frame-contract.ts` restates kernel's `DeltaTimeSecs`
   * (`mc-kernel/domain/quantities.ts:37-42`), and a brand is keyed by its
   * STRING: `Brand.Brand<'DeltaTimeSecs'>` here and in kernel are ONE TYPE to
   * TypeScript, however differently the two constructors validate. So a mirror
   * that refined differently would be a false guarantee the compiler could
   * never contradict — which is exactly what mc-physics had, refining to the
   * frame-loop clamp [0.001, 0.05] while kernel refines to "finite and
   * non-negative". A kernel-built `DeltaTimeSecs(30)` satisfied its parameter
   * types while breaking the invariant its comments claimed.
   *
   * Kernel's is the agreed refinement and it is deliberately LOOSE: a zero
   * delta is legal, because a frame may be scheduled twice inside one clock
   * tick, and the clamp of plan.md §3.4 is a frame-loop concern applied at the
   * boundary by whoever PRODUCES the delta — mc-sim's `frame-timing.ts`,
   * mc-physics' `clampDeltaTime` — never a property of the quantity itself.
   * A stage receives whatever the loop produced and must cope.
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
