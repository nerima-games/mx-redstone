import { performance } from 'node:perf_hooks'
import type { CircuitBoard, Component, ComponentKind } from '../src/domain/power-graph'
import { advanceTimedCircuit, emptyTimedCircuitState } from '../src/domain/timed-power-graph'

const INERT_COMPONENTS = 100_000
const MEASURED_TICKS = 100

const components = new Map<string, Component>()
const adjacency = new Map<string, ReadonlyArray<string>>()
for (let index = 0; index < INERT_COMPONENTS; index += 1) {
  const key = `inert-${index}`
  components.set(key, { kind: 'lamp' })
  adjacency.set(key, [])
}
components.set('lever', { active: true, kind: 'lever' })
components.set('wire', { kind: 'wire' })
components.set('lamp', { kind: 'lamp' })
adjacency.set('lever', ['wire'])
adjacency.set('wire', ['lever', 'lamp'])
adjacency.set('lamp', ['wire'])

const oracle: CircuitBoard = { adjacency, components }
const indexed: CircuitBoard = {
  ...oracle,
  componentKeysByKind: new Map<ComponentKind, ReadonlyArray<string>>([
    ['lamp', [...Array.from({ length: INERT_COMPONENTS }, (_, index) => `inert-${index}`), 'lamp']],
    ['lever', ['lever']],
    ['wire', ['wire']],
  ]),
}

const measure = (board: CircuitBoard): number => {
  let state = emptyTimedCircuitState
  const started = performance.now()
  for (let tick = 0; tick < MEASURED_TICKS; tick += 1) {
    state = advanceTimedCircuit(board, state)
  }
  if ((state.power.get('lamp') ?? 0) <= 0) throw new Error('benchmark circuit did not power lamp')
  return performance.now() - started
}

measure(indexed)
const beforeMs = measure(oracle)
const afterMs = measure(indexed)
const speedup = beforeMs / afterMs

console.log(
  JSON.stringify({
    afterMs: Number(afterMs.toFixed(2)),
    beforeMs: Number(beforeMs.toFixed(2)),
    inertComponents: INERT_COMPONENTS,
    measuredTicks: MEASURED_TICKS,
    speedup: Number(speedup.toFixed(2)),
  }),
)
