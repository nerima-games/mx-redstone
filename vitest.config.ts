import { defineConfig } from 'vitest/config'

const config: ReturnType<typeof defineConfig> = defineConfig({
  test: {
    environment: 'node',
    globals: false,
    pool: 'forks',
    maxWorkers: '50%',
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/.git/**'],
    testTimeout: 10000,
    hookTimeout: 10000,
    teardownTimeout: 5000,
    slowTestThreshold: 300,
    fileParallelism: true,
    sequence: {
      seed: 0,
      hooks: 'stack',
    },
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      enabled: false,
      include: ['src/**/*.ts'],
      exclude: [
        '**/*.d.ts',
        '**/*.config.ts',
        '**/*.test.ts',
        '**/*.spec.ts',
        // PURE_TYPE: a single type alias, zero executable statements. v8 reports
        // such a file as 0% rather than 100%, which would make the headline
        // number meaningless. It is a placeholder for mc-kernel's coordinate
        // vocabulary and is deleted when kernel is published.
        'src/domain/position-key.ts',
        // PURE_TYPE, same reasoning: a placeholder for mc-kernel's block
        // identity, deleted when kernel is published.
        'src/domain/block-ref.ts',
      ],
      reporter: ['text', 'json', 'html', 'lcov'],
      reportsDirectory: './coverage',
      // The 100% gate (docs/testing.md §4 row 7 and §6): a regression gate, not
      // a headline number. Every branch in `src/**` — including
      // `src/application/world-runtime.ts`, newly measured now that `include`
      // covers `src/**/*.ts` in full rather than a hand-picked subset — must be
      // exercised.
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 },
    },
  },
  esbuild: {
    target: 'node24',
    format: 'esm',
    platform: 'node',
  },
})

export default config
