import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { isLit, isPowered, powerAt, propagateTickState, settle, type PowerTickContext } from '../src/domain/power-graph'
import {
  redstoneBoard3d,
  redstoneNodeId3d,
  redstonePosition3d,
  type RedstoneBoard3dCell,
} from './support/redstone-board-3d'

const cell = (
  dimension: string,
  kind: RedstoneBoard3dCell['component']['kind'],
  x: number,
  y: number,
  z: number,
  active?: boolean,
  properties: Omit<RedstoneBoard3dCell['component'], 'kind' | 'active'> = {},
): RedstoneBoard3dCell => ({
  component: { kind, ...(active === undefined ? {} : { active }), ...properties },
  dimension,
  position: redstonePosition3d(x, y, z),
})

// Match the runtime's stable face order: +x, -x, +y, -y, +z, -z.
const FACE_OFFSETS: ReadonlyArray<Readonly<{ x: number; y: number; z: number }>> = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
]

const blockContext = (
  cells: ReadonlyArray<RedstoneBoard3dCell>,
  conductivePositions: ReadonlySet<string>,
): PowerTickContext => {
  const positions = new Map<string, { readonly dimension: string; readonly position: RedstoneBoard3dCell['position'] }>()
  for (const { dimension, position } of cells) {
    positions.set(redstoneNodeId3d(dimension, position), { dimension, position })
  }
  return {
    faceNeighboursOf: (key) => {
      const source = positions.get(key)
      if (!source) return []
      return FACE_OFFSETS.map((offset) => {
        const position = redstonePosition3d(
          source.position.x + offset.x,
          source.position.y + offset.y,
          source.position.z + offset.z,
        )
        const neighbour = redstoneNodeId3d(source.dimension, position)
        positions.set(neighbour, { dimension: source.dimension, position })
        return neighbour
      })
    },
    isRedstoneConductiveAt: (key) => conductivePositions.has(key),
  }
}

