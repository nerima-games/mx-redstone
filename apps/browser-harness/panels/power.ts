import type { DebugPanel, PanelFrame } from '../panel-contract.js'
import { redstoneNodeId } from '../../../src/application/world-runtime.js'
import type { PositionKey } from '../../../src/domain/position-key.js'
import type { PowerProvenanceCandidate } from '../../../src/domain/power-graph.js'

const TITLE = 'Power and provenance'

type PowerRow = {
  readonly item: HTMLLIElement
  readonly swatch: HTMLSpanElement
  readonly value: HTMLSpanElement
  text: string
  background: string
  generation: number
}

type PowerTextRow = {
  readonly item: HTMLLIElement
  text: string
  generation: number
}

const setText = (node: HTMLElement, value: string): void => {
  if (node.textContent !== value) {
    node.textContent = value
  }
}

const setHidden = (node: HTMLElement, hidden: boolean): void => {
  if (node.hidden !== hidden) {
    node.hidden = hidden
  }
}

const coordinate = (
  dimension: string,
  position: Readonly<{ x: number; y: number; z: number }>,
): string => `${dimension} (${position.x}, ${position.y}, ${position.z})`

const positionLabelsFor = (frame: PanelFrame): Map<PositionKey, string> => {
  const labels = new Map<PositionKey, string>()
  const latest = frame.history[frame.history.length - 1]

  if (latest !== undefined) {
    for (const [dimension, components] of latest.dimensions) {
      for (const [key, component] of components) {
        labels.set(key, coordinate(dimension, component.position))
      }
    }
  }

  if (frame.observation !== undefined) {
    for (const { dimension, cells } of frame.observation.dimensions) {
      for (const cell of cells) {
        const key = redstoneNodeId(dimension, cell.position)
        if (!labels.has(key)) {
          labels.set(key, coordinate(dimension, cell.position))
        }
      }
    }
  }

  return labels
}

const pathFor = (
  target: PositionKey,
  candidate: PowerProvenanceCandidate,
  provenance: ReadonlyMap<PositionKey, ReadonlyArray<PowerProvenanceCandidate>>,
  positionLabels: ReadonlyMap<PositionKey, string>,
): string => {
  let key = target
  let path = positionLabels.get(key) ?? 'cell unavailable in the current observation'

  for (let step = 0; step < provenance.size; step += 1) {
    const candidates = provenance.get(key)
    if (candidates === undefined) {
      return `${path} (path blocked: no recorded predecessor data)`
    }

    let matching: PowerProvenanceCandidate | undefined = undefined
    for (const item of candidates) {
      if (item.source === candidate.source) {
        matching = item
        break
      }
    }

    if (matching === undefined) {
      return `${path} (path blocked: source candidate is absent)`
    }
    if (matching.predecessor === null) {
      return key === candidate.source
        ? path
        : `${path} (path blocked: source endpoint does not match)`
    }

    key = matching.predecessor
    path += ` ← ${positionLabels.get(key) ?? 'cell unavailable in the current observation'}`
  }

  return `${path} (path blocked: predecessor chain did not end at a source)`
}

const provenanceTextFor = (
  key: PositionKey,
  provenance: ReadonlyMap<PositionKey, ReadonlyArray<PowerProvenanceCandidate>> | undefined,
  positionLabels: ReadonlyMap<PositionKey, string>,
): string => {
  if (provenance === undefined) {
    return 'provenance blocked: PanelFrame.history is empty; no recorded source candidates are available.'
  }

  const candidates = provenance.get(key)
  if (candidates === undefined || candidates.length === 0) {
    return 'no recorded source candidates for this cell.'
  }

  let text = candidates.length > 1 ? `tie candidates (${candidates.length}): ` : 'candidate: '
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]
    if (candidate === undefined) {
      continue
    }
    if (index > 0) {
      text += '; '
    }
    const source = positionLabels.get(candidate.source) ?? 'source unavailable in the current observation'
    text += `${source}, source level ${candidate.sourceLevel}, attenuation ${candidate.attenuation}, path ${pathFor(key, candidate, provenance, positionLabels)}`
  }
  return text
}

