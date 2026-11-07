export type Speed = 0.25 | 0.5 | 1 | 2 | 4

export type UrlState = Readonly<{
  scenario: string
  play: boolean
  speed: Speed
  panel: boolean
  frame: number
}>

const DEFAULT_PLAY = false
const DEFAULT_SPEED: Speed = 1
const DEFAULT_PANEL = true
const DEFAULT_FRAME = 0

export const speedFromValue = (value: string): Speed | undefined => {
  switch (value) {
    case '0.25':
      return 0.25
    case '0.5':
      return 0.5
    case '1':
      return 1
    case '2':
      return 2
    case '4':
      return 4
    default:
      return undefined
  }
}

const speedFromParam = (value: string | null): Speed => {
  if (value === null) {
    return DEFAULT_SPEED
  }
  return speedFromValue(value) ?? DEFAULT_SPEED
}

const flagFromParam = (value: string | null, defaultValue: boolean): boolean => {
  if (value === '0') {
    return false
  }
  if (value === '1') {
    return true
  }
  return defaultValue
}

const frameFromParam = (value: string | null): number => {
  if (value === null || value.length === 0) {
    return DEFAULT_FRAME
  }
  const frame = Number(value)
  if (!Number.isSafeInteger(frame) || frame < DEFAULT_FRAME) {
    return DEFAULT_FRAME
  }
  return frame
}

export const parseUrlState = (search: string, defaultScenario: string): UrlState => {
  const params = new URLSearchParams(search)
  const scenario = params.get('scenario')
  return {
    scenario: scenario === null || scenario.length === 0 ? defaultScenario : scenario,
    play: flagFromParam(params.get('play'), DEFAULT_PLAY),
    speed: speedFromParam(params.get('speed')),
    panel: flagFromParam(params.get('panel'), DEFAULT_PANEL),
    frame: frameFromParam(params.get('frame')),
  }
}

export const serializeUrlState = (state: UrlState): string => {
  const params = new URLSearchParams()
  params.set('scenario', state.scenario)
  params.set('play', state.play ? '1' : '0')
  params.set('speed', String(state.speed))
  params.set('panel', state.panel ? '1' : '0')
  params.set('frame', String(state.frame))
  return `?${params.toString()}`
}
