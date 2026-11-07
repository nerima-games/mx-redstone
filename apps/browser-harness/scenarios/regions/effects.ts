import type {
  BrowserScenario,
  HostFixtureInput,
  HostFixtureRequest,
} from '../../scenario-registry.js'

const dimensionName = 'overworld'

const hostPosition = (
  x: number,
  y: number,
  z: number,
): HostFixtureInput['blocks'][number]['position'] => ({ x, y, z })

const hostBlock = (
  block: HostFixtureInput['blocks'][number]['block'],
  x: number,
  y: number,
  z: number,
): HostFixtureInput['blocks'][number] => ({ block, position: hostPosition(x, y, z) })

const hostScenario = (
  id: string,
  displayName: string,
  blocks: HostFixtureInput['blocks'],
  expectedRequests: ReadonlyArray<HostFixtureRequest>,
  lookups?: HostFixtureInput['lookups'],
  extraInput?: Pick<HostFixtureInput, 'containers' | 'hopperContexts'>,
): BrowserScenario => ({
  displayName,
  fixture: () => ({
    expectedRequests,
    input: {
      blocks,
      dimension: dimensionName,
      ...(lookups === undefined ? {} : { lookups }),
      ...extraInput,
    },
    path: 'host',
  }),
  id,
})

const pistonLongColumn = Array.from({ length: 13 }, (_, index) => hostBlock('stone', index + 2, 0, 0))

export const effectScenarios: ReadonlyArray<BrowserScenario> = [
  hostScenario(
    'rs.piston.push-refusal',
    'Piston push refusal',
    [
      hostBlock('lever', 0, 0, 0),
      hostBlock('piston', 1, 0, 0),
      ...pistonLongColumn,
      hostBlock('lever', 0, 0, 2),
      hostBlock('piston', 1, 0, 2),
      ...Array.from({ length: 12 }, (_, index) => hostBlock('stone', index + 2, 0, 2)),
      hostBlock('obsidian', 14, 0, 2),
    ],
    [],
    { leverActive: true, pistonFacing: 'east' },
  ),
  hostScenario(
    'rs.sticky-piston.retract-pull',
    'Sticky piston retract pull',
    [
      hostBlock('sticky_piston', 0, 0, 0),
      hostBlock('piston_head', 1, 0, 0),
      hostBlock('stone', 2, 0, 0),
    ],
    [{ dimension: dimensionName, kind: 'piston', position: hostPosition(0, 0, 0) }],
    { leverActive: false, pistonFacing: 'east' },
  ),
  hostScenario(
    'rs.hopper.lock-transfer',
    'Powered hopper lock blocks a transfer request',
    [
      hostBlock('lever', 0, 0, 0),
      hostBlock('hopper', 1, 0, 0),
      hostBlock('chest', 1, 1, 0),
      hostBlock('chest', 2, 0, 0),
      hostBlock('hopper', 5, 0, 0),
      hostBlock('chest', 5, 1, 0),
      hostBlock('chest', 6, 0, 0),
    ],
    [],
    { leverActive: true },
    {
      containers: [
        { kind: 'chest', position: hostPosition(1, 1, 0), items: [{ count: 2, item: 'redstone_dust' }] },
        { kind: 'chest', position: hostPosition(2, 0, 0), items: [] },
        { kind: 'chest', position: hostPosition(5, 1, 0), items: [{ count: 1, item: 'iron_ingot' }] },
        { kind: 'chest', position: hostPosition(6, 0, 0), items: [] },
        { kind: 'hopper', position: hostPosition(1, 0, 0), items: [] },
        { kind: 'hopper', position: hostPosition(5, 0, 0), items: [] },
      ],
      hopperContexts: [
        {
          destinationFacing: { kind: 'chest', position: hostPosition(2, 0, 0) },
          position: hostPosition(1, 0, 0),
          powered: true,
          sourceAbove: { kind: 'chest', position: hostPosition(1, 1, 0) },
        },
        {
          destinationFacing: { kind: 'chest', position: hostPosition(6, 0, 0) },
          position: hostPosition(5, 0, 0),
          powered: false,
          sourceAbove: { kind: 'chest', position: hostPosition(5, 1, 0) },
        },
      ],
    },
  ),
  hostScenario(
    'rs.dispenser.rising-edge',
    'Dispenser rising edge',
    [hostBlock('lever', 0, 0, 0), hostBlock('dispenser', 1, 0, 0)],
    [{
      component: 'dispenser',
      dimension: dimensionName,
      kind: 'trigger',
      position: hostPosition(1, 0, 0),
    }],
    { leverActive: true },
  ),
  hostScenario(
    'rs.dropper.rising-edge',
    'Dropper rising edge',
    [hostBlock('lever', 0, 0, 0), hostBlock('dropper', 1, 0, 0)],
    [{
      component: 'dropper',
      dimension: dimensionName,
      kind: 'trigger',
      position: hostPosition(1, 0, 0),
    }],
    { leverActive: true },
  ),
  hostScenario(
    'rs.note-block.trigger',
    'Note block sound request',
    [hostBlock('lever', 0, 0, 0), hostBlock('note_block', 1, 0, 0)],
    [{
      component: 'note-block',
      dimension: dimensionName,
      kind: 'trigger',
      position: hostPosition(1, 0, 0),
    }],
    { leverActive: true },
  ),
  hostScenario(
    'rs.powered-rail.transition',
    'Powered rail transition',
    [hostBlock('lever', 0, 0, 0), hostBlock('powered_rail', 1, 0, 0)],
    [{
      component: 'powered-rail',
      dimension: dimensionName,
      kind: 'powered',
      position: hostPosition(1, 0, 0),
    }],
    { leverActive: true, poweredRailPowered: false },
  ),
  hostScenario(
    'rs.door.open-transition',
    'Door powered transition',
    [hostBlock('lever', 0, 0, 0), hostBlock('door', 1, 0, 0)],
    [{
      component: 'door',
      dimension: dimensionName,
      kind: 'powered',
      position: hostPosition(1, 0, 0),
    }],
    { leverActive: true },
  ),
  hostScenario(
    'rs.trapdoor.open-transition',
    'Trapdoor powered transition',
    [hostBlock('lever', 0, 0, 0), hostBlock('trapdoor', 1, 0, 0)],
    [{
      component: 'trapdoor',
      dimension: dimensionName,
      kind: 'powered',
      position: hostPosition(1, 0, 0),
    }],
    { leverActive: true },
  ),
]
