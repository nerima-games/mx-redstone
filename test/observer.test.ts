/**
 * The observer's change detection.
 *
 * Two things are pinned here and neither is about redstone. The first is the
 * arming rule — an observer placed against an existing block must not fire — and
 * the second is that the memory is a VALUE, so that two boards, two worlds or
 * two previews cannot share one.
 *
 * The reference keeps that memory in a module-level `Map`
 * (`redstone-observer-world-effects.ts:34`) with an exported
 * `resetObserverWatchState()` beside it "for tests". plan.md §3.8 records
 * app-scope singletons as the reference's worst bug source and DN-RS-8 makes
 * this repository allocate its frame state per call; a reset function is the
 * same defect with a lid on it.
 */
import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { OBSERVER_PULSE_TICKS, observeChanges, type Sightings } from '../src/domain/observer'

const seen = (entries: ReadonlyArray<readonly [string, string]>): Sightings => new Map(entries)

describe('observer change detection', () => {
  it.effect('REGRESSION: the FIRST sighting arms the detector and fires nothing', () =>
    Effect.sync(() => {
      // Placing an observer against a block that was already there is not a
      // change to that block. An observer that fired on placement would make
      // every chunk load a barrage of pulses — and an observer wired to TNT
      // makes that a barrage of explosions. Same rule, same reason, as
      // `redstone-observer-world-effects.ts:42-43`.
      const sweep = observeChanges(seen([['obs', 'STONE']]), new Map())

      expect(sweep.fired).toStrictEqual([])
      expect(sweep.seen.get('obs')).toBe('STONE')
    }),
  )

  it.effect('an unchanged sighting fires nothing, however many ticks it stays unchanged', () =>
    Effect.sync(() => {
      let memory: Sightings = new Map()
      for (let tick = 0; tick < 20; tick += 1) {
        const sweep = observeChanges(seen([['obs', 'STONE']]), memory)
        expect(sweep.fired).toStrictEqual([])
        memory = sweep.seen
      }
    }),
  )

  it.effect('a changed sighting fires exactly once, on the tick it changed', () =>
    Effect.sync(() => {
      const armed = observeChanges(seen([['obs', 'STONE']]), new Map())
      const changed = observeChanges(seen([['obs', 'DIRT']]), armed.seen)
      const after = observeChanges(seen([['obs', 'DIRT']]), changed.seen)

      expect(changed.fired).toStrictEqual(['obs'])
      // The pulse is not re-armed by its own length: the next tick sees DIRT
      // where it left DIRT.
      expect(after.fired).toStrictEqual([])
    }),
  )

  it.effect('REGRESSION: the memory is a value in and a value out — one sweep cannot arm another observer’s', () =>
    Effect.sync(() => {
      // The module-level `Map` this replaces. Two boards run against the same
      // function; neither sees the other's sightings, so the second board's
      // observer is still un-armed after the first board's observer has fired.
      // With module scratch, `boardB` would inherit `boardA`'s STONE and fire.
      const boardA = observeChanges(seen([['obs', 'STONE']]), new Map())
      const afterA = observeChanges(seen([['obs', 'DIRT']]), boardA.seen)
      expect(afterA.fired).toStrictEqual(['obs'])

      const boardB = observeChanges(seen([['obs', 'DIRT']]), new Map())
      expect(boardB.fired).toStrictEqual([])
    }),
  )

  it.effect('REGRESSION: an observer that is gone is dropped, so a new one at the same cell arms afresh', () =>
    Effect.sync(() => {
      // Two failures in one line. Retained entries leak one per mined observer
      // for the lifetime of the world; worse, a NEW observer placed at that
      // coordinate would inherit a sighting nobody took and fire on its first
      // tick against a block it never saw change.
      const armed = observeChanges(seen([['obs', 'STONE']]), new Map())
      const mined = observeChanges(new Map(), armed.seen)
      expect(mined.seen.size).toBe(0)

      const replaced = observeChanges(seen([['obs', 'DIRT']]), mined.seen)
      expect(replaced.fired).toStrictEqual([])
    }),
  )

  it.effect('two observers watching the same cell arm independently', () =>
    Effect.sync(() => {
      // `Sightings` is keyed by the OBSERVER, not by the watched cell. One
      // placed before a change and one placed after it disagree about whether
      // that change was a change, and both are right.
      const early = observeChanges(seen([['early', 'STONE']]), new Map())
      const both = observeChanges(seen([
        ['early', 'DIRT'],
        ['late', 'DIRT'],
      ]), early.seen)

      expect(both.fired).toStrictEqual(['early'])
    }),
  )

  it.effect('`fired` is sorted, so the order does not depend on how the caller built its Map', () =>
    Effect.sync(() => {
      // `Map` iterates in insertion order, which is a property of the caller's
      // loop rather than of the board. Circuit determinism (docs/testing.md §5)
      // has to survive a caller that iterates its chunks in a different order.
      const previous = seen([
        ['c', 'STONE'],
        ['a', 'STONE'],
        ['b', 'STONE'],
      ])
      const forwards = observeChanges(
        seen([
          ['a', 'DIRT'],
          ['b', 'DIRT'],
          ['c', 'DIRT'],
        ]),
        previous,
      )
      const backwards = observeChanges(
        seen([
          ['c', 'DIRT'],
          ['b', 'DIRT'],
          ['a', 'DIRT'],
        ]),
        previous,
      )

      expect(forwards.fired).toStrictEqual(['a', 'b', 'c'])
      expect(backwards.fired).toStrictEqual(forwards.fired)
    }),
  )

  it.effect('a block replaced and restored between two ticks is ONE change — the divergence is named', () =>
    Effect.sync(() => {
      // NOT A FIX. Sampling compares consecutive ticks, so a block that went
      // STONE -> AIR -> STONE inside one redstone tick is invisible, and vanilla
      // — driven by the block update itself — would see two pulses. Written as a
      // test so that a caller who later feeds this function an event stream
      // instead of a sample makes the change visible rather than silent.
      const armed = observeChanges(seen([['obs', 'STONE']]), new Map())
      const restored = observeChanges(seen([['obs', 'STONE']]), armed.seen)
      expect(restored.fired).toStrictEqual([])
    }),
  )

  it.effect('the pulse length is two redstone ticks, and this file does not count it', () =>
    Effect.sync(() => {
      // The constant is the RULE and lives here; the countdown is remaining
      // time, which is state, and belongs to whoever owns the world.
      //
      // NOT the same answer the button's pulse got, despite what this comment
      // used to claim. The button IS counted here — `'button'` is in
      // `power-timing.ts`'s `TIMED_COMPONENT_KINDS` and `stages/registration.ts`
      // drives its countdown. The observer is NOT: `'observer'` is absent from
      // that list, no stage samples block changes, and
      // `application/redstone-host-port.ts` has no observer builder, so a host
      // cannot even obtain one through the classification path.
      //
      // That asymmetry is deliberate, per design-notes DN-RS-15 §15-3: detecting
      // that a watched block CHANGED needs world reads this package's frame
      // state does not hold, so the host samples and this package only supplies
      // the rule. The consequence to know: the multi-tick hold this constant
      // describes is exercised nowhere in this package's production path, so
      // the number below is a published contract rather than something a test
      // here can observe in motion. A host that reimplements the duration
      // instead of importing this constant is the failure mode to watch for.
      expect(OBSERVER_PULSE_TICKS).toBe(2)
      expect(Object.keys(observeChanges(new Map(), new Map())).sort()).toStrictEqual([
        'fired',
        'seen',
      ])
    }),
  )
})
