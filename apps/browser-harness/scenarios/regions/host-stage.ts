import { BlockPositionSchema, DimensionIdSchema } from '@nerima-games/mc-kernel'
import { Schema } from 'effect'
import type {
  RedstoneComponentSnapshot,
  RedstoneWorldSnapshot,
} from '../../../../src/application/world-runtime.js'
import type { BrowserScenario, HostFixtureInput } from '../../scenario-registry.js'

const dimension = Schema.decodeUnknownSync(DimensionIdSchema)('overworld')

const position = (
  x: number,
  y: number,
  z: number,
): RedstoneComponentSnapshot['position'] => Schema.decodeUnknownSync(BlockPositionSchema)({ x, y, z })

const snapshot = (components: ReadonlyArray<RedstoneComponentSnapshot>): RedstoneWorldSnapshot => ({
  components,
  dimension,
})

const fixtureOnlyScenario = (
  id: string,
  displayName: string,
  path: 'fixture-only' | 'blocked',
  reason: string,
  components: ReadonlyArray<RedstoneComponentSnapshot>,
): BrowserScenario => ({
  displayName,
  fixture: () => ({ path, reason, snapshot: snapshot(components) }),
  id,
})

const hostPosition = (x: number, y: number, z: number): HostFixtureInput['blocks'][number]['position'] => ({ x, y, z })

const hostBlock = (
  block: HostFixtureInput['blocks'][number]['block'],
  x: number,
  y: number,
  z: number,
): HostFixtureInput['blocks'][number] => ({ block, position: hostPosition(x, y, z) })

export const hostStageScenarios: ReadonlyArray<BrowserScenario> = [
  fixtureOnlyScenario(
    'rs.world.vertical-strong-power',
    'Six-face vertical wire paths',
    'blocked',
    'The snapshot can show vertical wire adjacency, but it cannot represent solid cells needed to model strong power through a block.',
    [
      { active: true, kind: 'lever', position: position(0, 0, 0) },
      { kind: 'wire', position: position(1, 0, 0) },
      { kind: 'wire', position: position(2, 0, 0) },
      { kind: 'wire', position: position(0, 1, 0) },
      { kind: 'wire', position: position(0, 2, 0) },
      { kind: 'wire', position: position(0, -1, 0) },
      { kind: 'wire', position: position(0, -2, 0) },
    ],
  ),
  {
    id: 'rs.host.failure-injection',
    displayName: 'Host failure injection',
    fixture: () => ({
      expectedRequests: [],
      input: {
        blocks: [
          hostBlock('lever', 0, 0, 0),
          hostBlock('redstone_wire', 1, 0, 0),
          hostBlock('redstone_lamp', 2, 0, 0),
          hostBlock('dispenser', 0, 1, 0),
          hostBlock('door', -1, 0, 0),
          hostBlock('piston', 0, 0, -1),
          hostBlock('hopper', 0, 0, 1),
          hostBlock('lever', 10, 0, 0),
          hostBlock('redstone_wire', 11, 0, 0),
          hostBlock('redstone_lamp', 12, 0, 0),
          hostBlock('dropper', 10, 1, 0),
          hostBlock('trapdoor', 9, 0, 0),
          hostBlock('powered_rail', 10, 0, 1),
          hostBlock('piston', 10, 0, -1),
          hostBlock('hopper', 10, 0, 4),
          hostBlock('chest', 0, 1, 1),
          hostBlock('chest', 1, 0, 1),
          hostBlock('chest', 10, 1, 4),
          hostBlock('chest', 11, 0, 4),
        ],
        containers: [
          { kind: 'chest', position: hostPosition(0, 1, 1), items: [{ count: 1, item: 'redstone_dust' }] },
          { kind: 'chest', position: hostPosition(1, 0, 1), items: [] },
          { kind: 'chest', position: hostPosition(10, 1, 4), items: [{ count: 1, item: 'iron_ingot' }] },
          { kind: 'chest', position: hostPosition(11, 0, 4), items: [] },
          { kind: 'hopper', position: hostPosition(0, 0, 1), items: [] },
          { kind: 'hopper', position: hostPosition(10, 0, 4), items: [] },
        ],
        dimension: 'overworld',
        failureCase: 'mixed-dimensions',
        hopperContexts: [
          {
            destinationFacing: { kind: 'chest', position: hostPosition(1, 0, 1) },
            position: hostPosition(0, 0, 1),
            powered: true,
            sourceAbove: { kind: 'chest', position: hostPosition(0, 1, 1) },
          },
          {
            destinationFacing: { kind: 'chest', position: hostPosition(11, 0, 4) },
            position: hostPosition(10, 0, 4),
            powered: false,
            sourceAbove: { kind: 'chest', position: hostPosition(10, 1, 4) },
          },
        ],
        lookups: { leverActive: true, pistonFacing: 'east' },
      },
      path: 'host',
    }),
  },
  fixtureOnlyScenario(
    'rs.stage.frame-timeline',
    'Frame accumulator and stage timeline',
    'fixture-only',
    'This deterministic board is the stage input; frame deltas, tick limits, settle, and drain/replay are driven by the timeline controls rather than host fixture data.',
    [
      { active: true, kind: 'lever', position: position(0, 0, 0) },
      { kind: 'wire', position: position(1, 0, 0) },
      { kind: 'lamp', position: position(2, 0, 0) },
    ],
  ),
  fixtureOnlyScenario(
    'rs.share.json-roundtrip',
    'JSON fixture round trip',
    'fixture-only',
    'T12 provides a stable source snapshot; browser share serialization and import are outside the scenario registry contract.',
    [
      { active: true, kind: 'lever', position: position(0, 0, 0) },
      { kind: 'wire', position: position(1, 0, 0) },
      { kind: 'note-block', position: position(2, 0, 0) },
    ],
  ),
]
