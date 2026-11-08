import { type Page, expect, test } from '@playwright/test'

let consoleErrors: Array<string> = []
let pageErrors: Array<string> = []
const NO_CELLS = [].length
const TWO_REPEATER_RELATIONS = 2

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
  const repeater = page.locator('[data-testid="board-cell"][data-coordinate="1, 0, 0"]')
  await expect(repeater).toHaveAttribute('data-kind', 'repeater')
  await repeater.click()
  const inspector = page.getByRole('region', { name: 'Cell inspector' })
  await expect(inspector).toContainText('repeater at 1, 0, 0')
  await expect(inspector).toContainText('inputFrom 0, 0, 0')
  await expect(inspector).toContainText('outputTo 2, 0, 0')
}

const expectRepeaterRelations = async (page: Page): Promise<void> => {
  await expect(page.locator('[data-relation="inputFrom"]')).toHaveCount(TWO_REPEATER_RELATIONS)
  await expect(page.locator('[data-relation="outputTo"]')).toHaveCount(TWO_REPEATER_RELATIONS)
  await expect(page.locator('[data-relation="adjacency"]')).not.toHaveCount(NO_CELLS)
}

const expectRawHostRepeaterState = async (page: Page): Promise<void> => {
  const host = page.getByRole('region', { name: 'Host boundary' })
  const hostState = page.getByTestId('host-realm-state')
  await Promise.all([
    expect(host).toContainText('Host apply reached.'),
    expect(page.getByTestId('host-requests')).toHaveText('[]'),
    expect(hostState).toContainText('"facing":"east"'),
    expect(hostState).toContainText('"delayTicks":4'),
    expect(hostState).toContainText('"delayTicks":2'),
    expect(hostState).toContainText('"locked":true'),
  ])
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

// Catches a raw-host repeater fixture that loses its decoded direction, lock, delay, or read relations.
test('raw-host repeater board shows facing-derived coordinates and observed relations', async ({ page }) => {
  await page.goto('/?scenario=rs.repeater.delay-lock')
  await expectRawHostRepeaterState(page)
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
