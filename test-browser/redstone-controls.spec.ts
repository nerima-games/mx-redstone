import { type Locator, type Page, expect, test } from '@playwright/test'

declare global {
  interface Window {
    mxPendingAnimationFrames: number
    mxMaximumPendingAnimationFrames: number
  }
}

type BrowserErrorCapture = Readonly<{
  assertClear(): void
}>

type ScenarioSpeedExpectation = Readonly<{
  scenario: string
  speed: string
  panelsVisible: boolean
}>

const PAUSE_STABILITY_WAIT_MS = 250
const ONE_REDSTONE_TICK = 1
const SINGLE_PENDING_ANIMATION_FRAME = 1

const captureErrors = (page: Page): BrowserErrorCapture => {
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
  }
}

const expectScenarioAndSpeed = async (
  page: Page,
  expected: ScenarioSpeedExpectation,
): Promise<void> => {
  await expect(page.getByLabel('Scenario')).toHaveValue(expected.scenario)
  await expect(page.getByRole('button', { name: 'Speed' })).toHaveText(expected.speed)
  if (expected.panelsVisible) {
    await expect(page.getByLabel('Show panels')).toBeChecked()
  } else {
    await expect(page.getByLabel('Show panels')).not.toBeChecked()
  }
}

const expectScenarioFrame = async (page: Page, frame: string): Promise<void> => {
  await expectScenarioAndSpeed(page, {
    panelsVisible: false,
    scenario: 'rs.wire.attenuation',
    speed: '2×',
  })
  await expect(page.getByTestId('tick-count')).toHaveText(frame)
}

const expectPlaybackState = async (page: Page, playing: boolean): Promise<void> => {
  if (playing) {
    await expect(page.getByRole('button', { name: 'Pause' })).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Play' })).toBeDisabled()
    return
  }
  await expect(page.getByRole('button', { name: 'Pause' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Play' })).toBeEnabled()
}

const installAnimationFrameProbe = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const callbacks = new Map<number, number>()
    const requestFrame = window.requestAnimationFrame.bind(window)
    const cancelFrame = window.cancelAnimationFrame.bind(window)
    window.mxPendingAnimationFrames = 0
    window.mxMaximumPendingAnimationFrames = 0
    window.requestAnimationFrame = (callback) => {
      let handle = 0
      handle = requestFrame((time) => {
        callbacks.delete(handle)
        window.mxPendingAnimationFrames = callbacks.size
        callback(time)
      })
      callbacks.set(handle, handle)
      window.mxPendingAnimationFrames = callbacks.size
      window.mxMaximumPendingAnimationFrames = Math.max(
        window.mxMaximumPendingAnimationFrames,
        callbacks.size,
      )
      return handle
    }
    window.cancelAnimationFrame = (handle) => {
      callbacks.delete(handle)
      window.mxPendingAnimationFrames = callbacks.size
      cancelFrame(handle)
    }
  })
}

const expectPausedTickStable = async (page: Page, tickCount: Locator): Promise<void> => {
  const pausedAt = await tickCount.textContent()
  await page.waitForTimeout(PAUSE_STABILITY_WAIT_MS)
  await expect(tickCount).toHaveText(pausedAt ?? '')
}

const playPauseCycle = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'Play' }).click()
  await page.getByRole('button', { name: 'Pause' }).click()
}

const repeatPlayPauseCycles = async (page: Page): Promise<void> => {
  await playPauseCycle(page)
  await playPauseCycle(page)
  await playPauseCycle(page)
}

const expectPausedTickAndSingleLoop = async (
  page: Page,
  tickCount: Locator,
  errors: BrowserErrorCapture,
): Promise<void> => {
  await expectPausedTickStable(page, tickCount)
  const maximumPendingFrames = await page.evaluate(() => window.mxMaximumPendingAnimationFrames)
  expect(maximumPendingFrames).toBe(SINGLE_PENDING_ANIMATION_FRAME)
  errors.assertClear()
}

const resetAfterOneTick = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'Step frame' }).click()
  await expect(page.getByTestId('tick-count')).toHaveText(String(ONE_REDSTONE_TICK))
  await page.getByRole('button', { name: 'Reset' }).click()
}

const expectResetState = async (page: Page): Promise<void> => {
  await expect(page.getByLabel('Scenario')).toHaveValue('rs.lever.toggle')
  await expect(page.getByTestId('tick-count')).toHaveText('0')
  await expect(page).toHaveURL(/frame=0/)
  await expectPlaybackState(page, false)
}

const stepToFrameEight = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'Step frame' }).click()
  await expectScenarioFrame(page, '8')
  await expect(page).toHaveURL(/frame=8/)
}

