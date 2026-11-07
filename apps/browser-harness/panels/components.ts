import type { DebugPanel, PanelFrame } from '../panel-contract.js'
import { redstoneNodeId } from '../../../src/application/world-runtime.js'
import type { PositionKey } from '../../../src/domain/position-key.js'

const TITLE = 'Components and decisions'

type ComponentRow = {
  readonly item: HTMLLIElement
  readonly value: HTMLSpanElement
  text: string
  generation: number
}

const setText = (node: HTMLElement, value: string): void => {
  if (node.textContent !== value) {
    node.textContent = value
  }
}

const setHidden = (node: HTMLElement, hidden: boolean): void => {
  if (node.hidden !== hidden) {
    node.hidden = hidden
  }
}

const coordinate = (
  dimension: string,
  position: Readonly<{ x: number; y: number; z: number }>,
): string => `${dimension} (${position.x}, ${position.y}, ${position.z})`

export const componentsPanel: DebugPanel = {
  id: 'components',
  title: TITLE,
  mount(root) {
    const container = document.createElement('div')
    const heading = document.createElement('h2')
    heading.textContent = TITLE
    const fixtureStatus = document.createElement('p')
    fixtureStatus.textContent = 'Awaiting resolved scenario fixture.'
    const inputHeading = document.createElement('h3')
    inputHeading.textContent = 'Input injection'
    const fixtureInputStatus = document.createElement('p')
    fixtureInputStatus.textContent = 'Awaiting fixture input.'
    const buttonPressStatus = document.createElement('p')
    buttonPressStatus.textContent = 'Awaiting pending button presses.'
    const componentHeading = document.createElement('h3')
    componentHeading.textContent = 'Observed component state and timers'
    const blockedObservation = document.createElement('p')
    blockedObservation.textContent = 'Awaiting runtime observation.'
    const components = document.createElement('ul')
    components.setAttribute('aria-label', 'Observed component state and timers')
    components.hidden = true

    const planHeading = document.createElement('h3')
    planHeading.textContent = 'Plan results and rejection reasons'
    const planResults = document.createElement('p')
    planResults.textContent = 'Awaiting plan results.'
    const planRejections = document.createElement('p')
    planRejections.textContent = 'Awaiting plan rejection reasons.'

    const invariantHeading = document.createElement('h3')
    invariantHeading.textContent = 'Invariants'
    const invariantResult = document.createElement('p')
    invariantResult.textContent = 'Awaiting invariant results.'

    const unavailableHeading = document.createElement('h3')
    unavailableHeading.textContent = 'Unavailable component inputs'
    const unavailable = document.createElement('ul')
    unavailable.setAttribute('aria-label', 'Unavailable component inputs')
    const unavailableLabels = [
      'Observer armed state and pulse countdown: blocked because PanelFrame has no observer memory or observer timer field.',
      'Pressure-plate occupant count and capacity: blocked because PanelFrame observations have no entity-count or capacity field.',
      'Target hit coordinates: blocked because PanelFrame observations have no hit-coordinate field.',
      'Hopper transfer period, candidates, and selection: blocked because PanelFrame has no hopper transfer-plan field.',
      'Dispenser and dropper action plans: blocked because PanelFrame has no action-plan or plan-failure field.',
    ]
    for (const label of unavailableLabels) {
      const item = document.createElement('li')
      item.textContent = label
      unavailable.append(item)
    }

    container.append(
      heading,
      fixtureStatus,
      inputHeading,
      fixtureInputStatus,
      buttonPressStatus,
      componentHeading,
      blockedObservation,
      components,
      planHeading,
      planResults,
      planRejections,
      invariantHeading,
      invariantResult,
      unavailableHeading,
      unavailable,
    )
    root.append(container)

    const rows = new Map<PositionKey, ComponentRow>()
    let generation = 0

    const update = (frame: PanelFrame): void => {
      generation += 1
      const fixture = frame.scenarioFixture
      if (fixture.path === 'host') {
        setText(
          fixtureStatus,
          `Scenario fixture: host; ${fixture.input.blocks.length} configured blocks; ${fixture.expectedRequests.length} expected host requests.`,
        )
      } else if (fixture.path === 'blocked') {
        setText(fixtureStatus, `Scenario fixture blocked: ${fixture.reason}`)
      } else {
        setText(fixtureStatus, `Scenario fixture only: ${fixture.reason}`)
      }

      const fixtureInput = frame.inputInjection.fixtureInput
      setText(
        fixtureInputStatus,
        'unavailable' in fixtureInput
          ? `Fixture input unavailable: ${fixtureInput.unavailable}`
          : `Fixture input: ${JSON.stringify(fixtureInput) ?? '{}'}`,
      )
      const pendingButtonPresses = frame.inputInjection.pendingButtonPresses
      if ('unavailable' in pendingButtonPresses) {
        setText(buttonPressStatus, `Pending button presses unavailable: ${pendingButtonPresses.unavailable}`)
      } else {
        const presses = [...pendingButtonPresses]
        setText(
          buttonPressStatus,
          presses.length === 0 ? 'Pending button presses: none.' : `Pending button presses: ${presses.join(', ')}`,
        )
      }

      if ('unavailable' in frame.planResults) {
        setText(planResults, `Plan results unavailable: ${frame.planResults.unavailable}`)
      } else {
        setText(
          planResults,
          frame.planResults.length === 0
            ? 'Plan results: none recorded.'
            : `Plan results: ${JSON.stringify(frame.planResults) ?? '[]'}`,
        )
      }
      if ('unavailable' in frame.planRejectionReasons) {
        setText(planRejections, `Plan rejection reasons unavailable: ${frame.planRejectionReasons.unavailable}`)
      } else {
        const reasons = frame.planRejectionReasons.map(({ event, outcome }) =>
          `${outcome.refusal.reason}: piston at ${coordinate(event.dimension, event.piston)}; blocked at ${coordinate(event.dimension, outcome.refusal.position)}`,
        )
        setText(
          planRejections,
          reasons.length === 0 ? 'Plan rejection reasons: none recorded.' : `Plan rejection reasons: ${reasons.join('; ')}`,
        )
      }
      if ('unavailable' in frame.invariantResults) {
        setText(invariantResult, `Invariant results unavailable: ${frame.invariantResults.unavailable}`)
      } else {
        const results = frame.invariantResults.map(({ id, passed, violations }) => {
          const locations = violations.map(({ dimension, position }) => coordinate(dimension, position))
          const violationText = locations.length === 0 ? '' : ` at ${locations.join(', ')}`
          return `${id}: ${passed ? 'PASS' : 'FAIL'}${violationText}`
        })
        setText(
          invariantResult,
          results.length === 0 ? 'Invariant results: none.' : `Invariant results: ${results.join('; ')}`,
        )
      }

      const observation = frame.observation
      if (observation === undefined) {
        setText(blockedObservation, 'Blocked: PanelFrame.observation is undefined; component state and timers are unavailable.')
        setHidden(blockedObservation, false)
        setHidden(components, true)
        for (const [key, row] of rows) {
          row.item.remove()
          rows.delete(key)
        }
        return
      }

      setHidden(blockedObservation, true)
      setHidden(components, false)
      for (const { dimension, cells } of observation.dimensions) {
        for (const cell of cells) {
          const key = redstoneNodeId(dimension, cell.position)
          const timers = JSON.stringify(cell.dynamicState.timers) ?? '{}'
          const state = JSON.stringify(cell.dynamicState) ?? '{}'
          const text = `${cell.kind} @ ${coordinate(dimension, cell.position)} | power ${cell.power} | timers ${timers} | state ${state}`
          let row = rows.get(key)
          if (row === undefined) {
            const item = document.createElement('li')
            const value = document.createElement('span')
            item.append(value)
            components.append(item)
            row = { item, value, text: '', generation }
            rows.set(key, row)
          }

          row.generation = generation
          if (row.text !== text) {
            setText(row.value, text)
            row.text = text
          }
        }
      }

      for (const [key, row] of rows) {
        if (row.generation !== generation) {
          row.item.remove()
          rows.delete(key)
        }
      }
    }

    return {
      update,
      dispose() {
        container.remove()
        rows.clear()
      },
    }
  },
}
