import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import * as fc from 'fast-check'
import {
  emptyPowerMap,
  appendTiedComponentPower,
  visitPoweredQueueEntries,
  propagateTick,
  propagateTickWithProvenance,
  type CircuitBoard,
  type Component,
  type PowerProvenanceCandidate,
  type PowerTickContext,
} from '../src/domain/power-graph'

const line = (cells: ReadonlyArray<readonly [string, Component]>): CircuitBoard => {
  const components = new Map(cells)
  const adjacency = new Map<string, Array<string>>()

  for (const [index, [key]] of cells.entries()) {
    const neighbours: Array<string> = []
    const before = cells[index - 1]
    const after = cells[index + 1]
    if (before !== undefined) neighbours.push(before[0])
    if (after !== undefined) neighbours.push(after[0])
    adjacency.set(key, neighbours)
  }

  return { components, adjacency }
}

const graph = (
  cells: ReadonlyArray<readonly [string, Component]>,
  edges: ReadonlyArray<readonly [string, string]>,
): CircuitBoard => {
  const adjacency = new Map<string, Array<string>>(cells.map(([key]) => [key, []]))
  for (const [from, to] of edges) {
    adjacency.get(from)?.push(to)
    adjacency.get(to)?.push(from)
  }
  return { components: new Map(cells), adjacency }
}

const candidateAt = (
  board: ReturnType<typeof propagateTickWithProvenance>,
  key: string,
  source: string,
): PowerProvenanceCandidate | undefined =>
  board.provenance.get(key)?.find((candidate) => candidate.source === source)

const sortedPower = (power: ReadonlyMap<string, number>): ReadonlyArray<readonly [string, number]> =>
  [...power].sort(([left], [right]) => left.localeCompare(right))

const PROPERTY_RUN_COUNT = 100

