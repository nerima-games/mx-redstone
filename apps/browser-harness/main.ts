import {
  DeltaTimeSecs,
  EpochMillis,
  FixedClockLayer,
  MonotonicTimeSecs,
  NonNegativeTickCount,
  type StageRegistration,
} from '@nerima-games/mc-kernel'
import { Effect, Ref } from 'effect'
import {
  RedstoneWorldRuntime,
  RedstoneWorldRuntimeLayer,
  redstoneNodeId,
  type RedstoneWorldSnapshot,
  type RedstoneWorldRuntimeService,
  type RedstoneWorldState,
  type RedstoneEventBatch,
  redstoneTickObservationsFor,
  redstoneWorldStateFor,
  setRedstoneObservationEnabled,
} from '../../src/application/world-runtime.js'
import {
  checkRedstoneInvariants,
  observeRedstoneFrame,
  type RedstoneFrameObservation,
} from '../../src/application/redstone-observation.js'
import { OBSERVER_PULSE_TICKS, observeChanges, type Sightings } from '../../src/domain/observer.js'
import type { PositionKey } from '../../src/domain/position-key.js'
import {
  MAX_TICKS_PER_FRAME,
  REDSTONE_TICK_SECS,
  makeRuntimeRedstoneStages,
} from '../../src/stages/registration.js'
import {
  HOST_FAILURE_CASES,
  scenarioRegistry,
  type BrowserScenario,
  type BrowserScenarioFixture,
  type HostFailureCase,
  type HostFixtureInput,
} from './scenario-registry.js'
import { buildHostFixture, type HostFixtureResult } from './scenarios/host-fixture.js'
import { mountBoard } from './board.js'
import { mountControls } from './controls.js'
import { parseUrlState, serializeUrlState, type UrlState } from './url-state.js'
import { advanceTimeline } from './timeline.js'
import { PANELS } from './panels/index.js'
import type { PanelFrame } from './panel-contract.js'

const ZERO_TICK = 0
const TICK_SECONDS = 0.1
const START_MONOTONIC_SECS = 0
const START_WALL_CLOCK_MILLIS = 0

type Simulation = {
  readonly runtime: RedstoneWorldRuntimeService
  readonly state: RedstoneWorldState
  readonly stages: ReadonlyArray<StageRegistration>
  readonly observerCaller: ObserverCallerState | undefined
}

type ObserverCallerState = {
  readonly snapshot: RedstoneWorldSnapshot
  readonly observerKey: PositionKey
  readonly currentBlock: string
  sightings: Sightings
  pulses: Map<PositionKey, number>
}

const app = document.querySelector<HTMLElement>('#app')

if (app === null) {
  throw new Error('Browser harness root element is missing')
}

const defaultScenario = scenarioRegistry[ZERO_TICK]?.id ?? 'rs.wire.attenuation'
let urlState: UrlState = parseUrlState(window.location.search, defaultScenario)
let simulation: Simulation | undefined = undefined
let selectedScenario: BrowserScenario | undefined = undefined
let selectedFixture: BrowserScenarioFixture | undefined = undefined
let selectedHostInput: HostFixtureInput | undefined = undefined
let hostFixtureResult: HostFixtureResult | undefined = undefined
let selectionVersion = ZERO_TICK
let frameRequest: number | undefined = undefined
let lastTimestamp: number | undefined = undefined
let remainderMs = 0
let tickQueue: Promise<void> = Promise.resolve()
const HOST_FIXTURE_FAILURES_UNAVAILABLE: PanelFrame['hostFixtureFailures'] = {
  unavailable: 'No host fixture apply ran for the selected scenario.',
}
const DRAINED_EVENTS_UNAVAILABLE: PanelFrame['drainedEventBatch'] = {
  unavailable: 'No scheduler tick or host apply batch has been drained for the selected scenario.',
}
const PLAN_RESULTS_UNAVAILABLE: PanelFrame['planResults'] = {
  unavailable: 'This fixture has not produced a host plan result.',
}
const PLAN_REJECTIONS_UNAVAILABLE: PanelFrame['planRejectionReasons'] = {
  unavailable: 'This fixture has not produced a host result.',
}
const INVARIANT_RESULTS_UNAVAILABLE: PanelFrame['invariantResults'] = {
  unavailable: 'No runtime exists to check its invariants.',
}
const HOST_INPUT_UNAVAILABLE: PanelFrame['inputInjection']['fixtureInput'] = {
  unavailable: 'This scenario has no host input injection state.',
}
const PENDING_BUTTON_PRESSES_UNAVAILABLE: PanelFrame['inputInjection']['pendingButtonPresses'] = {
  unavailable: 'No runtime exists to observe pending button presses.',
}
let previousPower: PanelFrame['previousPower'] = { unavailable: 'No stage tick has run yet.' }
let consumedTicks: PanelFrame['stage']['consumedTicks'] = { unavailable: 'No stage tick has run yet.' }
let discardedTicks: PanelFrame['stage']['discardedTicks'] = { unavailable: 'No stage frame has run yet.' }
let lastDrainedEventBatch: PanelFrame['drainedEventBatch'] = DRAINED_EVENTS_UNAVAILABLE

