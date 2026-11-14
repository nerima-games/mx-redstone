import { type BrowserScenarioFixture, scenarioRegistry } from '../apps/browser-harness/scenario-registry.js'
import { type Page, expect, test } from '@playwright/test'
import type { RedstoneHostBlockType } from '../src/application/redstone-host-port.js'
import { join } from 'node:path'

const PLANNED_SCENARIO_COUNT = 23
const PLAYWRIGHT_OUTPUT_DIR = process.env['PLAYWRIGHT_OUTPUT_DIR'] ?? 'test-results'
const SINGLE_MATCH = 1
const NO_MATCHES = 0
const NO_DELAY_MS = 0
const INITIAL_FRAME = 0
const EMISSION_FRAME = 1

const POWER_COLORS: ReadonlyArray<string> = [
  '#17212d', '#522d36', '#67303a', '#7b353c',
  '#8e3d3b', '#a04a39', '#b15b35', '#bf6e31',
  '#ca812e', '#d2942d', '#dba82f', '#e2bb34',
  '#e9cd3e', '#efdd52', '#f4eb70', '#fff39b',
]

const HOST_BLOCK_KINDS: Readonly<Partial<Record<RedstoneHostBlockType, string>>> = {
  comparator: 'comparator',
  dispenser: 'dispenser',
  door: 'door',
  dropper: 'dropper',
  hopper: 'hopper',
  lever: 'lever',
  note_block: 'note-block',
  piston: 'piston',
  powered_rail: 'powered-rail',
  redstone_lamp: 'lamp',
  redstone_lamp_lit: 'lamp',
  redstone_torch: 'torch',
  redstone_wire: 'wire',
  repeater: 'repeater',
  sticky_piston: 'piston',
  stone_button: 'button',
  trapdoor: 'trapdoor',
}

const HOST_BLOCKS_WITHOUT_COMPONENT: ReadonlyArray<RedstoneHostBlockType> = [
  'chest',
  'obsidian',
  'piston_head',
  'stone',
]

type BrowserErrors = Readonly<{
  consoleErrors: Array<string>
  pageErrors: Array<string>
  assertClear(): void
}>

type ExpectedBoardCell = Readonly<{
  coordinate: string
  kind: string
  power?: number
}>

type HostFixture = Extract<BrowserScenarioFixture, { path: 'host' }>
type SnapshotFixture = Extract<BrowserScenarioFixture, { path: 'fixture-only' | 'blocked' }>
type BoardLocator = ReturnType<Page['getByTestId']>
type CellLocator = ReturnType<Page['locator']>

const captureBrowserErrors = (page: Page): BrowserErrors => {
  const consoleErrors: Array<string> = []
  const pageErrors: Array<string> = []
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text())
    }
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))
  return {
    assertClear: () => {
      expect(consoleErrors).toEqual([])
      expect(pageErrors).toEqual([])
    },
    consoleErrors,
    pageErrors,
  }
}

const coordinateText = (position: Readonly<{ x: number; y: number; z: number }>): string =>
  `${position.x}, ${position.y}, ${position.z}`

const expectedHostCells = (fixture: HostFixture): ReadonlyArray<ExpectedBoardCell> =>
  fixture.input.blocks.flatMap(({ block, position }) => {
    if (block === null) {
      return []
    }
    const kind = HOST_BLOCK_KINDS[block]
    if (typeof kind === 'string') {
      return [{ coordinate: coordinateText(position), kind }]
    }
    if (HOST_BLOCKS_WITHOUT_COMPONENT.includes(block)) {
      return []
    }
    throw new Error(`No board-cell expectation is defined for host block ${block}`)
  })

const expectCellPower = async (cell: CellLocator, expected: ExpectedBoardCell): Promise<string> => {
  const powerText = await cell.getAttribute('data-power')
  if (powerText === null) {
    throw new Error('Rendered board cell is missing its power value')
  }
  expect(powerText).toMatch(/^(?:[0-9]|1[0-5])$/)
  if (typeof expected.power === 'number') {
    expect(powerText).toBe(String(expected.power))
  }
  const fill = await cell.locator('rect').getAttribute('fill')
  expect(fill).toBe(POWER_COLORS[Number(powerText)])
  return powerText
}

const expectCellMatchesFixture = async (board: BoardLocator, expected: ExpectedBoardCell): Promise<void> => {
  const cell = board.locator(
    `[data-testid="board-cell"][data-kind="${expected.kind}"][data-coordinate="${expected.coordinate}"]`,
  )
  await expect(cell).toHaveCount(SINGLE_MATCH)
  await expect(cell).toHaveAttribute(
    'aria-label',
    new RegExp(`^${expected.kind} at ${expected.coordinate}, power (?:[0-9]|1[0-5])$`),
  )
  const powerText = await expectCellPower(cell, expected)
  await expect(cell).toContainText(expected.kind)
  await expect(cell).toContainText(powerText)
}

