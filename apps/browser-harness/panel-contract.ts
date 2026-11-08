import type { NonNegativeTickCount } from '@nerima-games/mc-kernel'
import type {
  RedstoneFrameObservation,
  RedstoneInvariantResult,
} from '../../src/application/redstone-observation.js'
import type {
  RedstoneEventBatch,
  RedstoneTickObservation,
} from '../../src/application/world-runtime.js'
import type {
  RedstoneHostEventFailure,
  RedstoneHostHopperFailure,
  RedstoneHostPositionFailure,
} from '../../src/application/redstone-host-port.js'
import type { PistonMovementOutcome } from '../../src/domain/piston.js'
import type { PositionKey } from '../../src/domain/position-key.js'
import type { PowerMap } from '../../src/domain/power-graph.js'
import type { BrowserScenario, BrowserScenarioFixture, HostFixtureInput } from './scenario-registry.js'
import type { HostFixtureResult } from './scenarios/host-fixture.js'

export type PanelUnavailable = Readonly<{ unavailable: string }>
export type PanelHostFixtureFailure =
  | RedstoneHostEventFailure
  | RedstoneHostHopperFailure
  | RedstoneHostPositionFailure

export type PanelPlanResult =
  | Readonly<{ source: 'piston'; outcome: PistonMovementOutcome }>
  | Readonly<{ source: 'hopper'; outcome: HostFixtureResult['hopperTransferResults'][number] }>

export type PanelFrame = Readonly<{
  /** The selected registry entry, including fixture-only or blocked reason. */
  scenario: BrowserScenario
  /** The resolved fixture path and its fixture-only or blocked reason. */
  scenarioFixture: BrowserScenarioFixture
  /** The runtime's current redstone tick. */
  tick: NonNegativeTickCount
  /** The current T01 observation, or undefined when the scenario is blocked. */
  observation: RedstoneFrameObservation | undefined
  /** T03's retained per-tick provenance, timers, power and previous-state records. */
  history: ReadonlyArray<RedstoneTickObservation>
  /** Host apply requests and outcomes for host-path scenarios, if applicable. */
  hostFixture: HostFixtureResult | undefined
  /** Power map captured before the most recently executed stage tick; initially seeded after initialization. */
  previousPower: PowerMap | PanelUnavailable
  /** Host failures reported by the fixture's real host apply call. */
  hostFixtureFailures: ReadonlyArray<PanelHostFixtureFailure> | PanelUnavailable
  /** The most recently drained frame batch, or the batch drained by host apply before the first frame tick. */
  drainedEventBatch: RedstoneEventBatch | PanelUnavailable
  /** Piston and hopper results captured from the host fixture's real calls. */
  planResults: ReadonlyArray<PanelPlanResult> | PanelUnavailable
  /** Event-keyed piston refusal results from the host fixture, if applicable. */
  planRejectionReasons: HostFixtureResult['pistonRefusals'] | PanelUnavailable
  /** Current runtime invariant checks and violating positions. */
  invariantResults: ReadonlyArray<RedstoneInvariantResult> | PanelUnavailable
  /** Selected host fixture input and live pending button presses from the runtime. */
  inputInjection: Readonly<{
    fixtureInput: HostFixtureInput | PanelUnavailable
    pendingButtonPresses: ReadonlySet<PositionKey> | PanelUnavailable
  }>
  /** Redstone stage progress in fixed simulation game ticks. */
  stage: Readonly<{
    consumedTicks: NonNegativeTickCount | PanelUnavailable
    gameTicksPerRedstoneTick: NonNegativeTickCount
  }>
}>

export type DebugPanel = {
  id: string
  title: string
  mount(root: HTMLElement): { update(frame: PanelFrame): void; dispose(): void }
}
