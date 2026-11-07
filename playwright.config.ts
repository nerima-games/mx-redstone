import { defineConfig, devices } from '@playwright/test'

const harnessPort = Number(process.env['HARNESS_PORT'] ?? '5182')

const config: ReturnType<typeof defineConfig> = defineConfig({
  forbidOnly: true,
  outputDir: process.env['PLAYWRIGHT_OUTPUT_DIR'] ?? 'test-results',
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  reporter: [['list']],
  retries: 0,
  testDir: './test-browser',
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  use: {
    baseURL: `http://localhost:${String(harnessPort)}`,
    screenshot: 'only-on-failure',
    trace: 'off',
    viewport: { height: 720, width: 1280 },
  },
  webServer: {
    command: 'pnpm preview:browser',
    reuseExistingServer: false,
    stderr: 'pipe',
    stdout: 'pipe',
    timeout: 60_000,
    url: `http://localhost:${String(harnessPort)}`,
  },
  workers: 1,
})

export default config
