import { type Page, expect, test } from '@playwright/test'
import { HOST_FAILURE_CASES } from '../apps/browser-harness/scenario-registry.js'

const INITIAL_FRAME = 0
const FIRST_FRAME = 1
const SECOND_FRAME = 2
const THIRD_FRAME = 3
const OBSERVER_PULSE_LENGTH = 2
const OBSERVER_ONE_TICK_REMAINING = 1
const NO_PULSE_REMAINING = 0
const FIRST_FAILURE_INDEX = 0
const FAILURE_INDEX_STEP = 1

type BrowserErrorCapture = Readonly<{
  assertClear(): void
}>

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

const scenarioUrl = (id: string, frame = INITIAL_FRAME): string =>
  `/?scenario=${id}&play=0&speed=1&panel=1&frame=${frame}`

const WIRE_DRAINED_EVENTS = JSON.stringify({
  hopper: [],
  lamp: [{ dimension: 'overworld', lit: true, position: { x: 15, y: 0, z: 0 } }],
  piston: [],
  powered: [],
  trigger: [],
})

const HOST_FAILURE_DRAINED_EVENTS = JSON.stringify({
  hopper: [
    { dimension: 'overworld', elapsedRedstoneTicks: 1, position: { x: 0, y: 0, z: 1 }, powered: true },
    { dimension: 'overworld', elapsedRedstoneTicks: 1, position: { x: 10, y: 0, z: 4 }, powered: false },
  ],
  lamp: [
    { dimension: 'overworld', lit: true, position: { x: 2, y: 0, z: 0 } },
    { dimension: 'overworld', lit: true, position: { x: 12, y: 0, z: 0 } },
    { dimension: 'nether', lit: true, position: { x: 11, y: 0, z: 0 } },
  ],
  piston: [
    { dimension: 'overworld', facing: 'east', kind: 'normal', piston: { x: 0, y: 0, z: -1 }, powered: true, state: 'retracted' },
    { dimension: 'overworld', facing: 'east', kind: 'normal', piston: { x: 10, y: 0, z: -1 }, powered: true, state: 'retracted' },
  ],
  powered: [
    { dimension: 'overworld', kind: 'door', position: { x: -1, y: 0, z: 0 }, powered: true },
    { dimension: 'overworld', kind: 'trapdoor', position: { x: 9, y: 0, z: 0 }, powered: true },
    { dimension: 'overworld', kind: 'powered-rail', position: { x: 10, y: 0, z: 1 }, powered: true },
  ],
  trigger: [
    { dimension: 'overworld', kind: 'dispenser', position: { x: 0, y: 1, z: 0 } },
    { dimension: 'overworld', kind: 'dropper', position: { x: 10, y: 1, z: 0 } },
  ],
})

const expectWirePower = async (page: Page): Promise<void> => {
  const power = page.getByRole('region', { name: 'Power and provenance' })
  await expect(power).toContainText('overworld (1, 0, 0) wire: power 15;')
  await expect(power).toContainText('overworld (2, 0, 0) wire: power 14;')
  await expect(power).toContainText('overworld (7, 0, 0) wire: power 15;')
  await expect(power).toContainText('overworld (14, 0, 0) wire: power 8;')
}

const expectInvariantPasses = async (page: Page): Promise<void> => {
  const components = page.getByRole('region', { name: 'Components and decisions' })
  await expect(components).toContainText('power-level-range: PASS')
  await expect(components).toContainText('wire-neighbor-decay: PASS')
  await expect(components).toContainText('torch-support-exclusion: PASS')
  await expect(components).toContainText('block-power-channel-consistency: PASS')
}

const expectWireHost = async (page: Page): Promise<void> => {
  const host = page.getByRole('region', { name: 'Host boundary' })
  const realmSnapshot = host.getByText('Realm blocks to snapshot', { exact: true })
    .locator('xpath=following-sibling::dd[1]')
  await expect(realmSnapshot).toContainText('"kind":"wire"')
  await expect(host).toContainText('lamp at overworld (15, 0, 0)')
}

const expectDrainedEventBatch = async (page: Page, expected: string): Promise<void> => {
  const events = page.getByRole('region', { name: 'Events and transitions' })
  const drainedEvents = events.getByText('Event drain', { exact: true })
    .locator('xpath=following-sibling::dd[1]')
  await expect(drainedEvents).toHaveText(expected)
  const drainedText = await drainedEvents.textContent()
  expect(drainedText).not.toBeNull()
  if (drainedText !== null) {
    expect(drainedText).toMatch(/"hopper".*"lamp".*"piston".*"powered".*"trigger"/)
  }
}