const copyCurrentUrlSearch = async (page: Page): Promise<string> => {
  await page.getByRole('button', { name: 'Copy URL' }).click()
  const copiedUrl = await page.evaluate(() => navigator.clipboard.readText())
  const expectedSearch = new URL(page.url()).search
  expect(new URL(copiedUrl).search).toBe(expectedSearch)
  return expectedSearch
}

const reloadAndExpectFrameEight = async (page: Page, expectedSearch: string): Promise<void> => {
  await page.reload()
  await expectScenarioFrame(page, '8')
  expect(new URL(page.url()).search).toBe(expectedSearch)
}

const cycleSpeedAndExpect = async (speedButton: Locator, expected: string): Promise<void> => {
  await speedButton.click()
  await expect(speedButton).toHaveText(expected)
}

// Catches a Step frame handler that advances zero or multiple redstone ticks.
test('Step frame advances one tick and stays paused', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto('/?scenario=rs.lever.toggle&play=0&speed=1&panel=1&frame=0')
  await expect(page.getByTestId('tick-count')).toHaveText('0')
  await page.getByRole('button', { name: 'Step frame' }).click()
  await expect(page.getByTestId('tick-count')).toHaveText(String(ONE_REDSTONE_TICK))
  await expect(page).toHaveURL(/frame=1/)
  await expectPlaybackState(page, false)
  errors.assertClear()
})

// Catches a stale requestAnimationFrame loop that keeps ticking after rapid Play/Pause cycles.
test('rapid Play and Pause cycles leave the tick count stable while paused', async ({ page }) => {
  const errors = captureErrors(page)
  await installAnimationFrameProbe(page)
  await page.goto('/?scenario=rs.lever.toggle&play=0&speed=1&panel=1&frame=0')
  const tickCount = page.getByTestId('tick-count')
  await page.getByRole('button', { name: 'Play' }).click()
  await expect(tickCount).not.toHaveText('0')
  await page.getByRole('button', { name: 'Pause' }).click()
  await expectPausedTickStable(page, tickCount)
  await repeatPlayPauseCycles(page)
  await expectPausedTickAndSingleLoop(page, tickCount, errors)
})

// Catches Reset changing the selected scenario, retaining ticks, or leaving playback active.
test('Reset returns the selected scenario to frame zero while paused', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto('/?scenario=rs.lever.toggle&play=0&speed=1&panel=1&frame=0')
  await resetAfterOneTick(page)
  await expectResetState(page)
  errors.assertClear()
})

// Catches a play=1 URL that fails to start playback or a Pause action that leaves the URL stale.
test('play URL state restores playback and Pause updates the URL', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto('/?scenario=rs.lever.toggle&play=1&speed=1&panel=1&frame=0')
  await expectPlaybackState(page, true)
  await page.getByRole('button', { name: 'Pause' }).click()
  await expect(page).toHaveURL(/play=0/)
  await expectPlaybackState(page, false)
  errors.assertClear()
})

// Catches URL state that is not reproduced after reload or copied with the current tick.
test('URL state round trips through load, copy, and reload', async ({ page, context }) => {
  const errors = captureErrors(page)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/?scenario=rs.wire.attenuation&play=0&speed=2&panel=0&frame=7')
  await expectScenarioFrame(page, '7')
  await stepToFrameEight(page)
  const expectedSearch = await copyCurrentUrlSearch(page)
  await reloadAndExpectFrameEight(page, expectedSearch)
  errors.assertClear()
})

// Catches a speed control that skips, reverses, or omits supported multipliers.
test('Speed cycles through each supported multiplier', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto('/?scenario=rs.wire.attenuation&play=0&speed=1&panel=1&frame=0')
  const speedButton = page.getByRole('button', { name: 'Speed' })
  await cycleSpeedAndExpect(speedButton, '2×')
  await cycleSpeedAndExpect(speedButton, '4×')
  await cycleSpeedAndExpect(speedButton, '0.25×')
  await cycleSpeedAndExpect(speedButton, '0.5×')
  await cycleSpeedAndExpect(speedButton, '1×')
  errors.assertClear()
})

// Catches invalid URL values silently selecting a partial or impossible control state.
test('invalid URL values fall back to defaults', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto('/?scenario=&play=maybe&speed=3&panel=maybe&frame=1.5')
  await expectScenarioAndSpeed(page, {
    panelsVisible: true,
    scenario: 'rs.wire.attenuation',
    speed: '1×',
  })
  await expect(page.getByTestId('tick-count')).toHaveText('0')
  errors.assertClear()
})

// Catches unregistered scenario IDs falling through to a blank board without an explanation.
test('unknown scenario IDs show an explicit not-found state', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto('/?scenario=rs.unknown&play=0&speed=1&panel=1&frame=0')
  await expect(page.getByRole('alert')).toContainText(/not found/i)
  errors.assertClear()
})
