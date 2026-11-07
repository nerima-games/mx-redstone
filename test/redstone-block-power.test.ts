import { describe, expect, it } from '@effect/vitest'
import { BlockPositionSchema } from '@nerima-games/mc-kernel'
import { Schema } from 'effect'
import {
  MAX_POWER_LEVEL,
  emptyPowerMap,
  isLit,
  isPowered,
  powerAt,
  propagateTickState,
  propagateTickWithProvenance,
  type CircuitBoard,
  type Component,
  type PowerTickBlockLevels,
  type PowerTickContext,
} from '../src/domain/power-graph'

type Position = Readonly<{ x: number; y: number; z: number }>
type Cell = Readonly<{
  component: Component
  dimension: string
  key: string
  position: Position
}>

const NO_POWER = 0
const SIGNAL_LEVELS = Array.from({ length: MAX_POWER_LEVEL + 1 }, (_, level) => level)
const FACE_OFFSETS: ReadonlyArray<Position> = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
]

const position = (x: number, y: number, z: number): Position =>
  Schema.decodeUnknownSync(BlockPositionSchema)({ x, y, z })

const positionKey = (dimension: string, point: Position): string =>
  JSON.stringify([dimension, point.x, point.y, point.z])

const cell = (
  kind: Component['kind'],
  x: number,
  y = 0,
  z = 0,
  fields: Omit<Component, 'kind'> = {},
  dimension = 'overworld',
): Cell => {
  const point = position(x, y, z)
  return { component: { ...fields, kind }, dimension, key: positionKey(dimension, point), position: point }
}

const isFaceAdjacent = (left: Cell, right: Cell): boolean =>
  left.dimension === right.dimension &&
  Math.abs(left.position.x - right.position.x) +
    Math.abs(left.position.y - right.position.y) +
    Math.abs(left.position.z - right.position.z) === 1

const fixture = (
  cells: ReadonlyArray<Cell>,
  conductive: ReadonlyArray<Position | Readonly<{ dimension?: string; position: Position }>>,
) => {
  const componentCells = new Map(cells.map(({ component, key }) => [key, component]))
  const adjacency = new Map(cells.map((source) => [
    source.key,
    cells.filter((candidate) => isFaceAdjacent(source, candidate)).map(({ key }) => key),
  ]))
  const positions = new Map(cells.map(({ dimension, key, position: point }) => [key, { dimension, position: point }]))
  const conductiveKeys = new Set(conductive.map((candidate) => {
    if ('position' in candidate) {
      return positionKey(candidate.dimension ?? 'overworld', candidate.position)
    }
    return positionKey('overworld', candidate)
  }))
  const queryCounts = new Map<string, number>()
  const board: CircuitBoard = { adjacency, components: componentCells }
  const context: PowerTickContext = {
    faceNeighboursOf: (key) => {
      const source = positions.get(key)
      if (!source) return []
      return FACE_OFFSETS.map((offset) => {
        const neighbourPosition = position(
          source.position.x + offset.x,
          source.position.y + offset.y,
          source.position.z + offset.z,
        )
        const neighbour = positionKey(source.dimension, neighbourPosition)
        positions.set(neighbour, { dimension: source.dimension, position: neighbourPosition })
        return neighbour
      })
    },
    isRedstoneConductiveAt: (key) => {
      queryCounts.set(key, (queryCounts.get(key) ?? 0) + 1)
      return conductiveKeys.has(key)
    },
  }
  return { board, context, queryCounts }
}

const blockAt = (levels: ReadonlyMap<string, PowerTickBlockLevels>, key: string): PowerTickBlockLevels =>
  levels.get(key) ?? { strongLevel: NO_POWER, weakLevel: NO_POWER }

const powerReadContext = (
  blockPower: ReadonlyMap<string, PowerTickBlockLevels>,
  context: PowerTickContext,
) => {
  const faceNeighboursOf = context.faceNeighboursOf
  if (!faceNeighboursOf) {
    throw new Error('The fixture must provide face neighbours')
  }
  return { blockPower, faceNeighboursOf }
}

