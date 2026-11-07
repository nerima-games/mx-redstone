import { type Page, expect, test } from '@playwright/test'

let consoleErrors: Array<string> = []
let pageErrors: Array<string> = []
const NO_CELLS = [].length
const ONE_RELATION = ['inputFrom'].length

const expectBlockedBoard = async (page: Page): Promise<void> => {
  await expect(page.getByText(/^BLOCKED:/)).toBeVisible()
  await expect(page.getByTestId('board-cell')).toHaveCount(NO_CELLS)
  await expect(page.getByTestId('board').getByRole('status')).toContainText('No observation available')
}

const exerciseLayerControls = async (page: Page): Promise<void> => {
  const allLayers = page.getByRole('button', { name: 'All layers' })
  await allLayers.click()
  await expect(allLayers).toHaveAttribute('aria-pressed', 'true')
  const ySlice = page.getByLabel('Y slice')
  await ySlice.fill('2')
  await ySlice.press('Enter')
  await expect(ySlice).toHaveValue('2')
}

const expectRepeaterInspector = async (page: Page): Promise<void> => {
  const repeater = page.locator('[data-testid="board-cell"][data-coordinate="0, 0, 0"]')
  await expect(repeater).toHaveAttribute('data-kind', 'repeater')
  await repeater.click()
  const inspector = page.getByRole('region', { name: 'Cell inspector' })
  await expect(inspector).toContainText('repeater at 0, 0, 0')
  await expect(inspector).toContainText('Facing: not recorded')
  await expect(inspector).toContainText('inputFrom 0, 0, 1')
  await expect(inspector).toContainText('sideInputs 1, 0, 0')
  await expect(inspector).toContainText('outputTo 0, 0, -1')
}

const expectRepeaterRelations = async (page: Page): Promise<void> => {
  await expect(page.locator('[data-relation="inputFrom"]')).toHaveCount(ONE_RELATION)
  await expect(page.locator('[data-relation="sideInputs"]')).toHaveCount(ONE_RELATION)
  await expect(page.locator('[data-relation="outputTo"]')).toHaveCount(ONE_RELATION)
  await expect(page.locator('[data-relation="adjacency"]')).not.toHaveCount(NO_CELLS)
}

test.beforeEach(async ({ page }) => {
  consoleErrors = []
  pageErrors = []
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text())
    }
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))
})

test.afterEach(() => {
  expect(consoleErrors).toEqual([])
  expect(pageErrors).toEqual([])
})

// Catches view controls that render visually but do not expose their accessible names or selected state.
test('vertical circuit scenario exposes all four accessible board views', async ({ page }) => {
  await page.goto('/?scenario=rs.world.vertical-strong-power')

  await expect(page.getByTestId('board')).toBeVisible()
  await Promise.all(['Top view', 'Front view', 'Side view', 'Oblique view'].map((view) =>
    expect(page.getByRole('button', { name: view })).toBeVisible(),
  ))
  await page.getByRole('button', { name: 'Front view' }).click()
  await expect(page.getByRole('button', { name: 'Front view' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('board')).toContainText('All layers')
})

// Catches a blocked fixture being rendered as if its unsupported vertical power result had been observed.
test('blocked vertical fixture keeps observation cells unavailable while layer controls remain usable', async ({ page }) => {
  await page.goto('/?scenario=rs.world.vertical-strong-power')
  await expectBlockedBoard(page)
  await exerciseLayerControls(page)
})

// Catches dropped coordinates, facing fields, or read relations between the registry snapshot and the board inspector.
test('fixture-only repeater board shows coordinates and observed relations', async ({ page }) => {
  await page.goto('/?scenario=rs.repeater.delay-lock')

  await expect(page.getByText(/^MOCK:/)).toBeVisible()
  await expectRepeaterInspector(page)
  await expectRepeaterRelations(page)
})

// Catches a host fixture that bypasses apply, omits the realm snapshot, reports the wrong lamp power, or loses its request.
test('lever host path reports apply completion, realm snapshot, and lamp power 14', async ({ page }) => {
  await page.goto('/?scenario=rs.lever.toggle')

  const realmResult = page.getByTestId('host-realm-state')
  await expect(realmResult).toContainText('"applyReached":true')
  await expect(realmResult).toContainText('"realmSnapshot":{"components"')
  await expect(realmResult).toContainText('"runtimeObservationAfterApply":')
  await expect(realmResult).toContainText('"kind":"lamp","position":{"x":2,"y":0,"z":0},"power":14')
  const requests = page.getByTestId('host-requests')
  await expect(requests).toContainText('"kind":"lamp"')
  await expect(requests).toContainText('"position":{"x":2,"y":0,"z":0}')
})