const shell = document.createElement('div')
shell.className = 'harness-shell'
const heading = document.createElement('h1')
heading.textContent = 'mx-redstone browser board'
const controlsRoot = document.createElement('section')
controlsRoot.setAttribute('aria-label', 'Board controls')
const status = document.createElement('p')
status.setAttribute('aria-live', 'polite')
const tickLabel = document.createElement('span')
tickLabel.textContent = 'Tick '
const tickCount = document.createElement('output')
tickCount.dataset['testid'] = 'tick-count'
tickCount.textContent = String(urlState.frame)
tickLabel.append(tickCount)
const boardRoot = document.createElement('section')
boardRoot.dataset['testid'] = 'board'
boardRoot.setAttribute('aria-label', 'Redstone board')
const hostDetails = document.createElement('section')
const realmHeading = document.createElement('h2')
realmHeading.textContent = 'Host snapshot and post-apply runtime observation'
const realmOutput = document.createElement('pre')
realmOutput.dataset['testid'] = 'host-realm-state'
const requestsHeading = document.createElement('h2')
requestsHeading.textContent = 'Host requests'
const requestsOutput = document.createElement('pre')
requestsOutput.dataset['testid'] = 'host-requests'
const copyStatus = document.createElement('p')
copyStatus.setAttribute('aria-live', 'polite')
const panelsRoot = document.createElement('section')
panelsRoot.setAttribute('aria-label', 'Diagnostics panels')
const hostFailureControl = document.createElement('label')
hostFailureControl.append(document.createTextNode('Host failure case '))
const hostFailureSelect = document.createElement('select')
hostFailureSelect.setAttribute('aria-label', 'Host failure case')
hostFailureSelect.dataset['testid'] = 'host-failure-case'
for (const failureCase of HOST_FAILURE_CASES) {
  const option = document.createElement('option')
  option.value = failureCase.value
  option.textContent = failureCase.label
  hostFailureSelect.append(option)
}
hostFailureControl.append(hostFailureSelect)
hostFailureControl.hidden = true
panelsRoot.append(hostFailureControl)

hostDetails.append(realmHeading, realmOutput, requestsHeading, requestsOutput)
shell.append(heading, controlsRoot, status, tickLabel, boardRoot, copyStatus, hostDetails, panelsRoot)
app.replaceChildren(shell)

const panelViews: Array<{ update(frame: PanelFrame): void; dispose(): void }> = []
for (const panel of PANELS) {
  const panelRoot = document.createElement('section')
  panelRoot.dataset['panelId'] = panel.id
  panelRoot.setAttribute('aria-label', panel.title)
  panelsRoot.append(panelRoot)
  const view = panel.mount(panelRoot)
  panelViews.push(view)
}

const syncUrl = (): void => {
  const query = serializeUrlState(urlState)
  window.history.replaceState(null, '', `${window.location.pathname}${query}${window.location.hash}`)
}

const cancelFrameRequest = (): void => {
  if (frameRequest !== undefined) {
    window.cancelAnimationFrame(frameRequest)
    frameRequest = undefined
  }
}

