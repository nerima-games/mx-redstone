/**
 * The gate that keeps mx-redstone from reaching past its two parents.
 *
 * mx-redstone is the repository plan.md §5.3 singles out as having been
 * successfully split off from mx-gameplay — 「自己完結だったレッドストーンは分離
 * 済み」. Self-contained is a property that has to be maintained, not a fact
 * about the past, and these assertions are what maintains it.
 */
import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import {
  allowedDirectDependencies,
  checkDeclaredDependencies,
  checkPolicyConfiguration,
  classifyImport,
  findBannedTimeSources,
  isToolingOrTestPath,
  REPOSITORY_POLICY,
  type DeclaredDependencies,
  type PolicyView,
} from '../scripts/check-dependency-whitelist'

const SHIPPED = 'stages/registration.ts'
const TOOLING = 'test/some.test.ts'

const declared = (
  dependencies: ReadonlyArray<string>,
  devDependencies: ReadonlyArray<string> = [],
): DeclaredDependencies => ({
  dependencies: new Set(dependencies),
  devDependencies: new Set(devDependencies),
})

const REAL_DEPENDENCIES = declared([
  '@nerima-games/mc-kernel',
  '@nerima-games/mc-sim',
  '@nerima-games/mc-worldgen',
])

/**
 * The same 16-repository roster, read as if this gate were installed in another
 * repository.
 *
 * Every copy of `check-dependency-whitelist.ts` carries the whole graph, so a
 * mistake in a row belonging to somebody else is invisible from this seat — the
 * import check only ever consults `thisPackage`'s row. Re-seating the policy is
 * how those rows get exercised at all.
 */
const seatOf = (thisPackage: string): PolicyView => ({
  thisPackage,
  dependencyGraph: REPOSITORY_POLICY.dependencyGraph,
  aliases: REPOSITORY_POLICY.aliases,
})

describe('mx-redstone dependency policy', () => {
  it.effect('declares exactly the parents plan.md §3.12 gives it: sim and worldgen', () =>
    Effect.sync(() => {
      expect(REPOSITORY_POLICY.thisPackage).toBe('@nerima-games/mx-redstone')
      expect([...allowedDirectDependencies()].sort()).toStrictEqual([
        '@nerima-games/mc-sim',
        '@nerima-games/mc-worldgen',
      ])
    }),
  )

  it.effect('carries the complete 16-repository roster, so cycle detection can see the whole organisation', () =>
    Effect.sync(() => {
      expect(REPOSITORY_POLICY.dependencyGraph.size).toBe(16)
      expect(checkPolicyConfiguration()).toStrictEqual([])
    }),
  )

  it.effect('REGRESSION: mc-audio is NOT a parent, so a click sound is requested through mc-sim', () =>
    Effect.sync(() => {
      // Redstone components make noise in the finished game, and it is tempting
      // to reach for mc-audio directly. plan.md §3.12 does not grant that edge
      // (unlike §3.11, which grants it to mx-gameplay). Adding it is a change to
      // plan.md, not to an import statement.
      const violation = classifyImport(
        {
          importedPackage: '@nerima-games/mc-audio',
          filePath: SHIPPED,
          line: 1,
          isToolingOrTest: false,
        },
        REAL_DEPENDENCIES,
      )
      expect(violation?.rule).toBe('not-whitelisted')
    }),
  )
})

