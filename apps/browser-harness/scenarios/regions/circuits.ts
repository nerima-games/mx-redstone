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
): HostFixtureInput['blocks'][number] => ({ block, position: blockPosition })

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
    displayName: 'Torch inversion and burnout timing',
    fixture: () => ({
      path: 'fixture-only',
      reason: 'The raw-host builder classifies torch blocks but cannot supply support-cell power or the invertedBy relation needed to demonstrate burnout timing.',
      snapshot: snapshot([
        { active: true, kind: 'lever', position: position(0) },
        { invertedBy: position(0), kind: 'torch', position: position(1) },
      ]),
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
    displayName: 'Repeater delay and side lock',
    fixture: () => ({
      path: 'fixture-only',
      reason: 'There is no raw-host repeater builder or lookup for facing, delay, or side-lock input; this domain snapshot seeds a four-tick repeater with a powered side input.',
      snapshot: snapshot([
        { active: true, kind: 'lever', position: position(0, 0, 1) },
        { active: true, kind: 'lever', position: position(1) },
        {
          delayTicks: NonNegativeTickCount(4),
          inputFrom: position(0, 0, 1),
          kind: 'repeater',
          outputTo: position(0, 0, -1),
          position: position(0),
          sideInputs: [position(1)],
        },
        { kind: 'lamp', position: position(0, 0, -1) },
      ]),
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
    displayName: 'Comparator 0–15 input ladder',
    fixture: () => ({
      path: 'fixture-only',
      reason: 'The host comparator builder fixes compare mode and cannot express a 0–15 container-signal ladder across compare and subtract modes.',
      snapshot: snapshot(Array.from({ length: 16 }, (_, signal) => ({
        containerSignal: signal,
        inputFrom: position(signal * 3, 0, 1),
        kind: 'comparator',
        mode: signal % 2 === 0 ? 'compare' : 'subtract',
        outputTo: position(signal * 3, 0, -1),
        position: position(signal * 3),
        sideInputs: [],
      }))),
    }),
  },
]