const copyCurrentUrl = async (): Promise<void> => {
  copyStatus.textContent = ''
  try {
    await navigator.clipboard.writeText(window.location.href)
    copyStatus.textContent = 'URL copied'
  } catch {
    copyStatus.textContent = 'Could not copy URL'
  }
}

const refreshControls = (writeUrl: boolean): void => {
  controls.update(urlState)
  tickCount.textContent = String(urlState.frame)
  panelsRoot.hidden = !urlState.panel
  if (writeUrl) {
    syncUrl()
  }
}

const board = mountBoard(boardRoot, () => {
  handleTask(toggleLever(), 'Could not toggle the host lever')
})

const controls = mountControls(controlsRoot, scenarioRegistry, urlState, {
  onScenarioChange: (scenario) => {
    handleTask(loadScenario(scenario, ZERO_TICK, { pause: true }), 'Could not load selected scenario')
  },
  onPause: () => {
    cancelFrameRequest()
    lastTimestamp = undefined
    remainderMs = 0
    urlState = { ...urlState, play: false }
    refreshControls(true)
  },
  onStepFrame: () => {
    lastTimestamp = undefined
    remainderMs = 0
    urlState = { ...urlState, play: false }
    refreshControls(true)
    handleTask(enqueueTicks(1), 'Could not step the redstone runtime')
  },
  onPlay: () => {
    urlState = { ...urlState, play: true }
    refreshControls(true)
    ensureFrameRequest()
  },
  onSpeedChange: (speed) => {
    urlState = { ...urlState, speed }
    refreshControls(true)
  },
  onPanelChange: (panel) => {
    urlState = { ...urlState, panel }
    refreshControls(true)
  },
  onReset: () => {
    handleTask(loadScenario(urlState.scenario, ZERO_TICK, { pause: true }), 'Could not reset the scenario')
  },
  onCopyUrl: () => {
    handleTask(copyCurrentUrl(), 'Could not copy the URL')
  },
})

panelsRoot.hidden = !urlState.panel

const observerCallerFor = (fixture: BrowserScenarioFixture): ObserverCallerState | undefined => {
  if (fixture.path === 'host') {
    return undefined
  }
  const observerChange = fixture.observerChange
  if (observerChange === undefined) {
    return undefined
  }
  const observer = fixture.snapshot.components.find((component) =>
    component.kind === 'observer'
    && component.position.x === observerChange.position.x
    && component.position.y === observerChange.position.y
    && component.position.z === observerChange.position.z,
  )
  if (observer === undefined) {
    throw new Error('Observer fixture change does not identify an observer component.')
  }
  const observerKey = redstoneNodeId(fixture.snapshot.dimension, observer.position)
  return {
    currentBlock: observerChange.current,
    observerKey,
    pulses: new Map(),
    sightings: new Map([[observerKey, observerChange.previous]]),
    snapshot: fixture.snapshot,
  }
}

const advanceObserverCaller = async (
  activeSimulation: Simulation,
  caller: ObserverCallerState | undefined,
): Promise<void> => {
  if (caller === undefined) {
    return
  }
  const current: Sightings = new Map([[caller.observerKey, caller.currentBlock]])
  const sweep = observeChanges(current, caller.sightings)
  caller.sightings = sweep.seen

  const pulses = new Map<PositionKey, number>()
  for (const [key, remaining] of caller.pulses) {
    if (current.has(key) && remaining > 1) {
      pulses.set(key, remaining - 1)
    }
  }
  for (const key of sweep.fired) {
    pulses.set(key, OBSERVER_PULSE_TICKS)
  }
  caller.pulses = pulses

  const pulseTicks = NonNegativeTickCount(pulses.get(caller.observerKey) ?? ZERO_TICK)
  const active = pulseTicks > ZERO_TICK
  const dimensions = await Effect.runPromise(Ref.get(activeSimulation.state.dimensions))
  const dimension = dimensions.get(caller.snapshot.dimension)
  if (dimension === undefined) {
    throw new Error('Observer fixture dimension is unavailable in the runtime snapshot.')
  }
  const snapshotComponent = dimension.get(caller.observerKey)
  if (snapshotComponent === undefined) {
    throw new Error('Observer fixture component is unavailable in the runtime snapshot.')
  }
  const runtimeBoard = await Effect.runPromise(Ref.get(activeSimulation.state.board))
  const boardComponent = runtimeBoard.components.get(caller.observerKey)
  if (boardComponent === undefined) {
    throw new Error('Observer fixture component is unavailable in the runtime board.')
  }
  const updatedDimension = new Map(dimension)
  updatedDimension.set(caller.observerKey, { ...snapshotComponent, active, pulseTicks })
  const updatedDimensions = new Map(dimensions)
  updatedDimensions.set(caller.snapshot.dimension, updatedDimension)
  await Effect.runPromise(Ref.set(activeSimulation.state.dimensions, updatedDimensions))

  const updatedComponents = new Map(runtimeBoard.components)
  updatedComponents.set(caller.observerKey, { ...boardComponent, active, pulseTicks })
  await Effect.runPromise(Ref.set(activeSimulation.state.board, { ...runtimeBoard, components: updatedComponents }))
}

