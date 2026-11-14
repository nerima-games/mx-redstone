import { BlockPositionSchema, DimensionIdSchema } from '@nerima-games/mc-kernel'
import { Schema } from 'effect'
import type {
  RedstoneComponentSnapshot,
  RedstoneWorldSnapshot,
} from '../../../../src/application/world-runtime.js'
import type { BrowserScenario } from '../../scenario-registry.js'

const OVERWORLD = Schema.decodeUnknownSync(DimensionIdSchema)('overworld')

const position = (x: number, y = 0, z = 0) =>
  Schema.decodeUnknownSync(BlockPositionSchema)({ x, y, z })

const observerPosition = { x: 0, y: 0, z: 0 }
const observerBlockBeforeChange = 'stone'
const observerBlockAfterChange = 'dirt'

const snapshot = (components: ReadonlyArray<RedstoneComponentSnapshot>): RedstoneWorldSnapshot => ({
  components,
  dimension: OVERWORLD,
})

export const sensorScenarios: ReadonlyArray<BrowserScenario> = [
  {
    id: 'rs.observer.change-pulse',
    displayName: 'Observer change detection and pulse',
    fixture: () => ({
      path: 'fixture-only',
      reason: 'The first runtime sample records stone; the fixture changes that cell to dirt before the next redstone-tick sample.',
      observerChange: {
        current: observerBlockAfterChange,
        position: observerPosition,
        previous: observerBlockBeforeChange,
      },
      snapshot: snapshot([
        { active: false, kind: 'observer', observedBlock: observerBlockBeforeChange, position: position(0) },
        { active: false, kind: 'observer', position: position(2) },
      ]),
    }),
  },
  {
    id: 'rs.pressure-plate.occupancy',
    displayName: 'Pressure-plate occupancy signals',
    fixture: () => ({
      path: 'fixture-only',
      reason: 'There is no raw-host plate builder or entity query; the snapshot carries fixed signal levels, while occupant counts and 15/150 capacities are mock inputs rather than host-derived state.',
      snapshot: snapshot([
        { active: true, emits: 15, kind: 'pressure-plate', position: position(0) },
        { active: true, emits: 1, kind: 'pressure-plate', position: position(2) },
        { active: true, emits: 15, kind: 'pressure-plate', position: position(4) },
      ]),
    }),
  },
  {
    id: 'rs.target.hit-strength',
    displayName: 'Target hit strength',
    fixture: () => ({
      path: 'fixture-only',
      reason: 'There is no raw-host target builder or hit-coordinate input; this snapshot seeds miss, edge, and bullseye signal levels without deriving face coordinates.',
      snapshot: snapshot([
        { active: false, emits: 0, kind: 'target', position: position(0) },
        { active: true, emits: 1, kind: 'target', position: position(2) },
        { active: true, emits: 15, kind: 'target', position: position(4) },
      ]),
    }),
  },
]