describe('§2.3-1: zero dependency edges between experience modules', () => {
  const SIBLINGS = [
    '@nerima-games/mx-gameplay',
    '@nerima-games/mx-ui',
    '@nerima-games/mx-multiplayer',
  ] as const

  it.effect('REGRESSION: no experience module names another experience module in the graph', () =>
    Effect.sync(() => {
      const experienceModules = [
        '@nerima-games/mx-redstone',
        ...SIBLINGS,
      ] as ReadonlyArray<string>

      for (const module of experienceModules) {
        const parents = REPOSITORY_POLICY.dependencyGraph.get(module) ?? new Set<string>()
        for (const parent of parents) {
          expect(experienceModules).not.toContain(parent)
        }
      }
    }),
  )

  it.effect('REGRESSION: importing mx-gameplay, mx-ui or mx-multiplayer is rejected outright', () =>
    Effect.sync(() => {
      for (const sibling of SIBLINGS) {
        const violation = classifyImport(
          { importedPackage: sibling, filePath: SHIPPED, line: 1, isToolingOrTest: false },
          REAL_DEPENDENCIES,
        )
        expect(violation?.rule).toBe('not-whitelisted')
        // A piston that shoves a player is a write to mc-sim's entity state,
        // observed later by whichever rule cares — never a call into a sibling.
        expect(violation?.message).toContain('not a direct dependency')
      }
    }),
  )
})

describe('no transitive closure', () => {
  it.effect('REGRESSION: mx-redstone may NOT import mc-physics or mc-save just because mc-sim does', () =>
    Effect.sync(() => {
      for (const reached of ['@nerima-games/mc-physics', '@nerima-games/mc-save']) {
        const violation = classifyImport(
          { importedPackage: reached, filePath: SHIPPED, line: 12, isToolingOrTest: false },
          REAL_DEPENDENCIES,
        )
        expect(violation?.rule).toBe('transitive-import')
        expect(violation?.message).toContain('@nerima-games/mx-redstone -> @nerima-games/mc-sim')
      }
    }),
  )

  it.effect('REGRESSION: mc-noise is out of reach even though mc-worldgen is a parent', () =>
    Effect.sync(() => {
      const violation = classifyImport(
        {
          importedPackage: '@nerima-games/mc-noise',
          filePath: SHIPPED,
          line: 1,
          isToolingOrTest: false,
        },
        REAL_DEPENDENCIES,
      )
      expect(violation?.rule).toBe('transitive-import')
      expect(violation?.message).toContain(
        '@nerima-games/mx-redstone -> @nerima-games/mc-worldgen -> @nerima-games/mc-noise',
      )
    }),
  )

  it.effect('both declared parents ARE importable from shipped source', () =>
    Effect.sync(() => {
      for (const parent of allowedDirectDependencies()) {
        expect(
          classifyImport(
            { importedPackage: parent, filePath: SHIPPED, line: 1, isToolingOrTest: false },
            REAL_DEPENDENCIES,
          ),
        ).toBeUndefined()
      }
    }),
  )

  it.effect('mc-kernel is importable without appearing in any allowlist, but must still be declared', () =>
    Effect.sync(() => {
      expect(
        classifyImport(
          {
            importedPackage: '@nerima-games/mc-kernel',
            filePath: SHIPPED,
            line: 1,
            isToolingOrTest: false,
          },
          REAL_DEPENDENCIES,
        ),
      ).toBeUndefined()

      expect(
        classifyImport(
          {
            importedPackage: '@nerima-games/mc-kernel',
            filePath: SHIPPED,
            line: 1,
            isToolingOrTest: false,
          },
          declared([]),
        )?.rule,
      ).toBe('undeclared-dependency')
    }),
  )
})