const drainFrameEvents = (runtime: RedstoneWorldRuntimeService): Promise<RedstoneEventBatch> =>
  Effect.runPromise(Effect.all({
    hopper: runtime.drainHopperTransferEvents,
    lamp: runtime.drainLampTransitions,
    piston: runtime.drainPistonTransitions,
    powered: runtime.drainPoweredComponentTransitions,
    trigger: runtime.drainTriggerEvents,
  }, { concurrency: 1 }))

const initialiseSimulation = async (
  snapshot: RedstoneWorldSnapshot,
  fixture: BrowserScenarioFixture,
): Promise<Simulation> => {
  const observerCaller = observerCallerFor(fixture)
  const program = Effect.gen(function* initialiseSimulationGenerator() {
    const runtime = yield* RedstoneWorldRuntime
    const stages = yield* makeRuntimeRedstoneStages
    const state = yield* redstoneWorldStateFor(runtime)
    yield* runtime.syncSnapshot(snapshot)
    for (const component of snapshot.components) {
      if (component.kind === 'button' && component.active === true) {
        yield* runtime.pressButton(snapshot.dimension, component.position)
      }
    }
    yield* setRedstoneObservationEnabled(runtime, true)
    return { observerCaller, runtime, stages, state }
  }).pipe(Effect.provide(RedstoneWorldRuntimeLayer))
  return Effect.runPromise(program)
}

const runStageFrame = async (activeSimulation: Simulation): Promise<void> => {
  const tickBefore = await Effect.runPromise(Ref.get(activeSimulation.state.tickCount))
  const powerBefore = await Effect.runPromise(Ref.get(activeSimulation.state.power))
  const accumulatorBefore = await Effect.runPromise(Ref.get(activeSimulation.state.tickAccumulatorSecs))
  previousPower = new Map(powerBefore)
  await advanceObserverCaller(activeSimulation, activeSimulation.observerCaller)
  const clock = FixedClockLayer({
    monotonicSecs: MonotonicTimeSecs(START_MONOTONIC_SECS),
    wallClockEpochMillis: EpochMillis(START_WALL_CLOCK_MILLIS),
  })
  await activeSimulation.stages.reduce(
    (pending, stage) => pending.then(() =>
      Effect.runPromise(stage.run(DeltaTimeSecs(TICK_SECONDS)).pipe(Effect.provide(clock))),
    ),
    Promise.resolve(),
  )
  const tickAfter = await Effect.runPromise(Ref.get(activeSimulation.state.tickCount))
  const ticksConsumed = NonNegativeTickCount(tickAfter - tickBefore)
  consumedTicks = ticksConsumed
  const accumulatorAfter = await Effect.runPromise(Ref.get(activeSimulation.state.tickAccumulatorSecs))
  const availableSecs = accumulatorBefore + TICK_SECONDS
  const accountedSecs = ticksConsumed * REDSTONE_TICK_SECS + accumulatorAfter
  const discardedSecs = Math.max(ZERO_TICK, availableSecs - accountedSecs)
  discardedTicks = NonNegativeTickCount(Math.floor(discardedSecs / REDSTONE_TICK_SECS))
  const batch = await drainFrameEvents(activeSimulation.runtime)
  if (simulation === activeSimulation) {
    lastDrainedEventBatch = batch
  }
}

