import type { DebugPanel } from '../panel-contract.js'
import { componentsPanel } from './components.js'
import { eventsPanel } from './events.js'
import { hostPanel } from './host.js'
import { powerPanel } from './power.js'
import { timelinePanel } from './timeline.js'

export const PANELS: ReadonlyArray<DebugPanel> = [
  powerPanel,
  timelinePanel,
  componentsPanel,
  eventsPanel,
  hostPanel,
]
