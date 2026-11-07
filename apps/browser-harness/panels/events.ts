import type { DebugPanel, PanelFrame } from '../panel-contract.js'

const EVENT_CAUSE_UNAVAILABLE =
  'Unavailable: PanelFrame does not include event-to-input causality links.'
const EVENTS_TITLE = 'Events and transitions'

const setTextIfChanged = (node: HTMLElement, value: string): void => {
  if (node.textContent !== value) {
    node.textContent = value
  }
}

const makeField = (parent: HTMLElement, label: string): HTMLElement => {
  const term = document.createElement('dt')
  const value = document.createElement('dd')
  term.textContent = label
  parent.append(term, value)
  return value
}

const describeScenarioFixture = (fixture: PanelFrame['scenarioFixture']): string => {
  if (fixture.path === 'host') {
    return 'Host fixture path.'
  }
  return fixture.path === 'blocked'
    ? `Blocked: ${fixture.reason}`
    : `Fixture-only: ${fixture.reason}`
}

const pendingPressesChanged = (
  previous: PanelFrame['inputInjection']['pendingButtonPresses'] | undefined,
  current: PanelFrame['inputInjection']['pendingButtonPresses'],
): boolean => {
  if (previous === undefined) {
    return true
  }
  if ('unavailable' in previous) {
    return !('unavailable' in current) || previous.unavailable !== current.unavailable
  }
  if ('unavailable' in current || previous.size !== current.size) {
    return true
  }
  for (const position of previous) {
    if (!current.has(position)) {
      return true
    }
  }
  return false
}

export const eventsPanel: DebugPanel = {
  id: 'events',
  title: EVENTS_TITLE,
  mount(root) {
    const section = document.createElement('div')
    const heading = document.createElement('h2')
    const details = document.createElement('dl')
    heading.textContent = EVENTS_TITLE
    section.append(heading, details)

    const scenarioValue = makeField(details, 'Scenario status')
    const scenarioIdValue = makeField(details, 'Scenario ID')
    const tickValue = makeField(details, 'Current tick')
    const drainValue = makeField(details, 'Event drain')
    const causeValue = makeField(details, 'Event-to-input trace')
    const injectionValue = makeField(details, 'Input injection')
    const pendingInputValue = makeField(details, 'Pending button presses')
    root.append(section)

    setTextIfChanged(scenarioValue, 'Awaiting resolved scenario fixture.')

    let lastScenarioId: string | undefined = undefined
    let lastScenarioFixture: PanelFrame['scenarioFixture'] | undefined = undefined
    let lastTick: PanelFrame['tick'] | undefined = undefined
    let lastDrainedEventBatch: PanelFrame['drainedEventBatch'] | undefined = undefined
    let lastFixtureInput: PanelFrame['inputInjection']['fixtureInput'] | undefined = undefined
    let lastPendingButtonPresses: PanelFrame['inputInjection']['pendingButtonPresses'] | undefined = undefined

    return {
      update(frame: PanelFrame) {
        if (lastScenarioId !== frame.scenario.id) {
          lastScenarioId = frame.scenario.id
          setTextIfChanged(scenarioIdValue, frame.scenario.id)
        }
        if (lastScenarioFixture !== frame.scenarioFixture) {
          lastScenarioFixture = frame.scenarioFixture
          setTextIfChanged(scenarioValue, describeScenarioFixture(frame.scenarioFixture))
        }
        if (lastTick !== frame.tick) {
          lastTick = frame.tick
          setTextIfChanged(tickValue, String(frame.tick))
        }
        if (lastDrainedEventBatch !== frame.drainedEventBatch) {
          lastDrainedEventBatch = frame.drainedEventBatch
          const batch = frame.drainedEventBatch
          setTextIfChanged(drainValue, 'unavailable' in batch ? batch.unavailable : JSON.stringify(batch) ?? '{}')
        }
        setTextIfChanged(causeValue, EVENT_CAUSE_UNAVAILABLE)
        if (lastFixtureInput !== frame.inputInjection.fixtureInput) {
          lastFixtureInput = frame.inputInjection.fixtureInput
          const fixtureInput = frame.inputInjection.fixtureInput
          setTextIfChanged(
            injectionValue,
            'unavailable' in fixtureInput
              ? fixtureInput.unavailable
              : `Mock host input: ${JSON.stringify(fixtureInput) ?? '{}'}`,
          )
        }
        if (pendingPressesChanged(lastPendingButtonPresses, frame.inputInjection.pendingButtonPresses)) {
          lastPendingButtonPresses = frame.inputInjection.pendingButtonPresses
          const pending = frame.inputInjection.pendingButtonPresses
          const pendingValue = 'unavailable' in pending
            ? pending.unavailable
            : JSON.stringify([...pending]) ?? '[]'
          setTextIfChanged(pendingInputValue, pendingValue)
        }
      },
      dispose() {
        section.remove()
      },
    }
  },
}