const setStatus = (message: string, kind?: 'mock' | 'blocked' | 'error'): void => {
  status.textContent = message
  status.dataset['state'] = kind ?? 'ready'
}

const showHostFixture = (result: HostFixtureResult | undefined): void => {
  if (result === undefined) {
    realmOutput.textContent = ''
    requestsOutput.textContent = ''
    return
  }
  realmOutput.textContent = JSON.stringify({
    applyReached: result.applyReached,
    realmSnapshot: result.snapshot,
    runtimeObservationAfterApply: result.observation,
  })
  requestsOutput.textContent = JSON.stringify(result.appliedRequests)
}

const panelFrame = async (): Promise<PanelFrame | undefined> => {
  if (selectedScenario === undefined || selectedFixture === undefined) {
    return undefined
  }
  const observation: RedstoneFrameObservation | undefined = simulation === undefined
    ? undefined
    : await Effect.runPromise(observeRedstoneFrame(simulation.runtime))
  const history = simulation === undefined
    ? []
    : await Effect.runPromise(redstoneTickObservationsFor(simulation.runtime))
  const tickAccumulatorSecs = simulation === undefined
    ? { unavailable: 'No runtime exists to expose its tick accumulator.' }
    : await Effect.runPromise(Ref.get(simulation.state.tickAccumulatorSecs))
  const pendingButtonPresses = observation?.pendingButtonPresses ?? PENDING_BUTTON_PRESSES_UNAVAILABLE
  const drainedEventBatch = 'unavailable' in lastDrainedEventBatch
    ? hostFixtureResult?.drainedEventBatch ?? lastDrainedEventBatch
    : lastDrainedEventBatch
  const hostFailures = hostFixtureResult?.failures ?? HOST_FIXTURE_FAILURES_UNAVAILABLE
  const planResults: PanelFrame['planResults'] = hostFixtureResult === undefined
    ? PLAN_RESULTS_UNAVAILABLE
    : [
      ...hostFixtureResult.pistonPlanResults.map((outcome) => ({ source: 'piston', outcome } as const)),
      ...hostFixtureResult.hopperTransferResults.map((outcome) => ({ source: 'hopper', outcome } as const)),
    ]
  const planRejectionReasons: PanelFrame['planRejectionReasons'] = hostFixtureResult?.pistonRefusals
    ?? PLAN_REJECTIONS_UNAVAILABLE
  const invariantResults: PanelFrame['invariantResults'] = simulation === undefined
    ? INVARIANT_RESULTS_UNAVAILABLE
    : await Effect.runPromise(checkRedstoneInvariants(simulation.runtime))
  return {
    drainedEventBatch,
    history,
    hostFixtureFailures: hostFailures,
    hostFixture: hostFixtureResult,
    inputInjection: {
      fixtureInput: selectedHostInput ?? HOST_INPUT_UNAVAILABLE,
      pendingButtonPresses,
    },
    invariantResults,
    observation,
    planRejectionReasons,
    planResults,
    previousPower,
    scenario: selectedScenario,
    scenarioFixture: selectedFixture,
    stage: {
      consumedTicks,
      maxTicksPerFrame: MAX_TICKS_PER_FRAME,
      tickAccumulatorSecs,
      tickDurationSecs: REDSTONE_TICK_SECS,
      discardedTicks,
    },
    tick: observation?.tick ?? NonNegativeTickCount(ZERO_TICK),
  }
}

const publishFrame = async (): Promise<void> => {
  const frame = await panelFrame()
  if (frame === undefined) {
    return
  }
  board.update(frame)
  for (const panel of panelViews) {
    panel.update(frame)
  }
}

const renderScenarioState = (): void => {
  if (selectedScenario === undefined || selectedFixture === undefined) {
    return
  }
  if (selectedFixture.path === 'blocked') {
    setStatus(`BLOCKED: ${selectedFixture.reason}`, 'blocked')
    return
  }
  if (selectedFixture.path === 'fixture-only') {
    setStatus(`MOCK: ${selectedFixture.reason}`, 'mock')
    return
  }
  setStatus('Host fixture uses a mock realm; the runtime observation and requests below come from the host apply path.', 'mock')
}