describe('3D redstone circuits', () => {
  it.effect('propagates through horizontal and vertical wire runs', () =>
    Effect.sync(() => {
      // Ignoring a six-face edge would leave the horizontal or vertical tail below its expected level.
      const board = redstoneBoard3d([
        cell('overworld', 'lever', 0, 0, 0, true),
        cell('overworld', 'wire', 1, 0, 0),
        cell('overworld', 'wire', 2, 0, 0),
        cell('overworld', 'wire', 0, 1, 0),
        cell('overworld', 'wire', 0, 2, 0),
        cell('overworld', 'wire', 0, -1, 0),
        cell('overworld', 'wire', 0, -2, 0),
      ])
      const { power } = settle(board)

      expect(powerAt(power, redstoneNodeId3d('overworld', redstonePosition3d(1, 0, 0)))).toBe(15)
      expect(powerAt(power, redstoneNodeId3d('overworld', redstonePosition3d(2, 0, 0)))).toBe(14)
      expect(powerAt(power, redstoneNodeId3d('overworld', redstonePosition3d(0, 1, 0)))).toBe(15)
      expect(powerAt(power, redstoneNodeId3d('overworld', redstonePosition3d(0, 2, 0)))).toBe(14)
      expect(powerAt(power, redstoneNodeId3d('overworld', redstonePosition3d(0, -1, 0)))).toBe(15)
      expect(powerAt(power, redstoneNodeId3d('overworld', redstonePosition3d(0, -2, 0)))).toBe(14)
    }),
  )

  it('strongly powers a wire above a solid block', () => {
    // Missing the attachment block handoff leaves the wire above the lever unpowered.
    const cells = [
      cell('overworld', 'lever', 0, -1, 0, true, { strongPowerTo: redstonePosition3d(0, 0, 0) }),
      cell('overworld', 'wire', 0, 1, 0),
    ]
    const board = redstoneBoard3d(cells)
    const block = redstoneNodeId3d('overworld', redstonePosition3d(0, 0, 0))
    const state = propagateTickState(board, new Map(), { context: blockContext(cells, new Set([block])) })

    expect(powerAt(state.power, redstoneNodeId3d('overworld', redstonePosition3d(0, 1, 0)))).toBe(15)
  })

  it('strongly powers a wire below a solid block', () => {
    // Missing the attachment block handoff leaves the wire below the lever unpowered.
    const cells = [
      cell('overworld', 'lever', 2, 1, 0, true, { strongPowerTo: redstonePosition3d(2, 0, 0) }),
      cell('overworld', 'wire', 2, -1, 0),
    ]
    const board = redstoneBoard3d(cells)
    const block = redstoneNodeId3d('overworld', redstonePosition3d(2, 0, 0))
    const state = propagateTickState(board, new Map(), { context: blockContext(cells, new Set([block])) })

    expect(powerAt(state.power, redstoneNodeId3d('overworld', redstonePosition3d(2, -1, 0)))).toBe(15)
  })

  it.effect('does not connect a diagonal wire', () =>
    Effect.sync(() => {
      // Adding diagonal adjacency would incorrectly power the wire at (1, 1, 0).
      const board = redstoneBoard3d([
        cell('overworld', 'lever', 0, 0, 0, true),
        cell('overworld', 'wire', 1, 1, 0),
      ])
      const { power } = settle(board)

      expect(powerAt(power, redstoneNodeId3d('overworld', redstonePosition3d(1, 1, 0)))).toBe(0)
    }),
  )

  it.effect('isolates identical coordinates in different dimensions', () =>
    Effect.sync(() => {
      // Omitting the dimension from node ids would let the overworld lever energize the nether wire.
      const board = redstoneBoard3d([
        cell('overworld', 'lever', 0, 0, 0, true),
        cell('overworld', 'wire', 1, 0, 0),
        cell('nether', 'lever', 0, 0, 0, false),
        cell('nether', 'wire', 1, 0, 0),
      ])
      const { power } = settle(board)

      expect(powerAt(power, redstoneNodeId3d('overworld', redstonePosition3d(1, 0, 0)))).toBe(15)
      expect(powerAt(power, redstoneNodeId3d('nether', redstonePosition3d(1, 0, 0)))).toBe(0)
    }),
  )

  it.effect('drives a vertical wire from a torch', () =>
    Effect.sync(() => {
      // Fails if a torch omits six-face neighbours from its output edges.
      const board = redstoneBoard3d([
        cell('overworld', 'torch', 0, 0, 0),
        cell('overworld', 'wire', 0, 1, 0),
      ])
      const { power } = settle(board)

      expect(powerAt(power, redstoneNodeId3d('overworld', redstonePosition3d(0, 1, 0)))).toBe(15)
    }),
  )

  it.effect('drives a vertical wire from an active button', () =>
    Effect.sync(() => {
      // Fails if an active button cannot power a component on a vertical face.
      const board = redstoneBoard3d([
        cell('overworld', 'button', 0, 0, 0, true),
        cell('overworld', 'wire', 0, 1, 0),
      ])
      const { power } = settle(board)

      expect(powerAt(power, redstoneNodeId3d('overworld', redstonePosition3d(0, 1, 0)))).toBe(15)
    }),
  )

  it.effect('reads a vertical rear and drives a repeater output above it', () =>
    Effect.sync(() => {
      // Fails if a repeater cannot read power below it and drive its configured vertical output.
      const board = redstoneBoard3d([
        cell('overworld', 'lever', 0, 0, 0, true),
        cell('overworld', 'wire', 0, 1, 0),
        cell('overworld', 'repeater', 0, 2, 0, undefined, {
          inputFrom: redstonePosition3d(0, 1, 0),
          outputTo: redstonePosition3d(0, 3, 0),
        }),
        cell('overworld', 'wire', 0, 3, 0),
      ])
      const { power } = settle(board)

      expect(powerAt(power, redstoneNodeId3d('overworld', redstonePosition3d(0, 2, 0)))).toBe(15)
      expect(powerAt(power, redstoneNodeId3d('overworld', redstonePosition3d(0, 3, 0)))).toBe(15)
    }),
  )

  it.effect('lights from a vertical wire and does not conduct through a lamp', () =>
    Effect.sync(() => {
      // Fails if a lamp cannot light from vertical power or relays power to the next wire.
      const board = redstoneBoard3d([
        cell('overworld', 'lever', 0, 0, 0, true),
        cell('overworld', 'wire', 0, 1, 0),
        cell('overworld', 'lamp', 0, 2, 0),
        cell('overworld', 'wire', 0, 3, 0),
      ])
      const { power } = settle(board)
      const lamp = redstoneNodeId3d('overworld', redstonePosition3d(0, 2, 0))

      expect(isLit(board, power, lamp)).toBe(true)
      expect(powerAt(power, redstoneNodeId3d('overworld', redstonePosition3d(0, 3, 0)))).toBe(0)
    }),
  )

  it.effect('reads a vertical comparator rear and drives its vertical output', () =>
    Effect.sync(() => {
      // Fails if a comparator cannot read its vertical rear and send the numeric level upward.
      const board = redstoneBoard3d([
        cell('overworld', 'lever', 0, 0, 0, true),
        cell('overworld', 'wire', 0, 1, 0),
        cell('overworld', 'comparator', 0, 2, 0, undefined, {
          inputFrom: redstonePosition3d(0, 1, 0),
          outputTo: redstonePosition3d(0, 3, 0),
        }),
        cell('overworld', 'wire', 0, 3, 0),
      ])
      const { power } = settle(board)

      expect(powerAt(power, redstoneNodeId3d('overworld', redstonePosition3d(0, 2, 0)))).toBe(15)
      expect(powerAt(power, redstoneNodeId3d('overworld', redstonePosition3d(0, 3, 0)))).toBe(15)
    }),
  )

  it.effect('drives only an observer output configured above it', () =>
    Effect.sync(() => {
      // Fails if an observer drives its watched vertical face instead of its configured output face.
      const board = redstoneBoard3d([
        cell('overworld', 'wire', 0, 0, 0),
        cell('overworld', 'observer', 0, 1, 0, true, {
          outputTo: redstonePosition3d(0, 2, 0),
        }),
        cell('overworld', 'wire', 0, 2, 0),
      ])
      const { power } = settle(board)

      expect(powerAt(power, redstoneNodeId3d('overworld', redstonePosition3d(0, 2, 0)))).toBe(15)
      expect(powerAt(power, redstoneNodeId3d('overworld', redstonePosition3d(0, 0, 0)))).toBe(0)
    }),
  )

  it.effect('drives a vertical wire at a pressure plate reported strength', () =>
    Effect.sync(() => {
      // Fails if a weighted plate loses its reported strength when powering vertically.
      const board = redstoneBoard3d([
        cell('overworld', 'pressure-plate', 0, 0, 0, true, { emits: 7 }),
        cell('overworld', 'wire', 0, 1, 0),
      ])
      const { power } = settle(board)

      expect(powerAt(power, redstoneNodeId3d('overworld', redstonePosition3d(0, 1, 0)))).toBe(7)
    }),
  )

  it.effect('drives a vertical wire at a target hit strength', () =>
    Effect.sync(() => {
      // Fails if a target's variable signal is lost across a vertical face.
      const board = redstoneBoard3d([
        cell('overworld', 'target', 0, 0, 0, true, { emits: 9 }),
        cell('overworld', 'wire', 0, 1, 0),
      ])
      const { power } = settle(board)

      expect(powerAt(power, redstoneNodeId3d('overworld', redstonePosition3d(0, 1, 0)))).toBe(9)
    }),
  )

  it.effect('receives power at a piston from a vertical neighbour', () =>
    Effect.sync(() => {
      // Fails if vertical power does not reach a piston actuator.
      const board = redstoneBoard3d([
        cell('overworld', 'lever', 0, 0, 0, true),
        cell('overworld', 'piston', 0, 1, 0),
      ])
      const { power } = settle(board)
      const piston = redstoneNodeId3d('overworld', redstonePosition3d(0, 1, 0))

      expect(isPowered(board, power, piston)).toBe(true)
      expect(powerAt(power, piston)).toBe(0)
    }),
  )

  it.effect('receives vertical power when a sticky piston faces upward', () =>
    Effect.sync(() => {
      // Fails if a sticky piston facing vertically is missed by adjacent power lookup.
      const board = redstoneBoard3d([
        cell('overworld', 'lever', 0, 0, 0, true),
        cell('overworld', 'piston', 0, 1, 0, undefined, {
          pistonFacing: 'up',
          pistonKind: 'sticky',
          pistonState: 'retracted',
        }),
      ])
      const { power } = settle(board)
      const piston = redstoneNodeId3d('overworld', redstonePosition3d(0, 1, 0))

      expect(isPowered(board, power, piston)).toBe(true)
      expect(powerAt(power, piston)).toBe(0)
    }),
  )

  it.effect('powers a vertical hopper without conducting through it', () =>
    Effect.sync(() => {
      // Fails if a hopper relays power to the wire above or loses its vertical lock signal.
      const board = redstoneBoard3d([
        cell('overworld', 'lever', 0, 0, 0, true),
        cell('overworld', 'wire', 0, 1, 0),
        cell('overworld', 'hopper', 0, 2, 0),
        cell('overworld', 'wire', 0, 3, 0),
      ])
      const { power } = settle(board)
      const hopper = redstoneNodeId3d('overworld', redstonePosition3d(0, 2, 0))

      expect(isPowered(board, power, hopper)).toBe(true)
      expect(powerAt(power, hopper)).toBe(0)
      expect(powerAt(power, redstoneNodeId3d('overworld', redstonePosition3d(0, 3, 0)))).toBe(0)
    }),
  )

  it.effect('powers a vertical dispenser without conducting through it', () =>
    Effect.sync(() => {
      // Fails if a dispenser relays power to the wire above or loses its vertical trigger signal.
      const board = redstoneBoard3d([
        cell('overworld', 'lever', 0, 0, 0, true),
        cell('overworld', 'wire', 0, 1, 0),
        cell('overworld', 'dispenser', 0, 2, 0),
        cell('overworld', 'wire', 0, 3, 0),
      ])
      const { power } = settle(board)
      const dispenser = redstoneNodeId3d('overworld', redstonePosition3d(0, 2, 0))

      expect(isPowered(board, power, dispenser)).toBe(true)
      expect(powerAt(power, dispenser)).toBe(0)
      expect(powerAt(power, redstoneNodeId3d('overworld', redstonePosition3d(0, 3, 0)))).toBe(0)
    }),
  )

  it.effect('powers a vertical dropper without conducting through it', () =>
    Effect.sync(() => {
      // Fails if a dropper relays power to the wire above or misses its vertical trigger signal.
      const board = redstoneBoard3d([
        cell('overworld', 'lever', 0, 0, 0, true),
        cell('overworld', 'wire', 0, 1, 0),
        cell('overworld', 'dropper', 0, 2, 0),
        cell('overworld', 'wire', 0, 3, 0),
      ])
      const { power } = settle(board)
      const dropper = redstoneNodeId3d('overworld', redstonePosition3d(0, 2, 0))

      expect(isPowered(board, power, dropper)).toBe(true)
      expect(powerAt(power, dropper)).toBe(0)
      expect(powerAt(power, redstoneNodeId3d('overworld', redstonePosition3d(0, 3, 0)))).toBe(0)
    }),
  )

  it.effect('powers a vertical note block without conducting through it', () =>
    Effect.sync(() => {
      // Fails if a note block relays power to the wire above or misses its vertical trigger signal.
      const board = redstoneBoard3d([
        cell('overworld', 'lever', 0, 0, 0, true),
        cell('overworld', 'wire', 0, 1, 0),
        cell('overworld', 'note-block', 0, 2, 0),
        cell('overworld', 'wire', 0, 3, 0),
      ])
      const { power } = settle(board)
      const noteBlock = redstoneNodeId3d('overworld', redstonePosition3d(0, 2, 0))

      expect(isPowered(board, power, noteBlock)).toBe(true)
      expect(powerAt(power, noteBlock)).toBe(0)
      expect(powerAt(power, redstoneNodeId3d('overworld', redstonePosition3d(0, 3, 0)))).toBe(0)
    }),
  )

  it.effect('powers a vertical powered rail without conducting through it', () =>
    Effect.sync(() => {
      // Fails if powered rail state checks miss a vertical redstone neighbour.
      const board = redstoneBoard3d([
        cell('overworld', 'lever', 0, 0, 0, true),
        cell('overworld', 'wire', 0, 1, 0),
        cell('overworld', 'powered-rail', 0, 2, 0),
        cell('overworld', 'wire', 0, 3, 0),
      ])
      const { power } = settle(board)
      const rail = redstoneNodeId3d('overworld', redstonePosition3d(0, 2, 0))

      expect(isPowered(board, power, rail)).toBe(true)
      expect(powerAt(power, rail)).toBe(0)
      expect(powerAt(power, redstoneNodeId3d('overworld', redstonePosition3d(0, 3, 0)))).toBe(0)
    }),
  )

  it.effect('powers a vertical door without conducting through it', () =>
    Effect.sync(() => {
      // Fails if door state checks miss vertical power or let it join the wire beyond.
      const board = redstoneBoard3d([
        cell('overworld', 'lever', 0, 0, 0, true),
        cell('overworld', 'wire', 0, 1, 0),
        cell('overworld', 'door', 0, 2, 0),
        cell('overworld', 'wire', 0, 3, 0),
      ])
      const { power } = settle(board)
      const door = redstoneNodeId3d('overworld', redstonePosition3d(0, 2, 0))

      expect(isPowered(board, power, door)).toBe(true)
      expect(powerAt(power, door)).toBe(0)
      expect(powerAt(power, redstoneNodeId3d('overworld', redstonePosition3d(0, 3, 0)))).toBe(0)
    }),
  )

  it.effect('powers a vertical trapdoor without conducting through it', () =>
    Effect.sync(() => {
      // Fails if trapdoor state checks miss vertical power or let it join the wire beyond.
      const board = redstoneBoard3d([
        cell('overworld', 'lever', 0, 0, 0, true),
        cell('overworld', 'wire', 0, 1, 0),
        cell('overworld', 'trapdoor', 0, 2, 0),
        cell('overworld', 'wire', 0, 3, 0),
      ])
      const { power } = settle(board)
      const trapdoor = redstoneNodeId3d('overworld', redstonePosition3d(0, 2, 0))

      expect(isPowered(board, power, trapdoor)).toBe(true)
      expect(powerAt(power, trapdoor)).toBe(0)
      expect(powerAt(power, redstoneNodeId3d('overworld', redstonePosition3d(0, 3, 0)))).toBe(0)
    }),
  )
})