describe('solid block power', () => {
  it('preserves every legal source level through both block channels', () => {
    // This catches off-by-one levels in strong sources, comparator output, or weak dust power.
    for (const level of SIGNAL_LEVELS) {
      const leverBlock = position(1, 0, 0)
      const buttonBlock = position(6, 0, 0)
      const plateBlock = position(11, 0, 0)
      const comparatorBlock = position(21, 0, 0)
      const dustBlock = position(30, 0, 0)
      const cells = [
        cell('lever', 0, 0, 0, { active: true, emits: level, strongPowerTo: positionKey('overworld', leverBlock) }),
        cell('button', 5, 0, 0, { active: true, emits: level, strongPowerTo: positionKey('overworld', buttonBlock) }),
        cell('pressure-plate', 10, 0, 0, { active: true, emits: level, strongPowerTo: positionKey('overworld', plateBlock) }),
        cell('comparator', 20, 0, 0, { containerSignal: level, outputTo: positionKey('overworld', comparatorBlock) }),
        cell('lever', 28, 0, 0, { active: true, emits: level }),
        cell('wire', 29, 0, 0),
      ]
      const scene = fixture(cells, [leverBlock, buttonBlock, plateBlock, comparatorBlock, dustBlock])
      const state = propagateTickState(scene.board, emptyPowerMap, { context: scene.context })
      const lever = blockAt(state.blockPower, positionKey('overworld', leverBlock))
      const button = blockAt(state.blockPower, positionKey('overworld', buttonBlock))
      const plate = blockAt(state.blockPower, positionKey('overworld', plateBlock))
      const comparator = blockAt(state.blockPower, positionKey('overworld', comparatorBlock))
      const dust = blockAt(state.blockPower, positionKey('overworld', dustBlock))

      expect(lever).toStrictEqual({ strongLevel: level, weakLevel: NO_POWER })
      expect(button).toStrictEqual({ strongLevel: level, weakLevel: NO_POWER })
      expect(plate).toStrictEqual({ strongLevel: level, weakLevel: NO_POWER })
      expect(comparator).toStrictEqual({ strongLevel: level, weakLevel: NO_POWER })
      expect(dust).toStrictEqual({ strongLevel: NO_POWER, weakLevel: level })
    }
  })

  it('reads comparator input from the previous tick block channels', () => {
    // This catches comparators ignoring weak or strong power on their rear block.
    const rear = position(0, 0, -1)
    const output = position(1, 0, 0)
    const scene = fixture([
      cell('comparator', 0, 0, 0, {
        inputFrom: positionKey('overworld', rear),
        outputTo: positionKey('overworld', output),
      }),
    ], [output])
    const context: PowerTickContext = {
      ...scene.context,
      previousBlockPower: new Map([[positionKey('overworld', rear), { strongLevel: 0, weakLevel: 8 }]]),
    }
    const state = propagateTickState(scene.board, emptyPowerMap, { context })

    expect(blockAt(state.blockPower, positionKey('overworld', output)).strongLevel).toBe(8)
  })

  it('limits observer, repeater, and comparator block output to outputTo', () => {
    // This catches directional sources leaking strong power into their rear or flank blocks.
    const east = position(1, 0, 0)
    const west = position(-1, 0, 0)
    const south = position(0, 0, 1)
    const cases: ReadonlyArray<Readonly<{
      component: Omit<Component, 'kind'>
      expectedLevel: number
      kind: Component['kind']
    }>> = [
      { component: { active: true, outputTo: positionKey('overworld', east) }, expectedLevel: 15, kind: 'observer' },
      { component: { active: true, outputTo: positionKey('overworld', east) }, expectedLevel: 15, kind: 'repeater' },
      { component: { containerSignal: 7, outputTo: positionKey('overworld', east) }, expectedLevel: 7, kind: 'comparator' },
    ]
    for (const { component, expectedLevel, kind } of cases) {
      const scene = fixture(
        [cell(kind, 0, 0, 0, component)],
        [east, west, south],
      )
      const state = propagateTickState(scene.board, emptyPowerMap, { context: scene.context })

      expect(blockAt(state.blockPower, positionKey('overworld', east)).strongLevel).toBe(expectedLevel)
      expect(state.blockPower.has(positionKey('overworld', west))).toBe(false)
      expect(state.blockPower.has(positionKey('overworld', south))).toBe(false)
    }
  })

  it('does not emit from directional sources without an output target', () => {
    // This catches an unspecified repeater, comparator, or observer face powering adjacent blocks.
    const observerBlock = position(1, 0, 0)
    const repeaterBlock = position(11, 0, 0)
    const comparatorBlock = position(21, 0, 0)
    const scene = fixture([
      cell('observer', 0, 0, 0, { active: true }),
      cell('repeater', 10, 0, 0, { active: true }),
      cell('comparator', 20, 0, 0, { containerSignal: 8 }),
    ], [observerBlock, repeaterBlock, comparatorBlock])
    const state = propagateTickState(scene.board, emptyPowerMap, { context: scene.context })

    expect(state.blockPower.size).toBe(0)
    expect(scene.queryCounts.size).toBe(0)
  })

  it('retains block power when disabled retention lacks typed receiver partitions', () => {
    // BUG: mutating the shared empty map would erase or leak channels across callers without typed partitions.
    const target = position(1, 0, 0)
    const scene = fixture([
      cell('lever', 0, 0, 0, { active: true, strongPowerTo: positionKey('overworld', target) }),
    ], [target])
    const state = propagateTickState(scene.board, emptyPowerMap, {
      context: { ...scene.context, retainBlockPower: false },
    })

    expect(blockAt(state.blockPower, positionKey('overworld', target)).strongLevel).toBe(15)
  })

  it('keeps the maximum when sources tie on a block channel without provenance', () => {
    // BUG: equally strong adjacent sources preserve the redstone channel maximum without overwriting it.
    const target = position(1, 0, 0)
    const targetKey = positionKey('overworld', target)
    const scene = fixture([
      cell('lever', 0, 0, 0, { active: true, strongPowerTo: targetKey }),
      cell('lever', 2, 0, 0, { active: true, strongPowerTo: targetKey }),
    ], [target])
    const state = propagateTickState(scene.board, emptyPowerMap, { context: scene.context })

    expect(blockAt(state.blockPower, targetKey)).toStrictEqual({ strongLevel: 15, weakLevel: 0 })
  })

  it('limits lever, button, and plate block output to strongPowerTo', () => {
    // This catches switch sources powering conductive blocks other than their attachment cell.
    const east = position(1, 0, 0)
    const west = position(-1, 0, 0)
    const north = position(0, 0, -1)
    const cases: ReadonlyArray<Readonly<{ kind: Component['kind']; fields: Omit<Component, 'kind'> }>> = [
      { fields: { active: true, strongPowerTo: positionKey('overworld', east) }, kind: 'lever' },
      { fields: { active: true, strongPowerTo: positionKey('overworld', east) }, kind: 'button' },
      { fields: { active: true, emits: 9, strongPowerTo: positionKey('overworld', east) }, kind: 'pressure-plate' },
    ]
    for (const { fields, kind } of cases) {
      const scene = fixture([cell(kind, 0, 0, 0, fields)], [east, west, north])
      const state = propagateTickState(scene.board, emptyPowerMap, { context: scene.context })

      expect(blockAt(state.blockPower, positionKey('overworld', east)).strongLevel).toBe(fields.emits ?? 15)
      expect(state.blockPower.has(positionKey('overworld', west))).toBe(false)
      expect(state.blockPower.has(positionKey('overworld', north))).toBe(false)
    }
  })

  it('keeps target output component-only', () => {
    // This catches target signals acquiring an unspecified strong block output.
    const block = position(1, 0, 0)
    const scene = fixture([cell('target', 0, 0, 0, { active: true, emits: 9 })], [block])
    const state = propagateTickState(scene.board, emptyPowerMap, { context: scene.context })

    expect(state.blockPower.size).toBe(0)
  })

  it('lets lamps and mechanisms read either channel while wires read strong only', () => {
    // This catches consumers treating weak block power as dust power or ignoring it for mechanisms.
    const scene = fixture([
      cell('lamp', 0, 0, 0),
      cell('piston', 5, 0, 0),
      cell('wire', 10, 0, 0),
    ], [])
    const blockPower = new Map([
      [positionKey('overworld', position(1, 0, 0)), { strongLevel: 0, weakLevel: 4 }],
      [positionKey('overworld', position(4, 0, 0)), { strongLevel: 0, weakLevel: 3 }],
      [positionKey('overworld', position(11, 0, 0)), { strongLevel: 0, weakLevel: 15 }],
    ])

    expect(isLit(
      scene.board,
      emptyPowerMap,
      { context: powerReadContext(blockPower, scene.context), key: positionKey('overworld', position(0, 0, 0)) },
    )).toBe(true)
    expect(isPowered(
      scene.board,
      emptyPowerMap,
      { context: powerReadContext(blockPower, scene.context), key: positionKey('overworld', position(5, 0, 0)) },
    )).toBe(true)
    expect(isPowered(
      scene.board,
      emptyPowerMap,
      { context: powerReadContext(blockPower, scene.context), key: positionKey('overworld', position(10, 0, 0)) },
    )).toBe(false)
  })

  it('routes weak block power to lamps in a non-retaining context', () => {
    // BUG: weak power must cross conductive blocks to lamps without being saved as a wire input.
    const target = position(1, 0, 0)
    const wire = cell('wire', 0)
    const lamp = cell('lamp', 2)
    const lever = cell('lever', -1, 0, 0, { active: true })
    const scene = fixture([lever, wire, lamp], [target])
    const wireKey = wire.key
    const lampKey = lamp.key
    const targetKey = positionKey('overworld', target)
    const context: PowerTickContext = {
      faceBlockNeighboursOf: (key) => key === wireKey ? [targetKey] : [],
      faceComponentNeighboursOf: (key) => key === targetKey ? [wireKey, lampKey] : [],
      faceLampNeighboursOf: (key) => key === targetKey ? [lampKey] : [],
      faceWireNeighboursOf: () => [],
      hasLampReceivers: true,
      isRedstoneConductiveAt: (key) => key === targetKey,
      retainBlockPower: false,
    }
    const state = propagateTickState(scene.board, emptyPowerMap, { context })

    expect(powerAt(state.power, lampKey)).toBe(15)
    expect(state.blockPower.size).toBe(0)
  })

  it('does not route to a lamp through a non-conductive block in the fast path', () => {
    const target = position(1, 0, 0)
    const wire = cell('wire', 0)
    const lamp = cell('lamp', 2)
    const lever = cell('lever', -1, 0, 0, { active: true })
    const targetKey = positionKey('overworld', target)
    const wireKey = wire.key
    const lampKey = lamp.key
    const context: PowerTickContext = {
      faceBlockNeighboursOf: (key) => key === wireKey ? [targetKey] : [],
      faceComponentNeighboursOf: (key) => key === targetKey ? [lampKey] : [],
      faceLampNeighboursOf: (key) => key === targetKey ? [lampKey] : [],
      faceWireNeighboursOf: () => [],
      hasLampReceivers: true,
      isRedstoneConductiveAt: () => false,
      retainBlockPower: false,
    }
    // BUG: a non-conductive block must not relay weak dust power to an adjacent lamp.
    const state = propagateTickState(fixture([lever, wire, lamp], []).board, emptyPowerMap, { context })

    expect(powerAt(state.power, lampKey)).toBe(NO_POWER)
    expect(state.blockPower.size).toBe(0)
  })

  it('queries a powered wire’s adjacent blocks when no cached support key is available', () => {
    // BUG: a conductive block under powered dust must still be checked by legacy power contexts.
    const lever = cell('lever', -1, 0, 0, { active: true })
    const wire = cell('wire', 0)
    const supportKey = positionKey('overworld', position(0, -1, 0))
    const queried: Array<string> = []
    const context: PowerTickContext = {
      faceBlockNeighboursOf: (key) => key === wire.key ? [supportKey] : [],
      faceComponentNeighboursOf: () => [],
      faceLampNeighboursOf: () => [],
      faceWireNeighboursOf: () => [],
      hasLampReceivers: false,
      isRedstoneConductiveAt: (key) => {
        queried.push(key)
        return true
      },
      retainBlockPower: false,
    }
    const state = propagateTickState(fixture([lever, wire], []).board, emptyPowerMap, { context })

    expect(powerAt(state.power, wire.key)).toBe(MAX_POWER_LEVEL)
    expect(queried).toStrictEqual([supportKey])
    expect(state.blockPower.size).toBe(0)
  })

  it('does not turn a powered lamp into a block-power source', () => {
    // This catches a lit receiver being treated as a source for the solid beside it.
    const block = position(2, 0, 0)
    const scene = fixture([
      cell('lever', 0, 0, 0, { active: true }),
      cell('lamp', 1, 0, 0),
    ], [block])
    const state = propagateTickState(scene.board, emptyPowerMap, { context: scene.context })

    expect(powerAt(state.power, positionKey('overworld', position(1, 0, 0)))).toBe(15)
    expect(state.blockPower.size).toBe(0)
  })

  it('selects the maximum across strong-only, weak-only, and tied block channels', () => {
    // This catches lamps receiving the weaker channel or wires receiving weak block power.
    const block = position(1, 0, 0)
    const cases = [
      {
        cells: [cell('lever', 0, 0, 0, {
          active: true,
          emits: 8,
          strongPowerTo: positionKey('overworld', block),
        })],
        expected: { strongLevel: 8, weakLevel: 0 },
      },
      {
        cells: [cell('torch', 2, 0, 0, {
          invertedBy: 'support',
          strongPowerTo: positionKey('overworld', position(2, 1, 0)),
        })],
        expected: { strongLevel: 0, weakLevel: 15 },
      },
      {
        cells: [
          cell('lever', 0, 0, 0, { active: true, strongPowerTo: positionKey('overworld', block) }),
          cell('torch', 2, 0, 0, {
            invertedBy: 'support',
            strongPowerTo: positionKey('overworld', position(2, 1, 0)),
          }),
        ],
        expected: { strongLevel: 15, weakLevel: 15 },
      },
    ]
    for (const { cells, expected } of cases) {
      const scene = fixture([...cells, cell('lamp', 1, 1, 0)], [block])
      const state = propagateTickState(scene.board, emptyPowerMap, { context: scene.context })
      const channels = blockAt(state.blockPower, positionKey('overworld', block))

      expect(channels).toStrictEqual(expected)
      expect(powerAt(state.power, positionKey('overworld', position(1, 1, 0)))).toBe(
        Math.max(expected.strongLevel, expected.weakLevel),
      )
    }
  })

  it('strongly powers above a torch and weakly powers conductive side blocks except its support', () => {
    // This catches torch support latching and missing strong-versus-weak face output.
    const support = position(0, -1, 0)
    const above = position(0, 1, 0)
    const east = position(1, 0, 0)
    const scene = fixture(
      [cell('torch', 0, 0, 0, {
        invertedBy: positionKey('overworld', support),
        strongPowerTo: positionKey('overworld', above),
      })],
      [support, above, east],
    )
    const state = propagateTickState(scene.board, emptyPowerMap, { context: scene.context })

    expect(blockAt(state.blockPower, positionKey('overworld', above))).toStrictEqual({ strongLevel: 15, weakLevel: 0 })
    expect(blockAt(state.blockPower, positionKey('overworld', east))).toStrictEqual({ strongLevel: 0, weakLevel: 15 })
    expect(state.blockPower.has(positionKey('overworld', support))).toBe(false)
    expect(scene.queryCounts.has(positionKey('overworld', support))).toBe(false)
  })

  it('does not let a weakly powered block energize dust', () => {
    // This catches weak block power being incorrectly treated as strong dust input.
    const firstBlock = position(1, 0, 0)
    const scene = fixture([
      cell('lever', -1, 0, 0, { active: true }),
      cell('wire', 0, 0, 0),
      cell('wire', 2, 0, 0),
    ], [firstBlock])
    const state = propagateTickState(scene.board, emptyPowerMap, { context: scene.context })

    expect(powerAt(state.power, positionKey('overworld', position(0, 0, 0)))).toBe(15)
    expect(powerAt(state.power, positionKey('overworld', position(2, 0, 0)))).toBe(0)
    expect(blockAt(state.blockPower, positionKey('overworld', firstBlock))).toStrictEqual({ strongLevel: 0, weakLevel: 15 })
  })

  it('does not conduct through a false host lookup result', () => {
    // This catches air or a non-conductive block being accepted as a power bridge.
    const middle = position(1, 0, 0)
    const scene = fixture([
      cell('lever', 0, 0, 0, { active: true, strongPowerTo: positionKey('overworld', middle) }),
      cell('wire', 2, 0, 0),
    ], [])
    const state = propagateTickState(scene.board, emptyPowerMap, { context: scene.context })

    expect(state.blockPower.size).toBe(0)
    expect(powerAt(state.power, positionKey('overworld', position(2, 0, 0)))).toBe(0)
  })

  it('never queries a diagonal position', () => {
    // This catches geometry that treats edge-touching cells as redstone neighbours.
    const east = position(1, 0, 0)
    const diagonal = position(1, 1, 0)
    const scene = fixture([
      cell('lever', 0, 0, 0, { active: true, strongPowerTo: positionKey('overworld', east) }),
      cell('wire', 1, 1, 0),
    ], [diagonal])
    const state = propagateTickState(scene.board, emptyPowerMap, { context: scene.context })

    expect(scene.queryCounts.has(positionKey('overworld', diagonal))).toBe(false)
    expect(powerAt(state.power, positionKey('overworld', diagonal))).toBe(0)
  })

  it('does not power a block beyond the source face', () => {
    // This catches a source target being followed recursively through another solid block.
    const first = position(1, 0, 0)
    const second = position(2, 0, 0)
    const scene = fixture([
      cell('lever', 0, 0, 0, { active: true, strongPowerTo: positionKey('overworld', second) }),
    ], [first, second])
    const state = propagateTickState(scene.board, emptyPowerMap, { context: scene.context })

    expect(state.blockPower.size).toBe(0)
    expect(scene.queryCounts.has(positionKey('overworld', second))).toBe(false)
  })

  it('does not let a powered block power another solid block', () => {
    // This catches solid blocks being treated as recursively conducting graph nodes.
    const first = position(1, 0, 0)
    const second = position(2, 0, 0)
    const scene = fixture([
      cell('lever', 0, 0, 0, { active: true, strongPowerTo: positionKey('overworld', first) }),
      cell('wire', 3, 0, 0),
    ], [first, second])
    const state = propagateTickState(scene.board, emptyPowerMap, { context: scene.context })

    expect(state.blockPower.has(positionKey('overworld', first))).toBe(true)
    expect(state.blockPower.has(positionKey('overworld', second))).toBe(false)
    expect(powerAt(state.power, positionKey('overworld', position(3, 0, 0)))).toBe(0)
  })

  it('isolates identical coordinates across dimensions', () => {
    // This catches a position-key cache that forgets the dimension during host lookups.
    const overworldBlock = position(1, 0, 0)
    const scene = fixture([
      cell('lever', 0, 0, 0, { active: true, strongPowerTo: positionKey('overworld', overworldBlock) }),
      cell('wire', 2, 0, 0, {}, 'nether'),
    ], [{ dimension: 'overworld', position: overworldBlock }])
    const state = propagateTickState(scene.board, emptyPowerMap, { context: scene.context })

    expect(state.blockPower.has(positionKey('overworld', overworldBlock))).toBe(true)
    expect(state.blockPower.has(positionKey('nether', overworldBlock))).toBe(false)
    expect(powerAt(state.power, positionKey('nether', position(2, 0, 0)))).toBe(0)
  })

  it('preserves component-only behavior when the conductivity context is omitted', () => {
    // This catches old callers accidentally gaining conduction from an unspecified world lookup.
    const middle = position(1, 0, 0)
    const cells = [
      cell('lever', 0, 0, 0, { active: true, strongPowerTo: positionKey('overworld', middle) }),
      cell('wire', 2, 0, 0),
    ]
    const scene = fixture(cells, [middle])
    const state = propagateTickState(scene.board, emptyPowerMap)

    expect(state.blockPower.size).toBe(0)
    expect(powerAt(state.power, positionKey('overworld', position(2, 0, 0)))).toBe(0)
  })

  it('memoizes lookups and stays within six positions per powered source or wire node', () => {
    // This catches repeated host reads when tied provenance requeues a powered node.
    const conductive = position(0, -1, 0)
    const cells = [
      cell('lever', -1, 0, 0, { active: true }),
      cell('lever', 1, 0, 0, { active: true }),
      cell('wire', 0, 0, 0),
      cell('wire', 0, 0, 1),
    ]
    const scene = fixture(cells, [conductive])
    const state = propagateTickWithProvenance(scene.board, emptyPowerMap, { context: scene.context })
    const poweredEmitters = cells.filter(({ component, key }) =>
      (component.kind === 'wire' || component.kind === 'lever') && powerAt(state.power, key) > NO_POWER,
    ).length

    expect(poweredEmitters).toBeGreaterThan(0)
    expect([...scene.queryCounts.values()].every((count) => count === 1)).toBe(true)
    expect(scene.queryCounts.size).toBeLessThanOrEqual(6 * poweredEmitters)
  })

  it('keeps ordinary state free of provenance data', () => {
    // This catches provenance structures leaking into ordinary propagation results.
    const block = position(1, 0, 0)
    const scene = fixture([
      cell('lever', 0, 0, 0, { active: true, strongPowerTo: positionKey('overworld', block) }),
    ], [block])
    const state = propagateTickState(scene.board, emptyPowerMap, { context: scene.context })

    expect(Object.hasOwn(state, 'provenance')).toBe(false)
    expect(Object.keys(state).sort()).toStrictEqual(['blockPower', 'power'])
  })
})