const publishTick = async (writeUrl: boolean): Promise<void> => {
  if (simulation === undefined) {
    return
  }
  urlState = { ...urlState, frame: urlState.frame + 1 }
  refreshControls(writeUrl)
  await publishFrame()
}

const runOneTick = async (writeUrl: boolean): Promise<void> => {
  const activeSimulation = simulation
  if (activeSimulation === undefined) {
    return
  }
  await runStageFrame(activeSimulation)
  if (simulation !== activeSimulation) {
    return
  }
  await publishTick(writeUrl)
}

const runTicksSequentially = (
  count: number,
  writeUrl: boolean,
  version: number,
  completed: number = ZERO_TICK,
): Promise<void> => {
  if (completed >= count || selectionVersion !== version) {
    return Promise.resolve()
  }
  return runOneTick(writeUrl).then(() =>
    runTicksSequentially(count, writeUrl, version, completed + 1),
  )
}

const enqueueTicks = (count: number): Promise<void> => {
  const requested = Math.max(ZERO_TICK, Math.trunc(count))
  const version = selectionVersion
  tickQueue = tickQueue.then(() => runTicksSequentially(requested, true, version)).catch((error: unknown) => {
    if (selectionVersion === version) {
      showScenarioError(`Could not advance the redstone runtime: ${String(error)}`)
    }
  })
  return tickQueue
}

const showScenarioError = (message: string): void => {
  setStatus(`ERROR: ${message}`, 'error')
  const alert = document.createElement('p')
  alert.setAttribute('role', 'alert')
  alert.textContent = message
  status.after(alert)
}

const handleTask = (task: Promise<void>, failureMessage: string): void => {
  task.catch((error: unknown) => {
    showScenarioError(`${failureMessage}: ${String(error)}`)
  })
}

const loadScenario = async (
  scenarioId: string,
  requestedFrame: number,
  options: { readonly pause: boolean; readonly hostInput?: HostFixtureInput } = { pause: true },
): Promise<void> => {
  const version = selectionVersion + 1
  selectionVersion = version
  lastTimestamp = undefined
  remainderMs = 0
  previousPower = { unavailable: 'No stage tick has run for the selected scenario.' }
  consumedTicks = { unavailable: 'No stage tick has run for the selected scenario.' }
  discardedTicks = { unavailable: 'No stage frame has run for the selected scenario.' }
  lastDrainedEventBatch = DRAINED_EVENTS_UNAVAILABLE
  if (options.pause && frameRequest !== undefined) {
    cancelFrameRequest()
  }
  simulation = undefined
  const scenario = scenarioRegistry.find((scenarioEntry) => scenarioEntry.id === scenarioId)
  selectedScenario = scenario
  hostFailureControl.hidden = scenario?.id !== 'rs.host.failure-injection'
  selectedFixture = undefined
  selectedHostInput = undefined
  hostFixtureResult = undefined
  for (const oldAlert of status.parentElement?.querySelectorAll('[role="alert"]') ?? []) {
    oldAlert.remove()
  }
  urlState = {
    ...urlState,
    frame: ZERO_TICK,
    play: options.pause ? false : urlState.play,
    scenario: scenarioId,
  }
  refreshControls(false)
  showHostFixture(undefined)

  if (scenario === undefined) {
    urlState = { ...urlState, frame: requestedFrame }
    setStatus(`Scenario not found: ${scenarioId}`, 'error')
    const alert = document.createElement('p')
    alert.setAttribute('role', 'alert')
    alert.textContent = `Scenario not found: ${scenarioId}`
    status.after(alert)
    refreshControls(true)
    return
  }

  const fixture = scenario.fixture()
  selectedFixture = fixture
  renderScenarioState()
  if (fixture.path === 'blocked') {
    urlState = { ...urlState, frame: requestedFrame }
    refreshControls(true)
    await publishFrame()
    return
  }

  let snapshot = fixture.path === 'host' ? undefined : fixture.snapshot
  if (fixture.path === 'host') {
    const input = options.hostInput ?? fixture.input
    selectedHostInput = input
    hostFailureSelect.value = input.failureCase ?? HOST_FAILURE_CASES[ZERO_TICK]?.value ?? ''
    try {
      hostFixtureResult = await buildHostFixture(input)
    } catch (error) {
      if (selectionVersion !== version) {
        return
      }
      showScenarioError(`Host fixture failed: ${String(error)}`)
      await publishFrame()
      return
    }
    if (selectionVersion !== version) {
      return
    }
    snapshot = hostFixtureResult.snapshot
    showHostFixture(hostFixtureResult)
  }

  if (snapshot === undefined) {
    showScenarioError('Scenario fixture did not provide a runtime snapshot.')
    return
  }

  try {
    simulation = await initialiseSimulation(snapshot, fixture)
  } catch (error) {
    if (selectionVersion !== version) {
      return
    }
    showScenarioError(`Could not initialise scenario: ${String(error)}`)
    return
  }
  if (selectionVersion !== version) {
    return
  }
  if (simulation === undefined) {
    return
  }
  previousPower = new Map(await Effect.runPromise(Ref.get(simulation.state.power)))
  try {
    await publishFrame()
    await runTicksSequentially(requestedFrame, false, version)
    if (selectionVersion !== version) {
      return
    }
  } catch (error) {
    showScenarioError(`Could not replay scenario frame: ${String(error)}`)
    return
  }
  urlState = { ...urlState, frame: requestedFrame }
  refreshControls(true)
  if (urlState.play) {
    ensureFrameRequest()
  }
}

