import type { DebugPanel, PanelFrame } from '../panel-contract.js'
import type { HostFixtureRequest } from '../scenario-registry.js'

const HOST_TITLE = 'Host boundary'

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

const describeRequest = (request: HostFixtureRequest): string => {
  const component = request.component === undefined ? '' : ` ${request.component}`
  return `${request.kind}${component} at ${request.dimension} (${request.position.x}, ${request.position.y}, ${request.position.z})`
}

export const hostPanel: DebugPanel = {
  id: 'host',
  title: HOST_TITLE,
  mount(root) {
    const section = document.createElement('div')
    const heading = document.createElement('h2')
    const details = document.createElement('dl')
    heading.textContent = HOST_TITLE
    section.append(heading, details)

    const scenarioValue = makeField(details, 'Scenario status')
    const scenarioIdValue = makeField(details, 'Scenario ID')
    const snapshotValue = makeField(details, 'Realm blocks to snapshot')
    const applyValue = makeField(details, 'Host apply')
    const requestValue = makeField(details, 'Applied requests')
    const failureValue = makeField(details, 'Host failures')
    const noRequests = document.createElement('span')
    const requestList = document.createElement('ul')
    requestValue.append(noRequests, requestList)
    requestList.hidden = true
    root.append(section)

    let lastScenarioId: string | undefined = undefined
    let lastScenarioFixture: PanelFrame['scenarioFixture'] | undefined = undefined
    let lastHostFixture: PanelFrame['hostFixture'] | undefined = undefined
    let lastHostFixtureFailures: PanelFrame['hostFixtureFailures'] | undefined = undefined
    const requestRows: Array<HTMLLIElement> = []

    const renderRequests = (requests: ReadonlyArray<HostFixtureRequest>): void => {
      if (requests.length !== requestRows.length) {
        while (requestRows.length < requests.length) {
          const row = document.createElement('li')
          requestList.append(row)
          requestRows.push(row)
        }
        while (requestRows.length > requests.length) {
          requestRows.pop()?.remove()
        }
      }

      for (let index = 0; index < requests.length; index += 1) {
        const request = requests[index]
        const row = requestRows[index]
        if (request !== undefined && row !== undefined) {
          setTextIfChanged(row, describeRequest(request))
        }
      }
    }

    const updateHostFixture = (frame: PanelFrame): void => {
      const hostFixture = frame.hostFixture
      if (hostFixture === undefined) {
        setTextIfChanged(snapshotValue, 'Unavailable: PanelFrame.hostFixture has no host snapshot for this frame.')
        setTextIfChanged(applyValue, 'Unavailable: PanelFrame.hostFixture has no host result for this frame.')
        setTextIfChanged(noRequests, 'Unavailable: no host requests are attached to this frame.')
        requestList.hidden = true
        renderRequests([])
        return
      }

      setTextIfChanged(snapshotValue, JSON.stringify(hostFixture.snapshot))
      setTextIfChanged(applyValue, hostFixture.applyReached ? 'Host apply reached.' : 'Host apply was not reached.')
      if (hostFixture.appliedRequests.length === 0) {
        setTextIfChanged(noRequests, 'No host requests were recorded by the fixture.')
        requestList.hidden = true
        renderRequests([])
      } else {
        setTextIfChanged(noRequests, '')
        requestList.hidden = false
        renderRequests(hostFixture.appliedRequests)
      }
    }

    const updateFailures = (failures: PanelFrame['hostFixtureFailures']): void => {
      if ('unavailable' in failures) {
        setTextIfChanged(failureValue, failures.unavailable)
        return
      }
      setTextIfChanged(
        failureValue,
        failures.length === 0 ? 'No host failures recorded.' : JSON.stringify(failures) ?? '[]',
      )
    }

    return {
      update(frame: PanelFrame) {
        let scenarioChanged = false
        if (lastScenarioId !== frame.scenario.id) {
          lastScenarioId = frame.scenario.id
          scenarioChanged = true
          setTextIfChanged(scenarioIdValue, frame.scenario.id)
        }
        if (lastScenarioFixture !== frame.scenarioFixture) {
          lastScenarioFixture = frame.scenarioFixture
          setTextIfChanged(scenarioValue, describeScenarioFixture(frame.scenarioFixture))
        }
        if (scenarioChanged || lastHostFixture !== frame.hostFixture) {
          lastHostFixture = frame.hostFixture
          updateHostFixture(frame)
        }
        if (lastHostFixtureFailures !== frame.hostFixtureFailures) {
          lastHostFixtureFailures = frame.hostFixtureFailures
          updateFailures(frame.hostFixtureFailures)
        }
      },
      dispose() {
        section.remove()
      },
    }
  },
}