const expectPistonRefusals = async (page: Page): Promise<void> => {
  const components = page.getByRole('region', { name: 'Components and decisions' })
  await expect(components).toContainText('Scenario fixture: host;')
  await expect(components).toContainText('"block":"stone","position":{"x":14,"y":0,"z":0}')
  await expect(components).toContainText('"block":"obsidian","position":{"x":14,"y":0,"z":2}')
  await expect(components).toContainText(
    'too-long: piston at overworld (1, 0, 0); blocked at overworld (14, 0, 0)',
  )
  await expect(components).toContainText(
    'too-long: piston at overworld (1, 0, 2); blocked at overworld (14, 0, 2)',
  )
  await expectInvariantPasses(page)

  const power = page.getByRole('region', { name: 'Power and provenance' })
  await expect(power).not.toContainText('overworld (1, 0, 0) wire: power 15;')
}

type ObserverPulseExpectation = Readonly<{
  tick: number
  pulseTicks: number
  active: boolean
}>

const expectObserverPulse = async (page: Page, state: ObserverPulseExpectation): Promise<void> => {
  const components = page.getByRole('region', { name: 'Components and decisions' })
  const observer = components.getByRole('list', { name: 'Observed component state and timers' })
    .locator('li')
    .filter({ hasText: 'observer @ overworld (0, 0, 0)' })
  const timeline = page.getByRole('region', { name: 'Timeline and frame' })
  await expect(timeline).toContainText(`Redstone tick: ${state.tick}`)
  await expect(observer).toContainText(`"active":${String(state.active)}`)
  if (state.active) {
    await expect(observer).toContainText(`"pulseTicks":${state.pulseTicks}`)
  } else {
    await expect(observer).not.toContainText('"pulseTicks":2')
    await expect(observer).not.toContainText('"pulseTicks":1')
  }
}

const stepFrame = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'Step frame' }).click()
}

const expectHopperEventPower = async (page: Page): Promise<void> => {
  const events = page.getByRole('region', { name: 'Events and transitions' })
  const drainedEvents = events.getByText('Event drain', { exact: true })
    .locator('xpath=following-sibling::dd[1]')
  await expect(drainedEvents).toContainText('"position":{"x":1,"y":0,"z":0},"powered":true')
  await expect(drainedEvents).toContainText('"position":{"x":5,"y":0,"z":0},"powered":false')
}

const expectHopperContainers = async (page: Page): Promise<void> => {
  const components = page.getByRole('region', { name: 'Components and decisions' })
  await expect(components).toContainText(
    '"kind":"chest","position":{"x":5,"y":1,"z":0},"items":[{"count":1,"item":"iron_ingot"}]',
  )
  await expect(components).toContainText('"kind":"chest","position":{"x":6,"y":0,"z":0},"items":[]')
}

const expectHopperTransfer = async (page: Page): Promise<void> => {
  const components = page.getByRole('region', { name: 'Components and decisions' })
  await expect(components).toContainText('Plan results:')
  await expect(components).toContainText('"_tag":"Committed"')
  await expect(components).toContainText('"_tag":"Moved"')
  await expect(components).toContainText('"item":"iron_ingot"')
  await expect(components).toContainText('"count":1')
}

const expectHopperResults = async (page: Page): Promise<void> => {
  await expectHopperEventPower(page)
  await expectHopperContainers(page)
  await expectHopperTransfer(page)
}

