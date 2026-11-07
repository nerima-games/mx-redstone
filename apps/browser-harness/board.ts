import { BlockAxis } from '@nerima-games/mc-kernel'
import type { RedstoneCellObservation, RedstoneFrameObservation } from '../../src/application/redstone-observation.js'
import type { PanelFrame } from './panel-contract.js'

type BoardView = 'top' | 'front' | 'side' | 'oblique'

type VisibleCell = {
  readonly dimension: RedstoneFrameObservation['dimensions'][number]['dimension']
  readonly observation: RedstoneCellObservation
}

type CellElements = {
  readonly group: SVGGElement
  readonly kind: SVGTextElement
  readonly power: SVGTextElement
  readonly title: SVGTitleElement
}

type BoardHandle = {
  update(frame: PanelFrame): void
  dispose(): void
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const SCENE_WIDTH = 640
const SCENE_HEIGHT = 380
const SCENE_PADDING = 64
const GRID_SPACING = 56
const CELL_RADIUS = 18
const LAYER_OFFSET = 0.28
type Projector = (x: number, y: number, z: number, layer: number) => readonly [number, number]

const projectors: Readonly<Record<BoardView, Projector>> = {
  top: (x, y, z, layer) => [x + y * layer, -z - y * layer],
  front: (x, y, z, layer) => [x + z * layer, -y + z * layer],
  side: (x, y, z, layer) => [z + x * layer, -y + x * layer],
  oblique: (x, y, z, layer) => [x - z + y * layer, (x + z) * 0.5 - y - y * layer],
}

const powerColors: ReadonlyArray<string> = [
  '#17212d', '#522d36', '#67303a', '#7b353c',
  '#8e3d3b', '#a04a39', '#b15b35', '#bf6e31',
  '#ca812e', '#d2942d', '#dba82f', '#e2bb34',
  '#e9cd3e', '#efdd52', '#f4eb70', '#fff39b',
]

const positionText = (position: RedstoneCellObservation['position']): string =>
  `${position.x}, ${position.y}, ${position.z}`

const cellKey = (cell: VisibleCell): string =>
  `${String(cell.dimension)}:${positionText(cell.observation.position)}`

const relationKey = (
  dimension: VisibleCell['dimension'],
  position: RedstoneCellObservation['position'],
): string => `${String(dimension)}:${positionText(position)}`

const svgElement = <Tag extends keyof SVGElementTagNameMap>(tag: Tag): SVGElementTagNameMap[Tag] =>
  document.createElementNS(SVG_NAMESPACE, tag)

const setText = (element: Element, value: string): void => {
  if (element.textContent !== value) {
    element.textContent = value
  }
}

const setAttribute = (element: Element, name: string, value: string): void => {
  if (element.getAttribute(name) !== value) {
    element.setAttribute(name, value)
  }
}

const sceneCellKey = (cell: VisibleCell): string => {
  const { dynamicState } = cell.observation
  return [
    cellKey(cell),
    dynamicState.inputFrom ? positionText(dynamicState.inputFrom) : '',
    dynamicState.sideInputs?.map(positionText).join(';') ?? '',
    dynamicState.invertedBy ? positionText(dynamicState.invertedBy) : '',
    dynamicState.outputTo ? positionText(dynamicState.outputTo) : '',
  ].join('|')
}

const projectedPosition = (cell: VisibleCell, view: BoardView, showAllLayers: boolean): readonly [number, number] => {
  const { x, y, z } = cell.observation.position
  const layer = showAllLayers ? LAYER_OFFSET : 0
  return projectors[view](x, y, z, layer)
}

const observedCells = (observation: RedstoneFrameObservation | undefined): ReadonlyArray<VisibleCell> => {
  if (typeof observation === 'undefined') {
    return []
  }
  return observation.dimensions.flatMap(({ cells, dimension }) =>
    cells.map((cell) => ({ dimension, observation: cell })),
  )
}

const createSvgRoot = (): SVGSVGElement => {
  const svg = svgElement('svg')
  svg.setAttribute('viewBox', `0 0 ${SCENE_WIDTH} ${SCENE_HEIGHT}`)
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', 'Top view circuit board')
  svg.classList.add('board-scene')

  const defs = svgElement('defs')
  const markers: ReadonlyArray<readonly [string, string]> = [
    ['adjacency-arrow', '#7a8999'],
    ['read-arrow', '#49c5b6'],
    ['output-arrow', '#f5b648'],
  ]
  for (const [id, color] of markers) {
    const marker = svgElement('marker')
    marker.setAttribute('id', id)
    marker.setAttribute('viewBox', '0 0 10 10')
    marker.setAttribute('refX', '8')
    marker.setAttribute('refY', '5')
    marker.setAttribute('markerWidth', '6')
    marker.setAttribute('markerHeight', '6')
    marker.setAttribute('orient', 'auto-start-reverse')
    const arrow = svgElement('path')
    arrow.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z')
    arrow.setAttribute('fill', color)
    marker.append(arrow)
    defs.append(marker)
  }
  svg.append(defs)
  return svg
}

const createCellElements = (cell: VisibleCell, point: readonly [number, number]): CellElements => {
  const group = svgElement('g')
  const { observation } = cell
  const coordinates = positionText(observation.position)
  group.classList.add('board-cell')
  group.setAttribute('data-testid', 'board-cell')
  group.setAttribute('data-cell-key', cellKey(cell))
  group.setAttribute('data-coordinate', coordinates)
  group.setAttribute('data-kind', observation.kind)
  group.setAttribute('role', 'button')
  group.setAttribute('tabindex', '0')
  group.setAttribute('aria-label', `${observation.kind} at ${coordinates}, power ${observation.power}`)
  group.setAttribute('transform', `translate(${point[0]} ${point[1]})`)

  const title = svgElement('title')
  group.append(title)
  const shape = svgElement('rect')
  shape.setAttribute('x', String(-CELL_RADIUS))
  shape.setAttribute('y', String(-CELL_RADIUS))
  shape.setAttribute('width', String(CELL_RADIUS * 2))
  shape.setAttribute('height', String(CELL_RADIUS * 2))
  shape.setAttribute('rx', '5')
  shape.classList.add('board-cell-shape')
  group.append(shape)

  const kind = svgElement('text')
  kind.setAttribute('y', '-3')
  kind.classList.add('board-cell-kind')
  group.append(kind)

  const power = svgElement('text')
  power.setAttribute('y', '11')
  power.classList.add('board-cell-power')
  group.append(power)
  return { group, kind, power, title }
}

const relationPairs = (cells: ReadonlyArray<VisibleCell>): ReadonlyArray<{
  readonly from: string
  readonly to: string
  readonly kind: string
}> => {
  const byPosition = new Map(cells.map((cell) => [cellKey(cell), cell]))
  const pairs: Array<{ from: string; to: string; kind: string }> = []
  const seen = new Set<string>()
  const add = (from: string, to: string, kind: string): void => {
    if (from === to) {
      return
    }
    const key = `${kind}:${from}>${to}`
    if (seen.has(key)) {
      return
    }
    seen.add(key)
    pairs.push({ from, to, kind })
  }

  const adjacentOffsets: ReadonlyArray<readonly [number, number, number]> = [
    [1, 0, 0], [0, 1, 0], [0, 0, 1],
  ]
  for (const cell of cells) {
    const { position } = cell.observation
    for (const [dx, dy, dz] of adjacentOffsets) {
      const neighbor = byPosition.get(relationKey(cell.dimension, {
        x: BlockAxis(position.x + dx),
        y: BlockAxis(position.y + dy),
        z: BlockAxis(position.z + dz),
      }))
      if (neighbor) {
        add(cellKey(cell), cellKey(neighbor), 'adjacency')
      }
    }

    const { dynamicState } = cell.observation
    if (dynamicState.inputFrom) {
      const source = relationKey(cell.dimension, dynamicState.inputFrom)
      if (byPosition.has(source)) {
        add(source, cellKey(cell), 'inputFrom')
      }
    }
    for (const sideInput of dynamicState.sideInputs ?? []) {
      const source = relationKey(cell.dimension, sideInput)
      if (byPosition.has(source)) {
        add(source, cellKey(cell), 'sideInputs')
      }
    }
    if (dynamicState.invertedBy) {
      const source = relationKey(cell.dimension, dynamicState.invertedBy)
      if (byPosition.has(source)) {
        add(source, cellKey(cell), 'invertedBy')
      }
    }
    if (dynamicState.outputTo) {
      const target = relationKey(cell.dimension, dynamicState.outputTo)
      if (byPosition.has(target)) {
        add(cellKey(cell), target, 'outputTo')
      }
    }
  }
  return pairs
}

const relationClass = (kind: string): string => {
  switch (kind) {
    case 'adjacency': return 'board-arrow board-arrow-adjacency'
    case 'outputTo': return 'board-arrow board-arrow-output'
    default: return 'board-arrow board-arrow-read'
  }
}

const relationMarker = (kind: string): string => {
  switch (kind) {
    case 'adjacency': return 'url(#adjacency-arrow)'
    case 'outputTo': return 'url(#output-arrow)'
    default: return 'url(#read-arrow)'
  }
}

const drawRelation = (
  layer: SVGGElement,
  relation: { readonly from: string; readonly to: string; readonly kind: string },
  points: ReadonlyMap<string, readonly [number, number]>,
): void => {
  const from = points.get(relation.from)
  const to = points.get(relation.to)
  if (!from || !to) {
    return
  }
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  const distance = Math.hypot(dx, dy)
  if (distance === 0) {
    return
  }
  const unitX = dx / distance
  const unitY = dy / distance
  const line = svgElement('line')
  line.setAttribute('x1', String(from[0] + unitX * CELL_RADIUS))
  line.setAttribute('y1', String(from[1] + unitY * CELL_RADIUS))
  line.setAttribute('x2', String(to[0] - unitX * (CELL_RADIUS + 2)))
  line.setAttribute('y2', String(to[1] - unitY * (CELL_RADIUS + 2)))
  line.setAttribute('marker-end', relationMarker(relation.kind))
  line.setAttribute('data-relation', relation.kind)
  line.classList.add(...relationClass(relation.kind).split(' '))
  const title = svgElement('title')
  title.textContent = relation.kind === 'adjacency'
    ? 'Adjacent cell direction; this is geometric adjacency, not a recomputed power path.'
    : `${relation.kind} observation relation`
  line.append(title)
  layer.append(line)
}

const renderInspector = (
  inspector: HTMLElement,
  frame: PanelFrame,
  selectedKey: string | undefined,
  leverButton: HTMLButtonElement,
): void => {
  const selection = selectedKey
    ? observedCells(frame.observation).find((cell) => cellKey(cell) === selectedKey)
    : undefined
  if (!selection) {
    setText(inspector, 'Select a cell to inspect its observed state.')
    leverButton.hidden = true
    return
  }

  const { observation } = selection
  const { dynamicState } = observation
  const facing = dynamicState.pistonFacing ?? 'not recorded'
  const relations = [
    dynamicState.inputFrom ? `inputFrom ${positionText(dynamicState.inputFrom)}` : undefined,
    dynamicState.sideInputs?.length
      ? `sideInputs ${dynamicState.sideInputs.map(positionText).join('; ')}`
      : undefined,
    dynamicState.invertedBy ? `invertedBy ${positionText(dynamicState.invertedBy)}` : undefined,
    dynamicState.outputTo ? `outputTo ${positionText(dynamicState.outputTo)}` : undefined,
  ].filter((value): value is string => typeof value !== 'undefined')
  const details = [
    `${observation.kind} at ${positionText(observation.position)}`,
    `Power: ${observation.power}`,
    `Facing: ${facing}`,
    `Read relations: ${relations.length ? relations.join(' · ') : 'none recorded'}`,
  ].join('\n')
  setText(inspector, details)
  leverButton.hidden = observation.kind !== 'lever'
}

export const mountBoard = (root: HTMLElement, onLeverToggle: () => void): BoardHandle => {
  let view: BoardView = 'top'
  let showAllLayers = false
  let selectedY = 0
  let selectedCellKey: string | undefined = undefined
  let currentFrame: PanelFrame | undefined = undefined
  let visibleSignature = ''
  let viewSignature = ''

  root.dataset['testid'] = 'board'
  root.classList.add('redstone-board')

  const toolbar = document.createElement('div')
  toolbar.className = 'board-toolbar'
  toolbar.setAttribute('aria-label', 'Board views and layers')
  const viewButtons = new Map<BoardView, HTMLButtonElement>()
  const viewNames: ReadonlyArray<readonly [BoardView, string]> = [
    ['top', 'Top view'],
    ['front', 'Front view'],
    ['side', 'Side view'],
    ['oblique', 'Oblique view'],
  ]
  toolbar.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof HTMLButtonElement)) {
      return
    }
    const nextView = viewNames.find(([viewValue]) => viewValue === target.dataset['view'])
    if (nextView === undefined) {
      return
    }
    view = nextView[0]
    for (const [buttonView, viewButton] of viewButtons) {
      viewButton.setAttribute('aria-pressed', String(buttonView === view))
    }
    render()
  })
  for (const [value, label] of viewNames) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = label
    button.setAttribute('aria-label', label)
    button.dataset['view'] = value
    button.setAttribute('aria-pressed', String(value === view))
    viewButtons.set(value, button)
    toolbar.append(button)
  }

  const sliceLabel = document.createElement('label')
  sliceLabel.className = 'board-y-slice-label'
  sliceLabel.textContent = 'Y slice'
  const sliceInput = document.createElement('input')
  sliceInput.type = 'number'
  sliceInput.value = String(selectedY)
  sliceInput.setAttribute('aria-label', 'Y slice')
  sliceInput.addEventListener('change', () => {
    const parsed = Number(sliceInput.value)
    selectedY = Number.isFinite(parsed) ? Math.trunc(parsed) : 0
    sliceInput.value = String(selectedY)
    render()
  })
  sliceLabel.append(sliceInput)
  toolbar.append(sliceLabel)

  const allLayersButton = document.createElement('button')
  allLayersButton.type = 'button'
  allLayersButton.textContent = 'All layers'
  allLayersButton.setAttribute('aria-label', 'All layers')
  allLayersButton.setAttribute('aria-pressed', 'false')
  allLayersButton.addEventListener('click', () => {
    showAllLayers = !showAllLayers
    allLayersButton.setAttribute('aria-pressed', String(showAllLayers))
    render()
  })
  toolbar.append(allLayersButton)

  const svg = createSvgRoot()
  const emptyMessage = document.createElement('p')
  emptyMessage.className = 'board-empty'
  emptyMessage.setAttribute('role', 'status')
  emptyMessage.textContent = 'No observation available.'

  const legend = document.createElement('p')
  legend.className = 'board-legend'
  legend.textContent = 'Power values come from runtime observation. Gray arrows show geometric neighbors; teal arrows show read relations; amber arrows show outputTo.'

  const inspectorHeading = document.createElement('h3')
  inspectorHeading.textContent = 'Cell inspector'
  const inspector = document.createElement('p')
  inspector.className = 'board-inspector'
  inspector.setAttribute('aria-live', 'polite')
  inspector.textContent = 'Select a cell to inspect its observed state.'
  const leverButton = document.createElement('button')
  leverButton.type = 'button'
  leverButton.textContent = 'Toggle lever'
  leverButton.setAttribute('aria-label', 'Toggle lever')
  leverButton.hidden = true
  leverButton.addEventListener('click', onLeverToggle)

  const inspectorSection = document.createElement('section')
  inspectorSection.className = 'board-inspector-panel'
  inspectorSection.setAttribute('aria-labelledby', 'board-inspector-title')
  inspectorHeading.id = 'board-inspector-title'
  inspectorSection.append(inspectorHeading, inspector, leverButton)

  root.replaceChildren(toolbar, svg, emptyMessage, legend, inspectorSection)

  const visibleCells = (): ReadonlyArray<VisibleCell> => {
    const cells = observedCells(currentFrame?.observation)
    if (showAllLayers) {
      return cells
    }
    return cells.filter(({ observation }) => observation.position.y === selectedY)
  }

  const render = (): void => {
    const cells = visibleCells()
    const signature = cells.map(sceneCellKey).join('|')
    const nextViewSignature = `${view}:${showAllLayers}:${selectedY}`
    if (signature !== visibleSignature || nextViewSignature !== viewSignature) {
      visibleSignature = signature
      viewSignature = nextViewSignature
      const projected = cells.map((cell) => ({
        cell,
        point: projectedPosition(cell, view, showAllLayers),
      }))
      const minX = Math.min(0, ...projected.map(({ point }) => point[0]))
      const maxX = Math.max(0, ...projected.map(({ point }) => point[0]))
      const minY = Math.min(0, ...projected.map(({ point }) => point[1]))
      const maxY = Math.max(0, ...projected.map(({ point }) => point[1]))
      const rangeX = Math.max(1, maxX - minX)
      const rangeY = Math.max(1, maxY - minY)
      const scale = Math.min(
        1,
        (SCENE_WIDTH - SCENE_PADDING * 2) / (rangeX * GRID_SPACING),
        (SCENE_HEIGHT - SCENE_PADDING * 2) / (rangeY * GRID_SPACING),
      )
      const centerX = (minX + maxX) / 2
      const centerY = (minY + maxY) / 2
      const points = new Map<string, readonly [number, number]>()
      const pointFor = (x: number, y: number): readonly [number, number] => [
        SCENE_WIDTH / 2 + (x - centerX) * GRID_SPACING * scale,
        SCENE_HEIGHT / 2 + (y - centerY) * GRID_SPACING * scale,
      ]
      for (const { cell, point } of projected) {
        points.set(cellKey(cell), pointFor(point[0], point[1]))
      }

      const relationLayer = svgElement('g')
      relationLayer.classList.add('board-relations')
      for (const relation of relationPairs(cells)) {
        drawRelation(relationLayer, relation, points)
      }

      const cellLayer = svgElement('g')
      cellLayer.classList.add('board-cells')
      cellLayer.addEventListener('click', (event) => {
        const target = event.target
        if (!(target instanceof Element)) {
          return
        }
        const group = target.closest('[data-testid="board-cell"]')
        if (!(group instanceof SVGGElement)) {
          return
        }
        const key = group.getAttribute('data-cell-key')
        if (key !== null) {
          selectCell(key)
        }
      })
      cellLayer.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.key !== 'Enter' && event.key !== ' ') {
          return
        }
        const target = event.target
        if (!(target instanceof Element)) {
          return
        }
        const group = target.closest('[data-testid="board-cell"]')
        if (!(group instanceof SVGGElement)) {
          return
        }
        const key = group.getAttribute('data-cell-key')
        if (key !== null) {
          event.preventDefault()
          selectCell(key)
        }
      })
      cellElements.clear()
      for (const { cell } of projected) {
        const point = points.get(cellKey(cell)) ?? [SCENE_WIDTH / 2, SCENE_HEIGHT / 2]
        const elements = createCellElements(cell, point)
        cellElements.set(cellKey(cell), elements)
        cellLayer.append(elements.group)
      }
      const defs = svg.querySelector('defs')
      if (defs) {
        svg.replaceChildren(defs, relationLayer, cellLayer)
      }
      const viewLabel = viewNames.find(([key]) => key === view)?.[1] ?? 'Top view'
      svg.setAttribute('aria-label', `${viewLabel} circuit board`)
      emptyMessage.textContent = currentFrame?.observation
        ? `No cells on y=${selectedY}. Choose All layers to show every layer.`
        : 'No observation available.'
      emptyMessage.hidden = cells.length > 0
      if (cells.length === 0) {
        svg.setAttribute('hidden', '')
      } else {
        svg.removeAttribute('hidden')
      }
    }

    for (const cell of cells) {
      const key = cellKey(cell)
      const elements = cellElements.get(key)
      if (!elements) {
        continue
      }
      const { observation } = cell
      const color = powerColors[observation.power] ?? powerColors[0] ?? '#17212d'
      const coordinates = positionText(observation.position)
      setAttribute(elements.group, 'aria-label', `${observation.kind} at ${coordinates}, power ${observation.power}`)
      setAttribute(elements.group, 'aria-pressed', String(selectedCellKey === key))
      setAttribute(elements.group, 'data-power', String(observation.power))
      const shape = elements.group.querySelector('rect')
      if (shape && shape.getAttribute('fill') !== color) {
        shape.setAttribute('fill', color)
      }
      setText(elements.kind, observation.kind)
      setText(elements.power, String(observation.power))
      setText(elements.title, `${observation.kind} at ${coordinates}; power ${observation.power}`)
    }
    if (currentFrame) {
      renderInspector(inspector, currentFrame, selectedCellKey, leverButton)
    }
  }

  const cellElements = new Map<string, CellElements>()
  const selectCell = (key: string): void => {
    selectedCellKey = key
    render()
  }

  render()
  return {
    update(frame) {
      currentFrame = frame
      render()
    },
    dispose() {
      root.replaceChildren()
      cellElements.clear()
    },
  }
}
