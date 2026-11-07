import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import {
  BROWSER_SCENARIO_IDS,
  HOST_FAILURE_CASES,
  scenarioIdProblems,
  scenarioRegistry,
} from '../apps/browser-harness/scenario-registry.js'
import { buildHostFixture } from '../apps/browser-harness/scenarios/host-fixture.js'

const registryIds = scenarioRegistry.map(({ id }) => id)
const HOST_FAILURE_SCENARIO_ID = 'rs.host.failure-injection'

describe('browser scenario registry', () => {
  it('contains the complete stable ID set exactly once', () => {
    // Catches a scenario being removed, renamed, duplicated, or accidentally added.
    expect(scenarioRegistry).toHaveLength(23)
    expect(registryIds).toStrictEqual(BROWSER_SCENARIO_IDS)
    expect(scenarioIdProblems(registryIds)).toStrictEqual({ duplicates: [], missing: [], unknown: [] })
  })

  it('reports a missing stable ID', () => {
    // Catches a validator that overlooks a missing catalog entry.
    expect(scenarioIdProblems(registryIds.filter((id) => id !== 'rs.button.pulse')).missing)
      .toStrictEqual(['rs.button.pulse'])
  })

  it('reports an unknown ID', () => {
    // Catches stale or mistyped IDs entering the shared registry.
    expect(scenarioIdProblems([...registryIds, 'rs.unregistered']).unknown).toStrictEqual(['rs.unregistered'])
  })

  it('includes a negative control for duplicate detection', () => {
    // Catches duplicate scenario IDs that would make URL selection ambiguous.
    expect(scenarioIdProblems([...registryIds, 'rs.wire.attenuation']).duplicates)
      .toStrictEqual(['rs.wire.attenuation'])
  })

  it('builds every scenario fixture deterministically', () => {
    // Catches random positions or time-dependent values that prevent URL replay.
    for (const scenario of scenarioRegistry) {
      expect(scenario.fixture()).toStrictEqual(scenario.fixture())
    }
  })

  it('gives every non-host fixture a visible reason', () => {
    // Catches mock-only scenarios that could be mistaken for real host coverage.
    for (const scenario of scenarioRegistry) {
      const fixture = scenario.fixture()
      if (fixture.path !== 'host') {
        expect(fixture.reason.trim().length).toBeGreaterThan(0)
      }
    }
  })

  it.effect('drives each successful host fixture through ordered host requests', () =>
    Effect.gen(function* verifyHostFixtures() {
      const hostScenarios = scenarioRegistry.flatMap((scenario) => {
        const fixture = scenario.fixture()
        return fixture.path === 'host' && scenario.id !== HOST_FAILURE_SCENARIO_ID
          ? [{ scenario, fixture }]
          : []
      })
      expect(hostScenarios.length).toBeGreaterThan(0)
      // Catches every host scenario silently degrading into an empty apply trace.
      expect(hostScenarios.some(({ fixture }) => fixture.expectedRequests.length > 0)).toBe(true)
      for (const { scenario, fixture } of hostScenarios) {
        const first = yield* Effect.promise(() => buildHostFixture(fixture.input))
        const second = yield* Effect.promise(() => buildHostFixture(fixture.input))
        // Catches skipped host application and reordered or misplaced requests for this scenario.
        expect(first.applyReached, scenario.id).toBe(true)
        expect(first.failures, scenario.id).toStrictEqual([])
        expect(first.appliedRequests, scenario.id).toStrictEqual(fixture.expectedRequests)
        // Catches nondeterministic observations, drained events, or plans from identical input.
        expect(second, scenario.id).toStrictEqual(first)
      }
    }),
  )

  it.effect('records each injected host-port failure from the real apply path', () =>
    Effect.gen(function* verifyHostFailureCases() {
      const scenario = scenarioRegistry.find(({ id }) => id === HOST_FAILURE_SCENARIO_ID)
      expect(scenario).toBeDefined()
      if (scenario === undefined) {
        throw new Error(`Missing browser scenario ${HOST_FAILURE_SCENARIO_ID}`)
      }
      const fixture = scenario.fixture()
      expect(fixture.path).toBe('host')
      if (fixture.path !== 'host') {
        throw new Error(`${HOST_FAILURE_SCENARIO_ID} must use the host fixture path`)
      }

      expect(HOST_FAILURE_CASES.length).toBeGreaterThan(0)
      for (const failureCase of HOST_FAILURE_CASES) {
        const input = { ...fixture.input, failureCase: failureCase.value }
        const first = yield* Effect.promise(() => buildHostFixture(input))
        const second = yield* Effect.promise(() => buildHostFixture(input))

        // Expected failures still prove the host apply call ran; they are not successful request traces.
        expect(first.applyReached, failureCase.value).toBe(true)
        expect(first.failures.map(({ _tag }) => _tag), failureCase.value)
          .toStrictEqual([failureCase.failureTag])
        const drainedCount = first.drainedEventBatch.hopper.length
          + first.drainedEventBatch.lamp.length
          + first.drainedEventBatch.piston.length
          + first.drainedEventBatch.powered.length
          + first.drainedEventBatch.trigger.length
        expect(drainedCount, failureCase.value).toBeGreaterThan(0)
        expect(second, failureCase.value).toStrictEqual(first)
      }
    }),
  )
})