const expectSelectedFailure = async (page: Page, failureTag: string): Promise<void> => {
  const host = page.getByRole('region', { name: 'Host boundary' })
  const failures = host.getByText('Host failures', { exact: true })
    .locator('xpath=following-sibling::dd[1]')
  await expect(failures).toContainText(failureTag)
  const failureText = await failures.textContent()
  expect(failureText?.match(/"_tag":"[^"]+"/g) ?? []).toStrictEqual([`"_tag":"${failureTag}"`])
}

const selectFailureCases = async (page: Page, index = FIRST_FAILURE_INDEX): Promise<void> => {
  const item = HOST_FAILURE_CASES.at(index)
  if (!item) {
    return
  }
  const diagnostics = page.getByRole('region', { name: 'Diagnostics panels' })
  const failureCase = diagnostics.getByLabel('Host failure case')
  await failureCase.selectOption(item.value)
  await expect(failureCase).toHaveValue(item.value)
  await expectSelectedFailure(page, item.failureTag)
  await selectFailureCases(page, index + FAILURE_INDEX_STEP)
}

// Catches power decay errors and missing host requests in the wire fixture.
test('wire attenuation shows observed levels and its lamp host request', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(scenarioUrl('rs.wire.attenuation', FIRST_FRAME))
  const power = page.getByRole('region', { name: 'Power and provenance' })
  await expect(power).toContainText('Previous power map recorded: no power entries.')
  await expectWirePower(page)
  await expectInvariantPasses(page)
  await expectWireHost(page)
  await expectDrainedEventBatch(page, WIRE_DRAINED_EVENTS)
  errors.assertClear()
})

// BUG: This fails if the panel loses the queued button position before the first power tick.
test('button fixture exposes its pending press before the power tick', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(scenarioUrl('rs.button.pulse'))

  const components = page.getByRole('region', { name: 'Components and decisions' })
  await expect(components).toContainText('Pending button presses: ["overworld",0,0,0]')
  await expectInvariantPasses(page)
  errors.assertClear()
})

// The caller decrements the two-tick pulse before each power stage.
test('observer pulse remains active for two ticks and clears on the third', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(scenarioUrl('rs.observer.change-pulse', FIRST_FRAME))

  await expectObserverPulse(page, { active: true, pulseTicks: OBSERVER_PULSE_LENGTH, tick: FIRST_FRAME })
  await stepFrame(page)
  await expectObserverPulse(page, { active: true, pulseTicks: OBSERVER_ONE_TICK_REMAINING, tick: SECOND_FRAME })
  await stepFrame(page)
  await expectObserverPulse(page, { active: false, pulseTicks: NO_PULSE_REMAINING, tick: THIRD_FRAME })
  errors.assertClear()
})

// BUG: This fails if the panel loses either refused piston event or its domain reason.
test('piston fixture reports event-keyed refusal reasons and invariant results', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(scenarioUrl('rs.wire.attenuation', FIRST_FRAME))
  await expectWirePower(page)
  await page.getByLabel('Scenario').selectOption('rs.piston.push-refusal')
  await expectPistonRefusals(page)
  errors.assertClear()
})

// Powered hoppers are locked; the unpowered case transfers one item.
test('hopper fixture reports the lock and a successful item transfer', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(scenarioUrl('rs.hopper.lock-transfer'))

  await expectHopperResults(page)
  errors.assertClear()
})

// Each selector option runs the matching host-port failure and renders its tagged result.
test('host failure selector exposes each typed failure result', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(scenarioUrl('rs.host.failure-injection'))

  const diagnostics = page.getByRole('region', { name: 'Diagnostics panels' })
  const failureCase = diagnostics.getByLabel('Host failure case')
  await expect(failureCase).toBeVisible()
  await expect(failureCase.locator('option')).toHaveCount(HOST_FAILURE_CASES.length)
  await expect(failureCase.locator('option')).toHaveText(HOST_FAILURE_CASES.map(({ label }) => label))
  await expectDrainedEventBatch(page, HOST_FAILURE_DRAINED_EVENTS)
  await selectFailureCases(page)

  errors.assertClear()
})

// Catches a timeline that confuses frame accumulation with redstone ticks or omits serialized state.
test('stage timeline shows tick diff, accumulator, and JSON state', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(scenarioUrl('rs.stage.frame-timeline', SECOND_FRAME))

  const timeline = page.getByRole('region', { name: 'Timeline and frame' })
  await expect(timeline).toContainText('Redstone tick: 2')
  await expect(timeline).toContainText('Frame tick accumulator: 0 seconds')
  await expect(timeline).toContainText(
    'Frame stage: consumed ticks 1; max ticks per frame 4; tick duration 0.1 seconds; discarded ticks 0',
  )
  await expect(timeline.getByRole('list', { name: 'One-tick power differences' }))
    .toContainText('Tick 1 → 2: no power-map changes recorded')
  await timeline.getByRole('button', { name: 'Show JSON state' }).click()
  await expect(timeline.locator('pre')).toContainText('"id": "rs.stage.frame-timeline"')
  errors.assertClear()
})
