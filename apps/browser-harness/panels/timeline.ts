import type { DebugPanel, PanelFrame } from '../panel-contract.js'
import type { RedstoneTickObservation } from '../../../src/application/world-runtime.js'
import { redstoneNodeId } from '../../../src/application/world-runtime.js'
import type { PositionKey } from '../../../src/domain/position-key.js'

const TITLE = 'Timeline and frame'
const TAPE_WINDOW = 20

type TextRow = {
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

const positionLabelsFor = (
  frame: PanelFrame,
  previous: RedstoneTickObservation | undefined,
  current: RedstoneTickObservation | undefined,
): Map<PositionKey, string> => {
  const labels = new Map<PositionKey, string>()
  for (const sample of [previous, current]) {
    if (sample === undefined) {
      continue
    }
    for (const [dimension, components] of sample.dimensions) {
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

const diffText = (
  previous: RedstoneTickObservation,
  current: RedstoneTickObservation,
  labels: ReadonlyMap<PositionKey, string>,
): string => {
  let text = ''
  for (const [key, currentPower] of current.power) {
    const previousPower = previous.power.get(key)
    if (previousPower !== undefined && previousPower === currentPower) {
      continue
    }
    if (text.length > 0) {
      text += '; '
    }
    const label = labels.get(key) ?? 'cell unavailable in recorded dimensions'
    text += `${label}: ${previousPower === undefined ? 'absent' : previousPower} → ${currentPower}`
  }
  for (const [key, previousPower] of previous.power) {
    if (current.power.has(key)) {
      continue
    }
    if (text.length > 0) {
      text += '; '
    }
    const label = labels.get(key) ?? 'cell unavailable in recorded dimensions'
    text += `${label}: ${previousPower} → absent`
  }
  const difference = text.length === 0 ? 'no power-map changes recorded' : text
  return `Tick ${previous.tick} → ${current.tick}: ${difference}`
}

const tapeText = (
  sample: RedstoneTickObservation,
  labels: ReadonlyMap<PositionKey, string>,
): string => {
  let text = `Tick ${sample.tick}: `
  let count = 0
  for (const [key, power] of sample.power) {
    if (count > 0) {
      text += '; '
    }
    text += `${labels.get(key) ?? 'cell unavailable in recorded dimensions'} ${power}`
    count += 1
  }
  if (count === 0) {
    text += 'no power-map entries recorded'
  }
  return text
}

export const timelinePanel: DebugPanel = {
  id: 'timeline',
  title: TITLE,
  mount(root) {
    const container = document.createElement('div')
    const heading = document.createElement('h2')
    heading.textContent = TITLE
    const tick = document.createElement('p')
    tick.textContent = 'Redstone tick: awaiting frame.'
    const accumulator = document.createElement('p')
    accumulator.textContent = 'Frame tick accumulator: awaiting frame.'
    const stageMetrics = document.createElement('p')
    stageMetrics.textContent = 'Frame stage metrics: awaiting frame.'

    const diffHeading = document.createElement('h3')
    diffHeading.textContent = 'One-tick power diff'
    const diffBlocked = document.createElement('p')
    diffBlocked.textContent = 'Blocked: two recorded ticks are required to compare power maps.'
    const diffs = document.createElement('ul')
    diffs.setAttribute('aria-label', 'One-tick power differences')
    diffs.hidden = true

    const tapeHeading = document.createElement('h3')
    tapeHeading.textContent = 'Recorded power tape (latest 20 ticks)'
    const tapeStatus = document.createElement('p')
    tapeStatus.textContent = 'No recorded ticks are available.'
    const tape = document.createElement('ul')
    tape.setAttribute('aria-label', 'Recorded power by tick')
    tape.hidden = true

    const stageGaps = document.createElement('ul')
    stageGaps.setAttribute('aria-label', 'Unavailable frame diagnostics')
    const stageGapLabels = [
      'Settle state and play speed: blocked because PanelFrame has no settle or speed fields.',
      'Convergence and oscillation period: blocked because PanelFrame has no cycle-analysis result.',
      'Rewind: blocked because PanelFrame exposes read-only history but no restore operation.',
    ]
    for (const label of stageGapLabels) {
      const item = document.createElement('li')
      item.textContent = label
      stageGaps.append(item)
    }

    const jsonHeading = document.createElement('h3')
    jsonHeading.textContent = 'JSON state'
    const jsonButton = document.createElement('button')
    jsonButton.type = 'button'
    jsonButton.textContent = 'Show JSON state'
    const jsonState = document.createElement('pre')
    jsonState.textContent = 'Choose Show JSON state to view the current observation.'
    const jsonGap = document.createElement('p')
    jsonGap.textContent = 'JSON export/import: blocked because PanelFrame has no serialized fixture/export field or import operation.'

    container.append(
      heading,
      tick,
      accumulator,
      stageMetrics,
      diffHeading,
      diffBlocked,
      diffs,
      tapeHeading,
      tapeStatus,
      tape,
      stageGaps,
      jsonHeading,
      jsonButton,
      jsonState,
      jsonGap,
    )
    root.append(container)

    const diffRows = new Map<number, TextRow>()
    const tapeRows = new Map<number, TextRow>()
    let diffGeneration = 0
    let tapeGeneration = 0
    let currentFrame: PanelFrame | undefined = undefined

    const updateRows = (
      list: HTMLUListElement,
      rows: Map<number, TextRow>,
      index: number,
      text: string,
      generation: number,
    ): void => {
      let row = rows.get(index)
      if (row === undefined) {
        const item = document.createElement('li')
        list.append(item)
        row = { item, text: '', generation }
        rows.set(index, row)
      }
      row.generation = generation
      if (row.text !== text) {
        setText(row.item, text)
        row.text = text
      }
    }

    const removeStaleRows = (rows: Map<number, TextRow>, generation: number): void => {
      for (const [index, row] of rows) {
        if (row.generation !== generation) {
          row.item.remove()
          rows.delete(index)
        }
      }
    }

    const renderJson = (): void => {
      if (currentFrame === undefined) {
        setText(jsonState, 'Blocked: no PanelFrame has been received.')
        return
      }
      const state = JSON.stringify({
        scenario: {
          id: currentFrame.scenario.id,
          title: currentFrame.scenario.displayName,
        },
        tick: currentFrame.tick,
        observation: currentFrame.observation ?? null,
        stage: currentFrame.stage,
      }, null, 2)
      setText(jsonState, state ?? '{}')
    }

    jsonButton.addEventListener('click', renderJson)

    const update = (frame: PanelFrame): void => {
      currentFrame = frame
      setText(tick, `Redstone tick: ${frame.tick}`)
      const accumulatorSecs = frame.stage.tickAccumulatorSecs
      const accumulatorText = typeof accumulatorSecs === 'number'
        ? `${accumulatorSecs} seconds`
        : `unavailable: ${accumulatorSecs.unavailable}`
      setText(accumulator, `Frame tick accumulator: ${accumulatorText}`)
      const consumedTicks = frame.stage.consumedTicks
      const consumedTicksText = typeof consumedTicks === 'number'
        ? `${consumedTicks}`
        : `unavailable: ${consumedTicks.unavailable}`
      const discardedTicks = frame.stage.discardedTicks
      const discardedTicksText = typeof discardedTicks === 'number'
        ? `${discardedTicks}`
        : `unavailable: ${discardedTicks.unavailable}`
      setText(
        stageMetrics,
        `Frame stage: consumed ticks ${consumedTicksText}; max ticks per frame ${frame.stage.maxTicksPerFrame}; tick duration ${frame.stage.tickDurationSecs} seconds; discarded ticks ${discardedTicksText}`,
      )

      const current = frame.history[frame.history.length - 1]
      const previous = frame.history[frame.history.length - 2]
      if (current === undefined || previous === undefined) {
        setHidden(diffBlocked, false)
        setHidden(diffs, true)
        setText(diffBlocked, `Blocked: two recorded ticks are required; PanelFrame.history contains ${frame.history.length}.`)
        diffGeneration += 1
        removeStaleRows(diffRows, diffGeneration)
      } else {
        setHidden(diffBlocked, true)
        setHidden(diffs, false)
        diffGeneration += 1
        const labels = positionLabelsFor(frame, previous, current)
        const changes = diffText(previous, current, labels)
        updateRows(diffs, diffRows, 0, changes, diffGeneration)
        removeStaleRows(diffRows, diffGeneration)
      }

      if (frame.history.length === 0) {
        setHidden(tapeStatus, false)
        setHidden(tape, true)
        setText(tapeStatus, 'Blocked: PanelFrame.history is empty; no tick tape is available.')
        tapeGeneration += 1
        removeStaleRows(tapeRows, tapeGeneration)
      } else {
        setHidden(tapeStatus, true)
        setHidden(tape, false)
        tapeGeneration += 1
        const labels = positionLabelsFor(frame, previous, current)
        const firstIndex = Math.max(0, frame.history.length - TAPE_WINDOW)
        for (let index = firstIndex; index < frame.history.length; index += 1) {
          const sample = frame.history[index]
          if (sample !== undefined) {
            updateRows(tape, tapeRows, sample.tick, tapeText(sample, labels), tapeGeneration)
          }
        }
        removeStaleRows(tapeRows, tapeGeneration)
      }
    }

    return {
      update,
      dispose() {
        jsonButton.removeEventListener('click', renderJson)
        container.remove()
        diffRows.clear()
        tapeRows.clear()
      },
    }
  },
}
