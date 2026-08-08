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
      include: ['src/index.ts', 'src/domain/**/*.ts', 'src/stages/**/*.ts'],
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
        // PURE_TYPE, same reasoning: `export type BlockRef = string`, zero
        // executable statements. Its own file header calls out that it is "the
        // same call, and the same reasoning" as position-key.ts above — a
        // placeholder for mc-kernel's block identity, deleted when kernel is
        // published. It was omitted from this list when it was split out of
        // domain/piston.ts, which is why it showed as 0% rather than excluded.
        'src/domain/block-ref.ts',
      ],
      all: true,
      reporter: ['text', 'json', 'html', 'lcov'],
      reportsDirectory: './coverage',
      // THE 99% GATE, ON. `docs/testing.md` §4 row 7 and §6.
      //
      // This block used to explain why there was NO threshold: a number imposed
      // on a skeleton is trivially satisfied by type-only modules and says
      // nothing about the implementation. That argument was about the skeleton
      // and it has expired — `domain/` now carries the power graph, the
      // comparator arithmetic, the piston push rule, the observer, the hopper,
      // the dispenser and the weighted plate, and `stages/` carries the stage
      // contract. The percentage is finally a statement about behaviour.
      //
      // It is 99 rather than the measured 100 for the reason the reference
      // repository (takeokunn/ts-minecraft) uses 99: the gate exists to catch a
      // REGRESSION, and a threshold pinned to the exact current number turns
      // every unrelated refactor into a red build, which teaches people to
      // lower the number instead of writing the test. One percent of this
      // package is a little over one branch arm — enough to land a commit, not
      // enough to land a feature untested.
      //
      // Turning it on cost ONE test, and that is a fact about the code rather
      // than about the testing. Branches sat at 99.31% with a single arm
      // uncovered: the `0` in `sourcesOf`'s rear reading, i.e. a comparator
      // with neither a `containerSignal` nor an `inputFrom`. That arm is not
      // dead — it is the state a comparator is in the moment a player places
      // it — so it got a test that asserts the rule (`test/power-graph.test.ts`,
      // "an edge is not a rear") rather than one that asserts the number.
      //
      // The reason there was only one is DN-RS-11: this file was written under
      // the rule "do not leave a branch that can never run", which is why
      // `sourcesOf` is an if-chain and not a `switch` with an unreachable
      // `default`. A repository that keeps that rule arrives at the gate
      // already passing. That is the argument for the rule, recorded here
      // because this is where the bill came due.
      thresholds: { branches: 99, functions: 99, lines: 99, statements: 99 },
    },
  },
  esbuild: {
    target: 'node24',
    format: 'esm',
    platform: 'node',
  },
})
