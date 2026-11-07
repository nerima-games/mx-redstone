import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
const harnessPort = Number(process.env['HARNESS_PORT'] ?? '5182')

const config: ReturnType<typeof defineConfig> = defineConfig({
  root: here,
  server: {
    port: harnessPort,
    strictPort: true,
    fs: { allow: [repositoryRoot] },
  },
  appType: 'mpa',
})

export default config
