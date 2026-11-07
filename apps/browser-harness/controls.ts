import type { BrowserScenario } from './scenario-registry.js'
import type { Speed, UrlState } from './url-state.js'

export type ControlsCallbacks = Readonly<{
  onScenarioChange(scenario: string): void
  onPause(): void
  onStepFrame(): void
  onPlay(): void
  onSpeedChange(speed: Speed): void
  onPanelChange(panel: boolean): void
  onReset(): void
  onCopyUrl(): void
}>

export type ControlsHandle = Readonly<{
  update(state: UrlState): void
  dispose(): void
}>

const nextSpeed = (speed: Speed): Speed => {
  switch (speed) {
    case 0.25:
      return 0.5
    case 0.5:
      return 1
    case 1:
      return 2
    case 2:
      return 4
    case 4:
      return 0.25
    default:
      return 0.25
  }
}

const makeButton = (name: string): HTMLButtonElement => {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = name
  return button
}

export const mountControls = (
  root: HTMLElement,
  scenarios: ReadonlyArray<BrowserScenario>,
  initialState: UrlState,
  callbacks: ControlsCallbacks,
): ControlsHandle => {
  const scenarioLabel = document.createElement('label')
  scenarioLabel.textContent = 'Scenario'
  const scenarioSelect = document.createElement('select')
  scenarioSelect.setAttribute('aria-label', 'Scenario')
  for (const scenario of scenarios) {
    const option = document.createElement('option')
    option.value = scenario.id
    option.textContent = scenario.displayName
    scenarioSelect.append(option)
  }
  scenarioSelect.addEventListener('change', () => callbacks.onScenarioChange(scenarioSelect.value))
  scenarioLabel.append(scenarioSelect)

  const pauseButton = makeButton('Pause')
  const stepButton = makeButton('Step frame')
  const playButton = makeButton('Play')
  const resetButton = makeButton('Reset')
  const copyButton = makeButton('Copy URL')
  pauseButton.addEventListener('click', callbacks.onPause)
  stepButton.addEventListener('click', () => {
    callbacks.onPause()
    callbacks.onStepFrame()
  })
  playButton.addEventListener('click', callbacks.onPlay)
  resetButton.addEventListener('click', callbacks.onReset)
  copyButton.addEventListener('click', callbacks.onCopyUrl)

  const speedLabel = document.createElement('span')
  speedLabel.textContent = 'Speed '
  const speedButton = makeButton('')
  speedButton.setAttribute('aria-label', 'Speed')
  const speedValue = document.createElement('output')
  speedValue.id = 'current-speed'
  speedButton.setAttribute('aria-describedby', speedValue.id)
  let currentSpeed = initialState.speed
  speedButton.addEventListener('click', () => {
    currentSpeed = nextSpeed(currentSpeed)
    callbacks.onSpeedChange(currentSpeed)
  })
  speedLabel.append(speedButton, speedValue)

  const panelLabel = document.createElement('label')
  const panelToggle = document.createElement('input')
  panelToggle.type = 'checkbox'
  panelToggle.setAttribute('aria-label', 'Show panels')
  panelToggle.addEventListener('change', () => callbacks.onPanelChange(panelToggle.checked))
  panelLabel.append(panelToggle, document.createTextNode('Show panels'))

  root.replaceChildren(
    scenarioLabel,
    pauseButton,
    stepButton,
    playButton,
    speedLabel,
    resetButton,
    panelLabel,
    copyButton,
  )

  const update = (state: UrlState): void => {
    scenarioSelect.value = state.scenario
    currentSpeed = state.speed
    speedButton.textContent = `${String(state.speed)}×`
    speedValue.textContent = `${String(state.speed)}×`
    panelToggle.checked = state.panel
    pauseButton.disabled = !state.play
    playButton.disabled = state.play
  }

  update(initialState)

  return {
    update,
    dispose: () => {
      root.replaceChildren()
    },
  }
}