const expectFixtureCells = async (page: Page, expectedCells: ReadonlyArray<ExpectedBoardCell>): Promise<void> => {
  const board = page.getByTestId('board')
  await expect(board.getByTestId('board-cell')).toHaveCount(expectedCells.length)
  await Promise.all(expectedCells.map((expected) => expectCellMatchesFixture(board, expected)))
}

const expectedSnapshotCell = (
  component: SnapshotFixture['snapshot']['components'][number],
  compareEmissionPower: boolean,
): ExpectedBoardCell => {
  const expected = { coordinate: coordinateText(component.position), kind: component.kind }
  if (compareEmissionPower && 'emits' in component && typeof component.emits === 'number') {
    return { ...expected, power: component.emits }
  }
  return expected
}

const expectDynamicStateField = async (row: CellLocator, key: string, value: unknown): Promise<void> => {
  const serialized = JSON.stringify(value)
  if (typeof serialized === 'string') {
    await expect(row).toContainText(`"${key}":${serialized}`)
  }
}

const expectSnapshotComponentState = async (
  rows: BoardLocator,
  dimension: string,
  component: SnapshotFixture['snapshot']['components'][number],
): Promise<void> => {
  const { kind, position } = component
  const state = Object.fromEntries(Object.entries(component).filter(([key]) =>
    key !== 'kind'
    && key !== 'position'
    && !(kind === 'observer' && key === 'observedBlock'),
  ))
  const coordinate = `${dimension} (${coordinateText(position)})`
  const row = rows.getByRole('listitem').filter({ hasText: `${kind} @ ${coordinate}` })
  await expect(row).toHaveCount(SINGLE_MATCH)
  await Promise.all(Object.entries(state).map(([key, value]) => expectDynamicStateField(row, key, value)))
}

const expectSnapshotComponentStates = async (page: Page, fixture: SnapshotFixture): Promise<void> => {
  const rows = page.getByRole('region', { name: 'Components and decisions' })
    .getByRole('list', { name: 'Observed component state and timers' })
  await Promise.all(fixture.snapshot.components.map((component) =>
    expectSnapshotComponentState(rows, fixture.snapshot.dimension, component),
  ))
}

const expectBlockedFixture = async (page: Page, fixture: SnapshotFixture): Promise<void> => {
  const board = page.getByTestId('board')
  const components = page.getByRole('region', { name: 'Components and decisions' })
  await expect(page.getByText(`BLOCKED: ${fixture.reason}`, { exact: true })).toBeVisible()
  await expect(components).toContainText(`Scenario fixture blocked: ${fixture.reason}`)
  await expect(board.getByRole('status')).toHaveText('No observation available.')
  await expect(board.getByTestId('board-cell')).toHaveCount(NO_MATCHES)
}

const expectFixtureOnly = async (page: Page, scenarioId: string, fixture: SnapshotFixture): Promise<void> => {
  const components = page.getByRole('region', { name: 'Components and decisions' })
  const compareEmissionPower = scenarioId === 'rs.pressure-plate.occupancy'
    || scenarioId === 'rs.target.hit-strength'
  await expect(page.getByText(`MOCK: ${fixture.reason}`, { exact: true })).toBeVisible()
  await expect(components).toContainText(`Scenario fixture only: ${fixture.reason}`)
  await expectFixtureCells(page, fixture.snapshot.components.map((component) =>
    expectedSnapshotCell(component, compareEmissionPower),
  ))
  await expectSnapshotComponentStates(page, fixture)
}

const repeaterStateFragments = (fixture: HostFixture): ReadonlyArray<string> => {
  if (!fixture.input.blocks.some(({ block }) => block === 'repeater')) {
    return []
  }
  return ['"delayTicks":4', '"delayTicks":2', '"locked":true']
}

const comparatorStateFragments = (fixture: HostFixture): ReadonlyArray<string> => {
  const comparator = fixture.input.blocks.find(({ block }) => block === 'comparator')
  const fragments: Array<string> = []
  if (typeof comparator?.state?.facing === 'string') {
    fragments.push(`"facing":"${comparator.state.facing}"`)
  }
  if (typeof comparator?.state?.mode === 'string') {
    fragments.push(`"mode":"${comparator.state.mode}"`)
  }
  return fragments
}

const torchStateFragments = (fixture: HostFixture): ReadonlyArray<string> => {
  const torch = fixture.input.blocks.find(({ block }) => block === 'redstone_torch')
  if (typeof torch?.state?.lit === 'boolean') {
    return [`"active":${torch.state.lit}`]
  }
  return []
}

const hostStateFragments = (fixture: HostFixture): ReadonlyArray<string> => [
  ...repeaterStateFragments(fixture),
  ...comparatorStateFragments(fixture),
  ...torchStateFragments(fixture),
]

const expectHostRequests = async (page: Page, expected: HostFixture['expectedRequests']): Promise<void> => {
  const actual = await page.getByTestId('host-requests').textContent()
  if (actual === null) {
    throw new Error('Rendered host requests are missing')
  }
  expect(JSON.parse(actual)).toStrictEqual(expected)
}