describe('§2.3-2: mc-playground-kit is devDependency-only', () => {
  const KIT = '@nerima-games/mc-playground-kit'

  it.effect('REGRESSION: kit in "dependencies" is an error, because it would delete input handling from the shipped game', () =>
    Effect.sync(() => {
      const violations = checkDeclaredDependencies(declared([KIT]))
      expect(violations).toHaveLength(1)
      expect(violations[0]?.rule).toBe('dev-only-package-in-dependencies')
      expect(violations[0]?.message).toContain('delete input handling')
    }),
  )

  it.effect('REGRESSION: importing kit from shipped source is an error even if it is declared correctly', () =>
    Effect.sync(() => {
      const violation = classifyImport(
        { importedPackage: KIT, filePath: SHIPPED, line: 1, isToolingOrTest: false },
        declared([], [KIT]),
      )
      expect(violation?.rule).toBe('dev-only-package-in-shipped-source')
    }),
  )

  it.effect('kit IS allowed from the circuit-board preview, which is the whole reason it exists', () =>
    Effect.sync(() => {
      expect(checkDeclaredDependencies(declared([], [KIT]))).toStrictEqual([])
      expect(
        classifyImport(
          { importedPackage: KIT, filePath: TOOLING, line: 1, isToolingOrTest: true },
          declared([], [KIT]),
        ),
      ).toBeUndefined()
    }),
  )

  it.effect('REGRESSION: `stages/` counts as shipped source, not as tooling', () =>
    Effect.sync(() => {
      expect(isToolingOrTestPath('stages/registration.ts')).toBe(false)
      expect(isToolingOrTestPath('domain/power-graph.ts')).toBe(false)
      expect(isToolingOrTestPath('index.ts')).toBe(false)
      expect(isToolingOrTestPath('test/piston.test.ts')).toBe(true)
      expect(isToolingOrTestPath('scripts/check-dependency-whitelist.ts')).toBe(true)
    }),
  )
})

describe('§4.3: the clock is injected, never read from a global', () => {
  it.effect('REGRESSION: Date.now(), new Date() and performance.now() are all rejected', () =>
    Effect.sync(() => {
      const source = [
        'const a = Date.now()',
        'const b = new Date()',
        'const c = performance.now()',
      ].join('\n')

      const violations = findBannedTimeSources(source, SHIPPED)
      expect(violations.map((violation) => violation.line)).toStrictEqual([1, 2, 3])
      expect(violations.every((violation) => violation.rule === 'banned-time-source')).toBe(true)
    }),
  )

  it.effect('a mention of Date.now() inside a comment or a string is not a violation', () =>
    Effect.sync(() => {
      const source = ['// Date.now() is banned', "const message = 'Date.now()'"].join('\n')
      expect(findBannedTimeSources(source, SHIPPED)).toStrictEqual([])
    }),
  )
})

describe('the roster, read from the seat of another repository', () => {
  it.effect('REGRESSION: seated in mx-gameplay, importing mx-redstone is rejected — the zero-edge rule is symmetric', () =>
    Effect.sync(() => {
      const violation = classifyImport(
        {
          importedPackage: '@nerima-games/mx-redstone',
          filePath: SHIPPED,
          line: 1,
          isToolingOrTest: false,
        },
        declared(['@nerima-games/mx-redstone']),
        seatOf('@nerima-games/mx-gameplay'),
      )
      expect(violation?.rule).toBe('not-whitelisted')
    }),
  )

  it.effect('mc-compose IS allowed to import mx-redstone — it is the one repository that may', () =>
    Effect.sync(() => {
      expect(
        classifyImport(
          {
            importedPackage: '@nerima-games/mx-redstone',
            filePath: SHIPPED,
            line: 1,
            isToolingOrTest: false,
          },
          declared(['@nerima-games/mx-redstone']),
          seatOf('@nerima-games/mc-compose'),
        ),
      ).toBeUndefined()
    }),
  )

  it.effect('REGRESSION: mc-playground-kit reaches mc-render, and mx-redstone does not', () =>
    Effect.sync(() => {
      // The kit's own dependencies are ordinary runtime edges; only its
      // CONSUMERS are restricted to devDependencies (plan.md §2.3-2). Getting
      // that backwards would make the preview harness unbuildable.
      expect(
        classifyImport(
          {
            importedPackage: '@nerima-games/mc-render',
            filePath: SHIPPED,
            line: 1,
            isToolingOrTest: false,
          },
          declared(['@nerima-games/mc-render']),
          seatOf('@nerima-games/mc-playground-kit'),
        ),
      ).toBeUndefined()

      expect(
        classifyImport(
          {
            importedPackage: '@nerima-games/mc-render',
            filePath: SHIPPED,
            line: 1,
            isToolingOrTest: false,
          },
          REAL_DEPENDENCIES,
        )?.rule,
      ).toBe('not-whitelisted')
    }),
  )
})