describe('power propagation provenance', () => {
  it.effect('ignores a queued component whose power entry was removed', () =>
    Effect.sync(() => {
      const visited: Array<readonly [string, number]> = []

      // BUG: a stale queue key must not propagate after its current power entry is gone.
      visitPoweredQueueEntries({
        context: null,
        power: new Map([['powered-wire', 8]]),
        queue: ['powered-wire', 'removed-wire'],
        visit: (_context, key, level) => visited.push([key, level]),
      })
      expect(visited).toStrictEqual([['powered-wire', 8]])
    }),
  )

  it.effect('starts tied provenance when the component list is empty', () =>
    Effect.sync(() => {
      const source: PowerProvenanceCandidate = {
        attenuation: 0,
        predecessor: null,
        source: 'source',
        sourceLevel: 15,
      }
      const provenance = new Map<string, ReadonlyArray<PowerProvenanceCandidate>>()
      const queue: Array<string> = []

      // BUG: a tied source must be recorded even when the receiver has no provenance entry yet.
      appendTiedComponentPower({
        attenuation: 0,
        incomingCandidates: [source],
        key: 'wire',
        predecessor: 'source',
        provenance,
        queue,
      })

      expect(provenance.get('wire')).toStrictEqual([{
        attenuation: 0,
        predecessor: 'source',
        source: 'source',
        sourceLevel: 15,
      }])
      expect(queue).toStrictEqual(['wire'])
    }),
  )

  it.effect('matches ordinary power for generated source and wire boards', () =>
    Effect.sync(() => {
      const boardArbitrary = fc
        .record({
          initialLevel: fc.integer({ min: 1, max: 15 }),
          cells: fc.array(
            fc.tuple(fc.integer({ min: 0, max: 2 }), fc.boolean(), fc.integer({ min: 1, max: 15 })),
            { minLength: 1, maxLength: 24 },
          ),
        })
        .map(({ initialLevel, cells }) =>
          line([
            ['initial-source', { kind: 'lever', active: true, emits: initialLevel }],
            ...cells.map(([kind, active, emits], index): readonly [string, Component] => {
              const key = `cell-${String(index)}`
              if (kind === 0) return [key, { kind: 'wire' }]
              if (kind === 1) return [key, { kind: 'lamp' }]
              return [key, { kind: 'lever', active, emits }]
            }),
          ]),
        )

      // This fails if provenance capture changes the power map for any generated circuit.
      fc.assert(
        fc.property(boardArbitrary, (board) => {
          const ordinary = propagateTick(board, emptyPowerMap)
          const observed = propagateTickWithProvenance(board, emptyPowerMap)
          expect(sortedPower(observed.power)).toStrictEqual(sortedPower(ordinary))
        }),
        { numRuns: PROPERTY_RUN_COUNT },
      )
    }),
  )

  it.effect('records wire attenuation and predecessor links', () =>
    Effect.sync(() => {
      const board = line([
        ['lever', { kind: 'lever', active: true }],
        ['wire-0', { kind: 'wire' }],
        ['wire-1', { kind: 'wire' }],
        ['wire-2', { kind: 'wire' }],
        ['wire-3', { kind: 'wire' }],
      ])
      const result = propagateTickWithProvenance(board, emptyPowerMap)

      // This fails if a wire hop is omitted from the predecessor chain or decay count.
      expect(candidateAt(result, 'wire-3', 'lever')).toStrictEqual({
        source: 'lever',
        predecessor: 'wire-2',
        sourceLevel: 15,
        attenuation: 3,
      })
      expect(candidateAt(result, 'wire-2', 'lever')).toStrictEqual({
        source: 'lever',
        predecessor: 'wire-1',
        sourceLevel: 15,
        attenuation: 2,
      })
    }),
  )

  it.effect('returns all strongest tied sources through downstream cells', () =>
    Effect.sync(() => {
      const board = graph(
        [
          ['strong-source', { kind: 'lever', active: true, emits: 15 }],
          ['strong-wire-0', { kind: 'wire' }],
          ['strong-wire-1', { kind: 'wire' }],
          ['alternate-wire-0', { kind: 'wire' }],
          ['alternate-wire-1', { kind: 'wire' }],
          ['merge', { kind: 'wire' }],
          ['after', { kind: 'wire' }],
          ['weak-source', { kind: 'lever', active: true, emits: 13 }],
        ],
        [
          ['strong-source', 'strong-wire-0'],
          ['strong-wire-0', 'strong-wire-1'],
          ['strong-wire-1', 'merge'],
          ['strong-source', 'alternate-wire-0'],
          ['alternate-wire-0', 'alternate-wire-1'],
          ['alternate-wire-1', 'merge'],
          ['merge', 'after'],
          ['weak-source', 'merge'],
        ],
      )
      const result = propagateTickWithProvenance(board, emptyPowerMap)
      const candidates = result.provenance.get('after') ?? []

      // This fails if a later equal source is dropped or is not propagated past the merge.
      expect(result.power.get('after')).toBe(12)
      expect(candidates.map(({ source }) => source).sort()).toStrictEqual([
        'strong-source',
        'weak-source',
      ])
      expect(candidates).toHaveLength(2)
      expect(candidateAt(result, 'after', 'strong-source')).toStrictEqual({
        source: 'strong-source',
        predecessor: 'merge',
        sourceLevel: 15,
        attenuation: 3,
      })
      expect(candidateAt(result, 'after', 'weak-source')).toStrictEqual({
        source: 'weak-source',
        predecessor: 'merge',
        sourceLevel: 13,
        attenuation: 1,
      })
    }),
  )

  it.effect('retains tied source provenance through separate conductive blocks', () =>
    Effect.sync(() => {
      const board: CircuitBoard = {
        adjacency: new Map([
          ['left-source', []],
          ['right-source', []],
          ['dust', ['after']],
          ['after', ['dust']],
        ]),
        components: new Map([
          ['left-source', { active: true, kind: 'lever', strongPowerTo: 'left-block' }],
          ['right-source', { active: true, kind: 'lever', strongPowerTo: 'right-block' }],
          ['dust', { kind: 'wire' }],
          ['after', { kind: 'wire' }],
        ]),
      }
      const faceNeighbours = new Map<string, ReadonlyArray<string>>([
        ['left-source', ['left-block']],
        ['right-source', ['right-block']],
        ['left-block', ['left-source', 'dust']],
        ['right-block', ['right-source', 'dust']],
        ['dust', ['left-block', 'right-block', 'after']],
        ['after', ['dust']],
      ])
      const context: PowerTickContext = {
        faceNeighboursOf: (key) => faceNeighbours.get(key) ?? [],
        isRedstoneConductiveAt: (key) => key === 'left-block' || key === 'right-block',
      }
      const result = propagateTickWithProvenance(board, emptyPowerMap, { context })

      // This fails if a conductive block drops a tied source or replaces its predecessor with the source.
      expect(result.power.get('dust')).toBe(15)
      expect(result.blockPower.get('left-block')).toStrictEqual({ strongLevel: 15, weakLevel: 15 })
      expect(result.blockPower.get('right-block')).toStrictEqual({ strongLevel: 15, weakLevel: 15 })
      expect(result.provenance.get('dust')?.map(({ source }) => source).sort()).toStrictEqual([
        'left-source',
        'right-source',
      ])
      expect(candidateAt(result, 'dust', 'left-source')).toStrictEqual({
        source: 'left-source',
        predecessor: 'left-block',
        sourceLevel: 15,
        attenuation: 0,
      })
      expect(candidateAt(result, 'dust', 'right-source')).toStrictEqual({
        source: 'right-source',
        predecessor: 'right-block',
        sourceLevel: 15,
        attenuation: 0,
      })
      expect(candidateAt(result, 'after', 'left-source')).toStrictEqual({
        source: 'left-source',
        predecessor: 'dust',
        sourceLevel: 15,
        attenuation: 1,
      })
    }),
  )

  it.effect('deduplicates the same source arriving at one block by separate wire routes', () =>
    Effect.sync(() => {
      const board: CircuitBoard = {
        adjacency: new Map([
          ['lever', ['left-wire', 'right-wire']],
          ['left-wire', ['lever']],
          ['right-wire', ['lever']],
          ['lamp', []],
        ]),
        components: new Map([
          ['lever', { active: true, kind: 'lever' }],
          ['left-wire', { kind: 'wire' }],
          ['right-wire', { kind: 'wire' }],
          ['lamp', { kind: 'lamp' }],
        ]),
      }
      const faceNeighbours = new Map<string, ReadonlyArray<string>>([
        ['lever', ['left-wire', 'right-wire']],
        ['left-wire', ['lever', 'block']],
        ['right-wire', ['lever', 'block']],
        ['block', ['left-wire', 'right-wire', 'lamp']],
        ['lamp', ['block']],
      ])
      const context: PowerTickContext = {
        faceNeighboursOf: (key) => faceNeighbours.get(key) ?? [],
        isRedstoneConductiveAt: (key) => key === 'block',
      }
      const result = propagateTickWithProvenance(board, emptyPowerMap, { context })

      // BUG: the same source reaching one block by two routes must remain one block provenance candidate.
      expect(result.blockPower.get('block')).toStrictEqual({ strongLevel: 0, weakLevel: 15 })
      expect(result.provenance.get('lamp')?.map(({ source }) => source)).toStrictEqual(['lever'])
    }),
  )

  it.effect('requeues a block when a second strong source ties its channel', () =>
    Effect.sync(() => {
      // This catches tied block sources failing to requeue adjacent components with the new provenance.
      const board: CircuitBoard = {
        adjacency: new Map([['left-source', []], ['right-source', []], ['lamp', []]]),
        components: new Map([
          ['left-source', { active: true, kind: 'lever', strongPowerTo: 'block' }],
          ['right-source', { active: true, kind: 'lever', strongPowerTo: 'block' }],
          ['lamp', { kind: 'lamp' }],
        ]),
      }
      const faceNeighbours = new Map<string, ReadonlyArray<string>>([
        ['left-source', ['block']],
        ['right-source', ['block']],
        ['block', ['lamp']],
      ])
      const context: PowerTickContext = {
        faceNeighboursOf: (key) => faceNeighbours.get(key) ?? [],
        isRedstoneConductiveAt: (key) => key === 'block',
      }
      const result = propagateTickWithProvenance(board, emptyPowerMap, { context })

      expect(result.blockPower.get('block')).toStrictEqual({ strongLevel: 15, weakLevel: 0 })
      expect(result.power.get('lamp')).toBe(15)
      expect(result.provenance.get('lamp')?.map(({ source }) => source).sort()).toStrictEqual([
        'left-source',
        'right-source',
      ])
      expect(candidateAt(result, 'lamp', 'left-source')).toMatchObject({
        predecessor: 'block',
        sourceLevel: 15,
        attenuation: 0,
      })
      expect(candidateAt(result, 'lamp', 'right-source')).toMatchObject({
        predecessor: 'block',
        sourceLevel: 15,
        attenuation: 0,
      })
    }),
  )

  it.effect('retains weak-channel ties from multiple dust sources', () =>
    Effect.sync(() => {
      // This catches a tied weak channel replacing an earlier wire source instead of joining it.
      const board: CircuitBoard = {
        adjacency: new Map([
          ['left-source', ['left-dust']],
          ['left-dust', ['left-source']],
          ['right-source', ['right-dust']],
          ['right-dust', ['right-source']],
          ['lamp', []],
        ]),
        components: new Map([
          ['left-source', { active: true, kind: 'lever' }],
          ['left-dust', { kind: 'wire' }],
          ['right-source', { active: true, kind: 'lever' }],
          ['right-dust', { kind: 'wire' }],
          ['lamp', { kind: 'lamp' }],
        ]),
      }
      const faceNeighbours = new Map<string, ReadonlyArray<string>>([
        ['left-dust', ['block']],
        ['right-dust', ['block']],
        ['block', ['left-dust', 'right-dust', 'lamp']],
      ])
      const context: PowerTickContext = {
        faceNeighboursOf: (key) => faceNeighbours.get(key) ?? [],
        isRedstoneConductiveAt: (key) => key === 'block',
      }
      const result = propagateTickWithProvenance(board, emptyPowerMap, { context })

      expect(result.blockPower.get('block')).toStrictEqual({ strongLevel: 0, weakLevel: 15 })
      expect(result.power.get('lamp')).toBe(15)
      expect(result.provenance.get('lamp')?.map(({ source }) => source).sort()).toStrictEqual([
        'left-source',
        'right-source',
      ])
      expect(candidateAt(result, 'lamp', 'left-source')?.predecessor).toBe('block')
      expect(candidateAt(result, 'lamp', 'right-source')?.predecessor).toBe('block')
    }),
  )

  it.effect('combines tied source candidates when both block channels match', () =>
    Effect.sync(() => {
      // This catches equal strong and weak channels dropping one channel's provenance.
      const board: CircuitBoard = {
        adjacency: new Map([
          ['strong-source', []],
          ['weak-source', ['dust']],
          ['dust', ['weak-source']],
          ['lamp', []],
        ]),
        components: new Map([
          ['strong-source', { active: true, kind: 'lever', strongPowerTo: 'block' }],
          ['weak-source', { active: true, kind: 'lever' }],
          ['dust', { kind: 'wire' }],
          ['lamp', { kind: 'lamp' }],
        ]),
      }
      const faceNeighbours = new Map<string, ReadonlyArray<string>>([
        ['strong-source', ['block']],
        ['dust', ['block']],
        ['block', ['strong-source', 'dust', 'lamp']],
      ])
      const context: PowerTickContext = {
        faceNeighboursOf: (key) => faceNeighbours.get(key) ?? [],
        isRedstoneConductiveAt: (key) => key === 'block',
      }
      const result = propagateTickWithProvenance(board, emptyPowerMap, { context })

      expect(result.blockPower.get('block')).toStrictEqual({ strongLevel: 15, weakLevel: 15 })
      expect(result.provenance.get('lamp')?.map(({ source }) => source).sort()).toStrictEqual([
        'strong-source',
        'weak-source',
      ])
      expect(candidateAt(result, 'lamp', 'strong-source')?.predecessor).toBe('block')
      expect(candidateAt(result, 'lamp', 'weak-source')?.predecessor).toBe('block')
    }),
  )

  it.effect('keeps repeater, comparator, and torch routes within their directed outputs', () =>
    Effect.sync(() => {
      const repeaterBoard = graph(
        [
          ['rear', { kind: 'wire' }],
          ['repeater', { kind: 'repeater', inputFrom: 'rear', outputTo: 'front' }],
          ['front', { kind: 'wire' }],
          ['side', { kind: 'wire' }],
        ],
        [
          ['rear', 'repeater'],
          ['repeater', 'front'],
          ['repeater', 'side'],
        ],
      )
      const repeater = propagateTickWithProvenance(repeaterBoard, new Map([['rear', 1]]))

      const comparatorBoard = graph(
        [
          ['rear', { kind: 'wire' }],
          ['comparator', {
            kind: 'comparator',
            inputFrom: 'rear',
            sideInputs: ['side'],
            outputTo: 'front',
            mode: 'compare',
          }],
          ['front', { kind: 'wire' }],
          ['side', { kind: 'wire' }],
        ],
        [
          ['rear', 'comparator'],
          ['comparator', 'front'],
          ['comparator', 'side'],
        ],
      )
      const comparator = propagateTickWithProvenance(
        comparatorBoard,
        new Map([
          ['rear', 12],
          ['side', 5],
        ]),
      )

      const torchBoard = graph(
        [
          ['support', { kind: 'wire' }],
          ['torch', { kind: 'torch', invertedBy: 'support' }],
          ['output', { kind: 'wire' }],
        ],
        [
          ['support', 'torch'],
          ['torch', 'output'],
        ],
      )
      const litTorch = propagateTickWithProvenance(torchBoard, emptyPowerMap)
      const invertedTorch = propagateTickWithProvenance(torchBoard, new Map([['support', 15]]))

      // This fails if directed components power a forbidden neighbor or a torch ignores inversion.
      expect(candidateAt(repeater, 'front', 'repeater')).toStrictEqual({
        source: 'repeater',
        predecessor: 'repeater',
        sourceLevel: 15,
        attenuation: 0,
      })
      expect(repeater.provenance.has('rear')).toBe(false)
      expect(repeater.provenance.has('side')).toBe(false)
      expect(candidateAt(comparator, 'front', 'comparator')).toStrictEqual({
        source: 'comparator',
        predecessor: 'comparator',
        sourceLevel: 12,
        attenuation: 0,
      })
      expect(comparator.provenance.has('rear')).toBe(false)
      expect(comparator.provenance.has('side')).toBe(false)
      expect(candidateAt(litTorch, 'output', 'torch')).toStrictEqual({
        source: 'torch',
        predecessor: 'torch',
        sourceLevel: 15,
        attenuation: 0,
      })
      expect(litTorch.provenance.has('support')).toBe(false)
      expect(invertedTorch.provenance.has('output')).toBe(false)
    }),
  )
})