const expectHostFixture = async (page: Page, fixture: HostFixture): Promise<void> => {
  const components = page.getByRole('region', { name: 'Components and decisions' })
  const allLayers = page.getByRole('button', { name: 'All layers' })
  await allLayers.click()
  await Promise.all([
    expect(allLayers).toHaveAttribute('aria-pressed', 'true'),
    expect(components).toContainText(
      `Scenario fixture: host; ${fixture.input.blocks.length} configured blocks; ${fixture.expectedRequests.length} expected host requests.`,
    ),
    expectFixtureCells(page, expectedHostCells(fixture)),
    expect(page.getByRole('region', { name: 'Host boundary' })).toContainText('Host apply reached.'),
  ])
  await expectHostRequests(page, fixture.expectedRequests)

  const hostState = page.getByTestId('host-realm-state')
  await Promise.all(hostStateFragments(fixture).map((fragment) => expect(hostState).toContainText(fragment)))
}


const expectScenarioFixture = async (page: Page, scenario: (typeof scenarioRegistry)[number]): Promise<void> => {
  const fixture = scenario.fixture()
  if (fixture.path === 'blocked') {
    return expectBlockedFixture(page, fixture)
  }
  if (fixture.path === 'fixture-only') {
    return expectFixtureOnly(page, scenario.id, fixture)
  }
  if (fixture.path === 'host') {
    return expectHostFixture(page, fixture)
  }
  throw new Error('Unsupported browser scenario fixture path')
}

const expectScenarioId = async (page: Page, scenarioId: string): Promise<void> => {
  await expect(page.getByLabel('Scenario')).toHaveValue(scenarioId)
  const timeline = page.getByRole('region', { name: 'Timeline and simulation ticks' })
  await timeline.getByRole('button', { name: 'Show JSON state' }).click()
  await expect(timeline.locator('pre')).toContainText(`"id": "${scenarioId}"`)
}

const expectScenarioBoard = async (page: Page): Promise<void> => {
  const board = page.getByTestId('board')
  await expect(board).toBeVisible()
  await expect(board).not.toBeEmpty()
}

const screenshotScenario = async (page: Page, scenarioId: string): Promise<void> => {
  await page.screenshot({ fullPage: true, path: join(PLAYWRIGHT_OUTPUT_DIR, `${scenarioId}.png`) })
}

const frameForScenario = (scenarioId: string): number => {
  if (scenarioId === 'rs.pressure-plate.occupancy' || scenarioId === 'rs.target.hit-strength') {
    return EMISSION_FRAME
  }
  return INITIAL_FRAME
}

const exerciseScenario = async (page: Page, scenario: (typeof scenarioRegistry)[number]): Promise<void> => {
  const errors = captureBrowserErrors(page)
  const frame = frameForScenario(scenario.id)
  await page.goto(`/?scenario=${encodeURIComponent(scenario.id)}&play=0&speed=1&panel=1&frame=${String(frame)}`)
  await expectScenarioId(page, scenario.id)
  await expectScenarioBoard(page)
  await expectScenarioFixture(page, scenario)
  await screenshotScenario(page, scenario.id)
  errors.assertClear()
}

const injectConsoleErrorAndAssert = async (page: Page, errors: BrowserErrors): Promise<void> => {
  await page.addScriptTag({ content: "console.error('injected console error')" })
  expect(errors.consoleErrors).toContain('injected console error')
  expect(() => errors.assertClear()).toThrow()
  errors.consoleErrors.length = NO_MATCHES
}

const injectPageErrorAndAssert = async (page: Page, errors: BrowserErrors): Promise<void> => {
  const pageError = page.waitForEvent('pageerror')
  await page.evaluate((delay) => {
    window.setTimeout(() => {
      throw new Error('injected page error')
    }, delay)
  }, NO_DELAY_MS)
  const observedError = await pageError
  expect(observedError.message).toBe('injected page error')
  expect(errors.pageErrors).toContain('injected page error')
  expect(() => errors.assertClear()).toThrow()
}

test.describe('registered browser scenarios', () => {
  test.describe.configure({ mode: 'default' })

  test('scenario registry contains the planned count', () => {
    // Bug it catches: a scenario is added or removed without updating the T16 sweep.
    expect(scenarioRegistry).toHaveLength(PLANNED_SCENARIO_COUNT)
  })

  for (const scenario of scenarioRegistry) {
    test(`renders registered scenario ${scenario.id}`, async ({ page }) => {
      // Bug it catches: a scenario is missing, blank, misidentified, visually mismatched to its fixture, or raises a browser error.
      await exerciseScenario(page, scenario)
    })
  }

  test('browser error assertion fails for injected console and page errors', async ({ page }) => {
    // Bug it catches: the sweep stops detecting console errors or uncaught page errors.
    const errors = captureBrowserErrors(page)
    await injectConsoleErrorAndAssert(page, errors)
    await injectPageErrorAndAssert(page, errors)
  })
})
