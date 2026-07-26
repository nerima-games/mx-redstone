import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: '50%',
        minForks: 1,
        isolate: true,
        singleFork: false,
      },
    },
    include: ['test/**/*.{test,spec}.ts'],
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
      include: ['index.ts', 'domain/**/*.ts', 'stages/**/*.ts'],
      exclude: [
        '**/*.d.ts',
        '**/*.config.ts',
        '**/*.test.ts',
        '**/*.spec.ts',
        // PURE_TYPE: a single type alias, zero executable statements. v8 reports
        // such a file as 0% rather than 100%, which would make the headline
        // number meaningless. It is a placeholder for mc-kernel's coordinate
        // vocabulary and is deleted when kernel is published.
        'domain/position-key.ts',
      ],
      all: true,
      reporter: ['text', 'json', 'html', 'lcov'],
      reportsDirectory: './coverage',
      // NO THRESHOLD YET — deliberate.
      //
      // The reference repository (takeokunn/ts-minecraft) enforces 99% on
      // branches/functions/lines/statements. A threshold on a skeleton would be
      // meaningless: it would be trivially satisfied by a handful of type-only
      // modules and would say nothing about the real implementation.
      //
      // Coverage is collected and reported (`pnpm test:coverage`) so the number
      // is always visible. The 99% gate is turned on — here and in the CI
      // workflow — when this repository reaches its completion criteria.
      //
      //   thresholds: { branches: 99, functions: 99, lines: 99, statements: 99 },
    },
  },
  esbuild: {
    target: 'node22',
    format: 'esm',
    platform: 'node',
  },
})