hostFailureSelect.addEventListener('change', () => {
  if (selectedScenario?.id !== 'rs.host.failure-injection' || selectedFixture?.path !== 'host') {
    return
  }
  const selectedFailureCase: HostFailureCase | undefined = HOST_FAILURE_CASES.find(
    ({ value }) => value === hostFailureSelect.value,
  )?.value
  if (selectedFailureCase === undefined) {
    return
  }
  const baseInput = selectedHostInput ?? selectedFixture.input
  handleTask(
    loadScenario(selectedScenario.id, ZERO_TICK, {
      hostInput: { ...baseInput, failureCase: selectedFailureCase },
      pause: true,
    }),
    'Could not run selected host failure case',
  )
})

const toggleLever = async (): Promise<void> => {
  if (selectedHostInput === undefined) {
    setStatus('Lever input is unavailable for this fixture.', 'blocked')
    return
  }
  const lookups = selectedHostInput.lookups
  const currentLeverActive = lookups?.leverActive ?? true
  const nextInput: HostFixtureInput = {
    ...selectedHostInput,
    lookups: { ...lookups, leverActive: !currentLeverActive },
  }
  await loadScenario(urlState.scenario, ZERO_TICK, { pause: true, hostInput: nextInput })
}

const onAnimationFrame = async (timestamp: number): Promise<void> => {
  frameRequest = undefined
  if (!urlState.play || simulation === undefined) {
    lastTimestamp = undefined
    remainderMs = 0
    return
  }
  const elapsedMs = lastTimestamp === undefined ? 0 : timestamp - lastTimestamp
  lastTimestamp = timestamp
  const advance = advanceTimeline(remainderMs, elapsedMs, urlState.speed)
  remainderMs = advance.remainderMs
  await enqueuePlaybackTicks(advance.ticks)
  ensureFrameRequest()
}

const enqueuePlaybackTicks = (count: number, completed: number = ZERO_TICK): Promise<void> => {
  if (completed >= count || !urlState.play) {
    return Promise.resolve()
  }
  return enqueueTicks(1).then(() => enqueuePlaybackTicks(count, completed + 1))
}

const ensureFrameRequest = (): void => {
  if (urlState.play && simulation !== undefined && frameRequest === undefined) {
    frameRequest = window.requestAnimationFrame((timestamp) => {
      handleTask(onAnimationFrame(timestamp), 'Could not advance the redstone timeline')
    })
  }
}

const dispose = (): void => {
  if (frameRequest !== undefined) {
    window.cancelAnimationFrame(frameRequest)
  }
  board.dispose()
  controls.dispose()
  for (const panel of panelViews) {
    panel.dispose()
  }
}

window.addEventListener('pagehide', dispose, { once: true })
handleTask(loadScenario(urlState.scenario, urlState.frame, { pause: false }), 'Could not load the initial scenario')