export const powerPanel: DebugPanel = {
  id: 'power',
  title: TITLE,
  mount(root) {
    const container = document.createElement('div')
    const heading = document.createElement('h2')
    heading.textContent = TITLE
    const tick = document.createElement('p')
    tick.textContent = 'Awaiting runtime tick.'
    const previousPowerStatus = document.createElement('p')
    previousPowerStatus.textContent = 'Awaiting previous power map.'
    const previousPowerCells = document.createElement('ul')
    previousPowerCells.setAttribute('aria-label', 'Power levels before the latest stage tick')
    previousPowerCells.hidden = true
    const blocked = document.createElement('p')
    blocked.textContent = 'Awaiting runtime observation.'
    const cells = document.createElement('ul')
    cells.setAttribute('aria-label', 'Cell power levels and provenance')
    cells.hidden = true
    const limitations = document.createElement('ul')
    limitations.setAttribute('aria-label', 'Unavailable power diagnostics')

    const limitationLabels = [
      'Lamp isLit comparison: blocked because PanelFrame observations contain cell power but no lamp lit-state field.',
      'Conductivity stop points: blocked because PanelFrame has no propagation-stop diagnostic field.',
      'Vanilla 14/15 comparison: blocked because PanelFrame has no vanilla reference result.',
    ]
    for (const label of limitationLabels) {
      const item = document.createElement('li')
      item.textContent = label
      limitations.append(item)
    }

    container.append(heading, tick, previousPowerStatus, previousPowerCells, blocked, cells, limitations)
    root.append(container)

    const rows = new Map<PositionKey, PowerRow>()
    const previousRows = new Map<PositionKey, PowerTextRow>()
    let generation = 0
    let previousGeneration = 0

    const update = (frame: PanelFrame): void => {
      generation += 1
      previousGeneration += 1
      setText(tick, `Redstone tick ${frame.tick}`)
      if ('unavailable' in frame.previousPower) {
        setText(previousPowerStatus, `Previous power map unavailable: ${frame.previousPower.unavailable}`)
        setHidden(previousPowerCells, true)
        for (const [key, row] of previousRows) {
          row.item.remove()
          previousRows.delete(key)
        }
      } else {
        const positionLabels = positionLabelsFor(frame)
        setText(previousPowerStatus, frame.previousPower.size === 0
          ? 'Previous power map recorded: no power entries.'
          : `Previous power map recorded: ${frame.previousPower.size} cells.`)
        setHidden(previousPowerCells, frame.previousPower.size === 0)
        for (const [key, power] of frame.previousPower) {
          const text = `${positionLabels.get(key) ?? 'cell unavailable in the current observation'}: power ${power}`
          let row = previousRows.get(key)
          if (row === undefined) {
            const item = document.createElement('li')
            previousPowerCells.append(item)
            row = { item, text: '', generation: previousGeneration }
            previousRows.set(key, row)
          }
          row.generation = previousGeneration
          if (row.text !== text) {
            setText(row.item, text)
            row.text = text
          }
        }
        for (const [key, row] of previousRows) {
          if (row.generation !== previousGeneration) {
            row.item.remove()
            previousRows.delete(key)
          }
        }
      }

      const observation = frame.observation
      if (observation === undefined) {
        setText(blocked, 'Blocked: PanelFrame.observation is undefined; cell power is unavailable.')
        setHidden(blocked, false)
        setHidden(cells, true)
        for (const [key, row] of rows) {
          row.item.remove()
          rows.delete(key)
        }
        return
      }

      setHidden(blocked, true)
      setHidden(cells, false)
      const latest = frame.history[frame.history.length - 1]
      const positionLabels = positionLabelsFor(frame)

      for (const { dimension, cells: observedCells } of observation.dimensions) {
        for (const cell of observedCells) {
          const key = redstoneNodeId(dimension, cell.position)
          const provenance = provenanceTextFor(key, latest?.provenance, positionLabels)
          const text = `${coordinate(dimension, cell.position)} ${cell.kind}: power ${cell.power}; ${provenance}`
          let row = rows.get(key)
          if (row === undefined) {
            const item = document.createElement('li')
            const swatch = document.createElement('span')
            swatch.setAttribute('aria-hidden', 'true')
            swatch.style.display = 'inline-block'
            swatch.style.width = '1em'
            swatch.style.height = '1em'
            swatch.style.marginRight = '0.4em'
            const value = document.createElement('span')
            item.append(swatch, value)
            cells.append(item)
            row = { item, swatch, value, text: '', background: '', generation }
            rows.set(key, row)
          }

          row.generation = generation
          if (row.text !== text) {
            setText(row.value, text)
            row.text = text
          }
          const red = cell.power * 17
          const green = cell.power * 6
          const background = `rgb(${red}, ${green}, 0)`
          if (row.background !== background) {
            row.swatch.style.backgroundColor = background
            row.background = background
          }
        }
      }

      for (const [key, row] of rows) {
        if (row.generation !== generation) {
          row.item.remove()
          rows.delete(key)
        }
      }
    }

    return {
      update,
      dispose() {
        container.remove()
        rows.clear()
        previousRows.clear()
      },
    }
  },
}
