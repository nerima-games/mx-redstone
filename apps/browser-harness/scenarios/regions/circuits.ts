import { BlockPositionSchema, DimensionIdSchema, NonNegativeTickCount } from '@nerima-games/mc-kernel'
import { Schema } from 'effect'
import type {
  RedstoneComponentSnapshot,
  RedstoneWorldSnapshot,
} from '../../../../src/application/world-runtime.js'
import type { BrowserScenario, HostFixtureInput } from '../../scenario-registry.js'

const OVERWORLD = Schema.decodeUnknownSync(DimensionIdSchema)('overworld')

const position = (x: number, y = 0, z = 0) =>
  Schema.decodeUnknownSync(BlockPositionSchema)({ x, y, z })

const rawPosition = (x: number, y = 0, z = 0) => ({ x, y, z })

const hostBlock = (
  block: HostFixtureInput['blocks'][number]['block'],
  blockPosition: HostFixtureInput['blocks'][number]['position'],
  state?: HostFixtureInput['blocks'][number]['state'],
): HostFixtureInput['blocks'][number] => ({
  block,
  position: blockPosition,
  ...(state === undefined ? {} : { state }),
})

const hostBlockPowering = (
  block: HostFixtureInput['blocks'][number]['block'],
  blockPosition: HostFixtureInput['blocks'][number]['position'],
  strongPowerTo: NonNullable<HostFixtureInput['blocks'][number]['strongPowerTo']>,
): HostFixtureInput['blocks'][number] => ({
  ...hostBlock(block, blockPosition),
  strongPowerTo,
})

const snapshot = (components: ReadonlyArray<RedstoneComponentSnapshot>): RedstoneWorldSnapshot => ({
  components,
  dimension: OVERWORLD,
})

const attenuationBlocks: HostFixtureInput['blocks'] = [
  hostBlock('lever', rawPosition(0)),
  ...Array.from({ length: 14 }, (_, index) => ({
    ...hostBlock('redstone_wire', rawPosition(index + 1)),
  })),
  hostBlock('lever', rawPosition(7, 0, 1)),
  hostBlock('redstone_lamp', rawPosition(15)),
]

export const circuitScenarios: ReadonlyArray<BrowserScenario> = [
  {
    id: 'rs.wire.attenuation',
    displayName: 'Wire attenuation and multiple sources',
    fixture: () => ({
      expectedRequests: [{ kind: 'lamp', dimension: 'overworld', position: rawPosition(15) }],
      input: { blocks: attenuationBlocks, dimension: 'overworld', lookups: { leverActive: true } },
      path: 'host',
    }),
  },
  {
    id: 'rs.torch.inversion-burnout',
    displayName: 'Torch inversion from support-cell power',
    fixture: () => ({
      expectedRequests: [{ kind: 'lamp', dimension: 'overworld', position: rawPosition(0, 0, 2) }],
      input: {
        blocks: [
          hostBlock('stone', rawPosition(0, -1)),
          hostBlock('redstone_torch', rawPosition(0), { lit: true }),
          hostBlockPowering('lever', rawPosition(1, -1), rawPosition(0, -1)),
          hostBlock('redstone_wire', rawPosition(0, 0, 1)),
          hostBlock('redstone_lamp', rawPosition(0, 0, 2)),
        ],
        dimension: 'overworld',
        lookups: { conductivePositions: [rawPosition(0, -1)], leverActive: true },
      },
      path: 'host',
    }),
  },
  {
    id: 'rs.lever.toggle',
    displayName: 'Lever input and lamp transition',
    fixture: () => ({
      expectedRequests: [{ kind: 'lamp', dimension: 'overworld', position: rawPosition(2) }],
      input: {
        blocks: [
          { block: 'lever', position: rawPosition(0) },
          { block: 'redstone_wire', position: rawPosition(1) },
          { block: 'redstone_lamp', position: rawPosition(2) },
        ],
        dimension: 'overworld',
        lookups: { leverActive: true },
      },
      path: 'host',
    }),
  },
  {
    id: 'rs.button.pulse',
    displayName: 'Button pulse and release',
    fixture: () => ({
      path: 'fixture-only',
      reason: 'The raw-host builder and lookup have no button press, release, or pulse-duration input; this domain snapshot supplies a deterministic 10-tick pulse state.',
      snapshot: snapshot([
        { active: true, kind: 'button', position: position(0), pulseTicks: NonNegativeTickCount(10) },
        { kind: 'lamp', position: position(1) },
      ]),
    }),
  },
  {
    id: 'rs.repeater.delay-lock',
    displayName: 'Repeater state, delay, and side lock',
    fixture: () => ({
      expectedRequests: [],
      input: {
        blocks: [
          hostBlock('lever', rawPosition(0)),
          hostBlock('repeater', rawPosition(1), { delay: 4, facing: 'east', locked: false, powered: false }),
          hostBlock('redstone_wire', rawPosition(2)),
          hostBlock('redstone_lamp', rawPosition(3)),
          hostBlock('lever', rawPosition(0, 0, 4)),
          hostBlock('repeater', rawPosition(1, 0, 4), { delay: 2, facing: 'east', locked: true, powered: false }),
          hostBlock('redstone_wire', rawPosition(2, 0, 4)),
          hostBlock('lever', rawPosition(1, 0, 5)),
          hostBlock('redstone_lamp', rawPosition(3, 0, 4)),
        ],
        dimension: 'overworld',
        lookups: { leverActive: true },
      },
      path: 'host',
    }),
  },
  {
    id: 'rs.lamp.isolation-transition',
    displayName: 'Lamp isolation and transition',
    fixture: () => ({
      expectedRequests: [{ kind: 'lamp', dimension: 'overworld', position: rawPosition(2) }],
      input: {
        blocks: [
          { block: 'lever', position: rawPosition(0) },
          { block: 'redstone_wire', position: rawPosition(1) },
          { block: 'redstone_lamp', position: rawPosition(2) },
          { block: 'redstone_lamp', position: rawPosition(3) },
        ],
        dimension: 'overworld',
        lookups: { leverActive: true },
      },
      path: 'host',
    }),
  },
  {
    id: 'rs.comparator.ladder',
    displayName: 'Comparator facing and compare mode from block state',
    fixture: () => ({
      expectedRequests: [{ kind: 'lamp', dimension: 'overworld', position: rawPosition(2) }],
      input: {
        blocks: [
          hostBlock('chest', rawPosition(0)),
          hostBlock('comparator', rawPosition(1), { facing: 'east', mode: 'compare', powered: false }),
          hostBlock('redstone_lamp', rawPosition(2)),
        ],
        dimension: 'overworld',
        lookups: { containerSlots: [{ count: 32, maxStack: 64 }], leverActive: true },
      },
      path: 'host',
    }),
  },
]
