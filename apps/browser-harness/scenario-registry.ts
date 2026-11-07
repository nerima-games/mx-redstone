import type { RedstoneWorldSnapshot } from '../../src/application/world-runtime.js'
import type { RedstoneHostBlockType } from '../../src/application/redstone-host-port.js'
import type { ContainerSlot } from '../../src/domain/comparator.js'
import type { PistonFacing } from '../../src/domain/piston.js'
import type { BlockRef } from '../../src/domain/block-ref.js'
import type { ItemType } from '@nerima-games/mc-kernel'
import { circuitScenarios } from './scenarios/regions/circuits.js'
import { effectScenarios } from './scenarios/regions/effects.js'
import { hostStageScenarios } from './scenarios/regions/host-stage.js'
import { sensorScenarios } from './scenarios/regions/sensors.js'

export type FixturePosition = Readonly<{ x: number; y: number; z: number }>

type HostFailureCaseEntry<Value extends string, Label extends string, FailureTag extends string> = Readonly<{
  failureTag: FailureTag
  label: Label
  value: Value
}>

type HostFailureCaseEntryUnion =
  | HostFailureCaseEntry<'mixed-dimensions', 'Mixed dimensions', 'RedstoneHostMixedDimensions'>
  | HostFailureCaseEntry<'realm-missing', 'Missing realm', 'RedstoneHostRealmMissing'>
  | HostFailureCaseEntry<'event-bus-unavailable', 'Event bus unavailable', 'RedstoneHostEventBusUnavailable'>
  | HostFailureCaseEntry<'position-out-of-range', 'Position out of range', 'RedstoneHostPositionOutOfRange'>
  | HostFailureCaseEntry<'hopper-selection-invalid', 'Hopper selection invalid', 'RedstoneHostHopperSelectionInvalid'>
  | HostFailureCaseEntry<'hopper-block-missing', 'Hopper block missing', 'RedstoneHostHopperBlockMissing'>
  | HostFailureCaseEntry<'hopper-transfer-invalid', 'Hopper transfer invalid', 'RedstoneHostHopperTransferInvalid'>
  | HostFailureCaseEntry<'hopper-block-write-mismatch', 'Hopper block write mismatch', 'RedstoneHostHopperBlockWriteMismatch'>

export const HOST_FAILURE_CASES: ReadonlyArray<HostFailureCaseEntryUnion> = [
  { failureTag: 'RedstoneHostMixedDimensions', label: 'Mixed dimensions', value: 'mixed-dimensions' },
  { failureTag: 'RedstoneHostRealmMissing', label: 'Missing realm', value: 'realm-missing' },
  { failureTag: 'RedstoneHostEventBusUnavailable', label: 'Event bus unavailable', value: 'event-bus-unavailable' },
  { failureTag: 'RedstoneHostPositionOutOfRange', label: 'Position out of range', value: 'position-out-of-range' },
  { failureTag: 'RedstoneHostHopperSelectionInvalid', label: 'Hopper selection invalid', value: 'hopper-selection-invalid' },
  { failureTag: 'RedstoneHostHopperBlockMissing', label: 'Hopper block missing', value: 'hopper-block-missing' },
  { failureTag: 'RedstoneHostHopperTransferInvalid', label: 'Hopper transfer invalid', value: 'hopper-transfer-invalid' },
  { failureTag: 'RedstoneHostHopperBlockWriteMismatch', label: 'Hopper block write mismatch', value: 'hopper-block-write-mismatch' },
]

export type HostFailureCase = (typeof HOST_FAILURE_CASES)[number]['value']

export type HostFixtureContainer = Readonly<{
  position: FixturePosition
  kind: 'chest' | 'shulker_box' | 'dispenser' | 'dropper' | 'hopper'
  items: ReadonlyArray<Readonly<{ item: ItemType; count: number }>>
}>

export type HostFixtureHopperContext = Readonly<{
  position: FixturePosition
  powered: boolean
  sourceAbove: Readonly<{
    dimension?: string
    position: FixturePosition
    kind: HostFixtureContainer['kind']
  }> | null
  destinationFacing: Readonly<{
    dimension?: string
    position: FixturePosition
    kind: HostFixtureContainer['kind']
  }> | null
}>

export type ObserverFixtureChange = Readonly<{
  position: FixturePosition
  previous: BlockRef
  current: BlockRef
}>

export type HostFixtureInput = Readonly<{
  dimension: string
  blocks: ReadonlyArray<Readonly<{ block: RedstoneHostBlockType | null; position: FixturePosition }>>
  failureCase?: HostFailureCase
  containers?: ReadonlyArray<HostFixtureContainer>
  hopperContexts?: ReadonlyArray<HostFixtureHopperContext>
  lookups?: Readonly<{
    containerSlots?: ReadonlyArray<ContainerSlot>
    hopperPowered?: boolean
    leverActive?: boolean
    poweredRailPowered?: boolean
    pistonFacing?: PistonFacing
  }>
}>

export type HostFixtureRequest = Readonly<{
  kind: 'lamp' | 'piston' | 'hopper' | 'trigger' | 'powered'
  component?: 'dispenser' | 'dropper' | 'note-block' | 'powered-rail' | 'door' | 'trapdoor'
  dimension: string
  position: FixturePosition
}>

export type BrowserScenarioFixture =
  | Readonly<{
      path: 'host'
      input: HostFixtureInput
      expectedRequests: ReadonlyArray<HostFixtureRequest>
    }>
  | Readonly<{
      path: 'fixture-only' | 'blocked'
      reason: string
      snapshot: RedstoneWorldSnapshot
      observerChange?: ObserverFixtureChange
    }>

export type BrowserScenario = Readonly<{
  id: string
  displayName: string
  fixture: () => BrowserScenarioFixture
}>

export type ScenarioIdProblems = Readonly<{
  duplicates: ReadonlyArray<string>
  missing: ReadonlyArray<string>
  unknown: ReadonlyArray<string>
}>

export const BROWSER_SCENARIO_IDS: ReadonlyArray<string> = [
  'rs.wire.attenuation',
  'rs.torch.inversion-burnout',
  'rs.lever.toggle',
  'rs.button.pulse',
  'rs.repeater.delay-lock',
  'rs.lamp.isolation-transition',
  'rs.comparator.ladder',
  'rs.observer.change-pulse',
  'rs.pressure-plate.occupancy',
  'rs.target.hit-strength',
  'rs.piston.push-refusal',
  'rs.sticky-piston.retract-pull',
  'rs.hopper.lock-transfer',
  'rs.dispenser.rising-edge',
  'rs.dropper.rising-edge',
  'rs.note-block.trigger',
  'rs.powered-rail.transition',
  'rs.door.open-transition',
  'rs.trapdoor.open-transition',
  'rs.world.vertical-strong-power',
  'rs.host.failure-injection',
  'rs.stage.frame-timeline',
  'rs.share.json-roundtrip',
]

export const scenarioIdProblems = (ids: ReadonlyArray<string>): ScenarioIdProblems => {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) {
      duplicates.add(id)
    }
    seen.add(id)
  }
  return {
    duplicates: [...duplicates],
    missing: BROWSER_SCENARIO_IDS.filter((id) => !seen.has(id)),
    unknown: [...seen].filter((id) => !BROWSER_SCENARIO_IDS.includes(id)),
  }
}

export const scenarioRegistry: ReadonlyArray<BrowserScenario> = [
  ...circuitScenarios,
  ...sensorScenarios,
  ...effectScenarios,
  ...hostStageScenarios,
]
