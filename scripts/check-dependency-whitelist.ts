/**
 * check-dependency-whitelist.ts
 *
 * The cross-repository boundary gate for the nerima-games Minecraft rebuild.
 * This file is the TEMPLATE for all 16 repositories: adapting it to a sibling
 * repository means editing exactly one constant, `REPOSITORY_POLICY`, which is
 * fenced off at the top of the file. Everything below that fence is generic and
 * should be copied byte-for-byte.
 *
 * ---------------------------------------------------------------------------
 * What it enforces
 * ---------------------------------------------------------------------------
 *
 * 1. HARD FAILURE. Any violation exits non-zero. This is the deliberate
 *    difference from the reference implementation's `check-package-dag.ts`,
 *    which printed warnings and always exited 0 — a gate that cannot fail is
 *    documentation, not a gate.
 *
 * 2. NO CYCLES. The reference legalised six cycles through an allowlist of
 *    "co-evolution pairs". There is no such allowlist here: any cycle in the
 *    declared dependency graph is a configuration error and fails the build.
 *
 * 3. NO TRANSITIVE CLOSURE. A dependency is a licence to import that package
 *    and nothing else. If this repository depends on `mc-sim`, and `mc-sim`
 *    depends on `mc-physics`, this repository still may NOT import
 *    `mc-physics`. Reaching through a dependency is how a 16-repository split
 *    quietly turns back into a monolith.
 *
 * 4. KERNEL IS UNIVERSAL. `@nerima-games/mc-kernel` is the shared vocabulary
 *    and is importable from every repository without appearing in any
 *    allowlist. It must still be declared in package.json — universal
 *    importability is a policy exemption, not a packaging exemption.
 *
 * 5. DECLARED == IMPORTED. Every imported org package must appear in
 *    package.json (`dependencies` for shipped code, `dependencies` or
 *    `devDependencies` for tests and tooling). Carried over from the
 *    reference's `check-ddd-boundaries.ts`.
 *
 * 6. mc-playground-kit IS DEV-ONLY. It must never appear in `dependencies` and
 *    must never be imported from shipped source. A runtime dependency on it
 *    would delete input handling from the shipped game.
 *
 * 7. NO RAW CLOCK READS. `Date.now()`, `new Date()` and `performance.now()` are
 *    banned; time comes from the injected clock Port. This lives here rather
 *    than in oxlint.json because oxlint 0.12 implements neither
 *    `no-restricted-syntax` nor `no-restricted-properties`, and its
 *    `no-restricted-globals` is listed but not implemented. Verified
 *    empirically against oxlint 0.12.0. Move the ban to oxlint.json when
 *    oxlint gains one of those rules.
 *
 * ---------------------------------------------------------------------------
 * Known limits
 * ---------------------------------------------------------------------------
 *
 * - Import extraction is regex-based over a comment/string/regex-literal mask,
 *   not a parse. It is deliberately lightweight so that it has no dependencies
 *   of its own. It does not understand `export =`, and a `/` that the mask
 *   heuristic misreads as starting a regex literal blanks code until the next
 *   `/`. Both failure modes are false NEGATIVES (a missed violation), never
 *   false positives, so the gate never blocks correct code.
 * - Cycle detection runs over `REPOSITORY_POLICY.dependencyGraph`. This copy
 *   carries the COMPLETE 16-repository roster, so every cycle in the declared
 *   organisation graph is visible from here. The rows for other repositories
 *   are mirrored by hand, so the roster is only as accurate as the last time
 *   somebody updated it; it should eventually be published from mc-dev-meta and
 *   consumed rather than copied.
 */
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// ↓↓↓ PER-REPOSITORY CONFIGURATION — THIS IS THE ONLY THING YOU EDIT ↓↓↓
// ---------------------------------------------------------------------------

/**
 * `thisPackage`
 *   The npm name of the repository this script lives in.
 *
 * `dependencyGraph`
 *   Direct dependency edges, keyed by package name. The row for `thisPackage`
 *   is authoritative and is what the import check enforces. Rows for other
 *   packages are mirrored from their own repositories and exist so that cycle
 *   detection has something to work with; keeping them in sync is a manual
 *   chore today, and the organisation-wide graph should eventually be published
 *   from a single meta-repository and consumed here.
 *
 *   Do NOT list `@nerima-games/mc-kernel` in any row: it is universally
 *   importable and is handled by rule 4 above.
 *
 * `aliases`
 *   Historical or in-flight package names mapped to their canonical name, so a
 *   rename can land in one repository at a time without breaking the gate.
 *   Same role as the reference's `targetPackageAliases`.
 *
 * ---------------------------------------------------------------------------
 * mx-redstone is an EXPERIENCE MODULE (plan.md §2.2, §3.12): a verb, not a
 * noun. It owns the redstone mechanism — wire power propagation, torches,
 * levers, buttons, repeaters, piston pushing — and owns no state: the world it
 * reads and writes belongs to mc-sim and mc-worldgen.
 *
 * Its parents are mc-sim and mc-worldgen (plus mc-kernel, which is universal).
 * Note what is NOT there: mc-audio. Redstone makes sounds in the finished game,
 * but plan.md §3.12 gives this repository no audio parent, so a click sound is
 * requested through mc-sim rather than by importing mc-audio directly. Adding
 * the edge is a decision to be made in plan.md, not in a source file.
 *
 * Two consequences worth spelling out:
 *
 *   1. NO TRANSITIVE CLOSURE. mc-sim depends on mc-physics and mc-save;
 *      mx-redstone does not. Importing either is reported as
 *      `transitive-import` with the path that explains it.
 *   2. NO EDGE TO ANOTHER EXPERIENCE MODULE. A piston that shoves a player is
 *      not an mx-redstone -> mx-gameplay call; it is a write to mc-sim's
 *      entity state that mx-gameplay's rules observe on a later stage.
 *
 * mc-playground-kit powers the circuit-board preview and is therefore a
 * devDependency ONLY (plan.md §2.3-2, §3.10): kit is not shipped, and the
 * runtime input service lives in mc-render, so a runtime dependency on kit
 * would delete input handling from the released game. Rule 6 makes that a hard
 * failure.
 * ---------------------------------------------------------------------------
 */
export const REPOSITORY_POLICY = {
  thisPackage: '@nerima-games/mx-redstone',

  dependencyGraph: new Map<string, ReadonlySet<string>>([
    // ---------------------------------------------------------------------
    // 安定ライブラリ / stable libraries (plan.md §2.2)
    // Pure functions, narrow interfaces, mutually independent. Their only
    // parent is mc-kernel, which by rule 4 must NOT be written down.
    // ---------------------------------------------------------------------
    ['@nerima-games/mc-kernel', new Set<string>()],
    ['@nerima-games/mc-noise', new Set<string>()],
    ['@nerima-games/mc-meshing', new Set<string>()],
    ['@nerima-games/mc-physics', new Set<string>()],
    ['@nerima-games/mc-save', new Set<string>()],
    ['@nerima-games/mc-audio', new Set<string>()],

    // ---------------------------------------------------------------------
    // 基盤 / foundation — state and services. The NOUNS of plan.md §2.3-1.
    // ---------------------------------------------------------------------
    ['@nerima-games/mc-worldgen', new Set([
      '@nerima-games/mc-noise',
      '@nerima-games/mc-save',
    ])],
    ['@nerima-games/mc-sim', new Set([
      '@nerima-games/mc-physics',
      '@nerima-games/mc-save',
      '@nerima-games/mc-worldgen',
    ])],
    ['@nerima-games/mc-render', new Set([
      '@nerima-games/mc-meshing',
      '@nerima-games/mc-sim',
      '@nerima-games/mc-worldgen',
    ])],
    // mc-playground-kit is listed here for cycle detection only. It is a
    // dev-only package (DEV_ONLY_PACKAGES / rule 6), so no repository may name
    // it as a runtime edge — which is why it appears as a KEY below but never
    // as a member of any experience module's Set.
    ['@nerima-games/mc-playground-kit', new Set([
      '@nerima-games/mc-worldgen',
      '@nerima-games/mc-sim',
      '@nerima-games/mc-render',
    ])],

    // ---------------------------------------------------------------------
    // 体験モジュール / experience modules — rules and UI. The VERBS of §2.3-1.
    //
    // THE LOAD-BEARING PROPERTY OF THIS BLOCK IS WHAT IS *ABSENT* FROM IT:
    // none of these four rows names another of these four rows. Zero edges,
    // by construction (plan.md §2.3-1). "Mining puts an item in the
    // inventory" is not an mx-gameplay -> mx-ui edge; it is mx-gameplay
    // writing to mc-sim's InventoryService and mx-ui reading from it. If you
    // ever feel the need to add an edge here, the state you are reaching for
    // belongs in a foundation repository instead.
    //
    // The gate enforces this without a special case: mx-ui has no row naming
    // mx-gameplay, so an import of mx-gameplay from mx-ui is reported as
    // `not-whitelisted`.
    // ---------------------------------------------------------------------
    ['@nerima-games/mx-gameplay', new Set([
      '@nerima-games/mc-sim',
      '@nerima-games/mc-worldgen',
      '@nerima-games/mc-audio',
    ])],
    ['@nerima-games/mx-redstone', new Set([
      '@nerima-games/mc-sim',
      '@nerima-games/mc-worldgen',
    ])],
    ['@nerima-games/mx-ui', new Set([
      '@nerima-games/mc-sim',
      '@nerima-games/mc-audio',
    ])],
    ['@nerima-games/mx-multiplayer', new Set([
      '@nerima-games/mc-sim',
    ])],

    // ---------------------------------------------------------------------
    // 合成 / composition — Layer merge + the single total stage order + E2E.
    // ---------------------------------------------------------------------
    ['@nerima-games/mc-compose', new Set([
      '@nerima-games/mx-gameplay',
      '@nerima-games/mx-redstone',
      '@nerima-games/mx-ui',
      '@nerima-games/mx-multiplayer',
    ])],

    // The dev-meta workspace (plan.md §6 Step 0) clones the other repositories
    // into `repos/`; it consumes none of them as packages.
    ['@nerima-games/mc-dev-meta', new Set<string>()],
  ]),

  aliases: new Map<string, string>([
    // ['@nerima-games/mc-old-name', '@nerima-games/mc-new-name'],
  ]),
} as const

// ---------------------------------------------------------------------------
// ↑↑↑ END OF PER-REPOSITORY CONFIGURATION — everything below is generic ↑↑↑
// ---------------------------------------------------------------------------

/** The npm scope that identifies a sibling repository. */
export const ORG_SCOPE = '@nerima-games'

/** Importable from every repository without appearing in any allowlist (rule 4). */
export const KERNEL_PACKAGE = '@nerima-games/mc-kernel'

/**
 * Packages that may only ever be devDependencies (rule 6).
 *
 * mc-playground-kit is developer tooling. A runtime dependency on it would make
 * the shipped game's input handling come from the playground harness, which is
 * not shipped — i.e. the released build would have no input handling at all.
 */
export const DEV_ONLY_PACKAGES: ReadonlySet<string> = new Set([`${ORG_SCOPE}/mc-playground-kit`])

/**
 * Raw clock reads (rule 7).
 *
 * A line carrying the escape-hatch marker is exempt. The only legitimate use is
 * the adapter that *implements* the clock Port, which by definition has to read
 * a real clock exactly once.
 */
export const TIME_SOURCE_ESCAPE_HATCH = 'mc-kernel-allow-time-source'

export const BANNED_TIME_SOURCES: ReadonlyArray<{ readonly pattern: RegExp; readonly what: string }> = [
  { pattern: /\bDate\s*\.\s*now\s*\(/gu, what: 'Date.now()' },
  { pattern: /\bnew\s+Date\s*\(\s*\)/gu, what: 'new Date()' },
  { pattern: /\bperformance\s*\.\s*now\s*\(/gu, what: 'performance.now()' },
]

/** Directories and files scanned for imports and banned time sources. */
export const SCAN_ROOTS: ReadonlyArray<string> = ['apps', 'index.ts', 'domain', 'stages', 'scripts', 'test']

const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '.devenv',
  '.direnv',
])

export type Violation = {
  readonly filePath: string
  readonly line: number
  readonly rule: string
  readonly message: string
}

// ---------------------------------------------------------------------------
// Source masking
// ---------------------------------------------------------------------------

const IDENTIFIER_CHARACTER = /[A-Za-z0-9_$]/u

/** Keywords after which a `/` starts a regex literal rather than a division. */
const REGEX_PRECEDING_KEYWORDS: ReadonlySet<string> = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'case',
  'do',
  'else',
  'yield',
  'await',
])

const charAt = (source: string, index: number): string => source[index] ?? ''

const isIdentifierCharacter = (character: string): boolean =>
  character !== '' && IDENTIFIER_CHARACTER.test(character)

const wordEndingAt = (source: string, endExclusive: number): string => {
  let start = endExclusive
  while (start > 0 && isIdentifierCharacter(charAt(source, start - 1))) {
    start -= 1
  }
  return source.slice(start, endExclusive)
}

/**
 * Decide whether a `/` at `index` opens a regex literal.
 *
 * Standard heuristic: a regex may not follow something that can end an
 * expression. Getting this wrong blanks a stretch of code, which can only hide
 * a violation, never invent one.
 */
const startsRegexLiteral = (source: string, lastSignificantIndex: number): boolean => {
  if (lastSignificantIndex < 0) {
    return true
  }
  const last = charAt(source, lastSignificantIndex)
  if (isIdentifierCharacter(last)) {
    return REGEX_PRECEDING_KEYWORDS.has(wordEndingAt(source, lastSignificantIndex + 1))
  }
  return last !== ')' && last !== ']' && last !== '}'
}

/**
 * Blank out everything that is not executable code, preserving length so that
 * offsets — and therefore line numbers — remain valid against the original.
 *
 * Blanked: comment bodies, and the *interior* of string, template and regex
 * literals. Delimiters (`'`, `"`, `` ` ``, `/`) survive, so a real import
 * statement is still recognisable as `import ... from '        '` — the
 * specifier is then read back from the original source at the same offsets.
 *
 * Blanking string interiors is what stops a doc string, a fixture, or a pattern
 * that merely *mentions* `import ... from '@nerima-games/x'` or `Date.now()`
 * from being reported as the real thing.
 */
export const maskSource = (source: string): string => {
  const codeOnly = [...source]

  const blank = (target: Array<string>, start: number, endExclusive: number): void => {
    for (let index = Math.max(start, 0); index < Math.min(endExclusive, target.length); index += 1) {
      const character = target[index]
      if (character !== '\n' && character !== '\r') {
        target[index] = ' '
      }
    }
  }

  // A frame stack so that `${...}` inside a template literal is scanned as code.
  const frames: Array<{ kind: 'code' | 'template'; depth: number }> = [{ kind: 'code', depth: 0 }]
  let index = 0
  let lastSignificantIndex = -1

  while (index < source.length) {
    const frame = frames[frames.length - 1] ?? { kind: 'code', depth: 0 }
    const character = charAt(source, index)

    if (frame.kind === 'template') {
      if (character === '\\') {
        blank(codeOnly, index, index + 2)
        index += 2
        continue
      }
      if (character === '`') {
        frames.pop()
        lastSignificantIndex = index
        index += 1
        continue
      }
      if (character === '$' && charAt(source, index + 1) === '{') {
        frames.push({ kind: 'code', depth: 0 })
        index += 2
        continue
      }
      blank(codeOnly, index, index + 1)
      index += 1
      continue
    }

    if (character === '/' && charAt(source, index + 1) === '/') {
      const end = source.indexOf('\n', index)
      const stop = end === -1 ? source.length : end
      blank(codeOnly, index, stop)
      index = stop
      continue
    }

    if (character === '/' && charAt(source, index + 1) === '*') {
      const end = source.indexOf('*/', index + 2)
      const stop = end === -1 ? source.length : end + 2
      blank(codeOnly, index, stop)
      index = stop
      continue
    }

    if (character === '/' && startsRegexLiteral(source, lastSignificantIndex)) {
      let cursor = index + 1
      let inCharacterClass = false
      while (cursor < source.length) {
        const current = charAt(source, cursor)
        if (current === '\\') {
          cursor += 2
          continue
        }
        if (current === '\n') {
          break
        }
        if (current === '[') {
          inCharacterClass = true
        } else if (current === ']') {
          inCharacterClass = false
        } else if (current === '/' && !inCharacterClass) {
          break
        }
        cursor += 1
      }
      blank(codeOnly, index + 1, cursor)
      lastSignificantIndex = cursor
      index = cursor + 1
      continue
    }

    if (character === "'" || character === '"') {
      let cursor = index + 1
      while (cursor < source.length) {
        const current = charAt(source, cursor)
        if (current === '\\') {
          cursor += 2
          continue
        }
        if (current === character || current === '\n') {
          break
        }
        cursor += 1
      }
      blank(codeOnly, index + 1, cursor)
      lastSignificantIndex = cursor
      index = cursor + 1
      continue
    }

    if (character === '`') {
      frames.push({ kind: 'template', depth: 0 })
      index += 1
      continue
    }

    if (character === '{') {
      frame.depth += 1
    } else if (character === '}') {
      if (frame.depth === 0 && frames.length > 1) {
        frames.pop()
        index += 1
        continue
      }
      frame.depth -= 1
    }

    if (character.trim() !== '') {
      lastSignificantIndex = index
    }
    index += 1
  }

  return codeOnly.join('')
}

export const lineOfIndex = (source: string, index: number): number =>
  source.slice(0, index).split(/\r?\n/u).length

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

export type ImportRecord = {
  readonly specifier: string
  readonly line: number
}

/**
 * Matched against the MASKED source, where a specifier's characters have been
 * replaced by spaces. Group 1 therefore captures a run of blanks; its offsets
 * are used to read the real specifier back out of the original source.
 *
 * The `d` flag is what makes that possible.
 *
 * REGRESSION — do not rewrite the middle segment as `[^'";]+?`.
 *
 * That form was ambiguous with the `\s+` that follows it: both could match the
 * same run of whitespace, so the engine tried every way to split it. Measured on
 * `'import ' + ' '.repeat(n)`: 283ms at n=1000, 2.4s at n=2000, 19.3s at n=4000.
 * These repositories are public and CI runs on `pull_request`, so any fork PR
 * could have burned a runner to the six-hour job cap with a file of blanks — and
 * `maskSource` blanks comment bodies while preserving length, so a large doc
 * comment after a bare `import` reproduced it by accident.
 *
 * `[^'";]*[^'";\s]` forces the segment to end on a non-space, which removes the
 * overlap. Same n=4000 input: 20ms. Verified identical output on 11 import and
 * export forms.
 */
const IMPORT_PATTERNS: ReadonlyArray<RegExp> = [
  // import x from 'm' / import type { x } from 'm' / import 'm'
  /\bimport\s+(?:type\s+)?(?:[^'";]*[^'";\s]\s+from\s+)?['"]([^'"]*)['"]/dgu,
  // export * from 'm' / export { x } from 'm' / export type { x } from 'm'
  /\bexport\s+(?:type\s+)?[^'";]*[^'";\s]\s+from\s+['"]([^'"]*)['"]/dgu,
  // await import('m') and the import('m') type operator
  /\bimport\s*\(\s*['"]([^'"]*)['"]\s*\)/dgu,
]

/**
 * Extract module specifiers from a source file.
 *
 * Matching happens on the masked source, so text that merely looks like an
 * import inside a comment, a string or a test fixture is invisible. Because the
 * mask preserves length, the specifier is recovered from the original source at
 * the matched offsets.
 *
 * Runs over the whole file rather than line by line, so multi-line import
 * statements are seen.
 */
export const parseImports = (rawSource: string): ReadonlyArray<ImportRecord> => {
  const masked = maskSource(rawSource)
  const records: Array<ImportRecord> = []
  const seen = new Set<number>()

  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0
    for (const match of masked.matchAll(pattern)) {
      const span = match.indices?.[1]
      if (span === undefined || seen.has(span[0])) {
        continue
      }
      seen.add(span[0])
      const specifier = rawSource.slice(span[0], span[1])
      if (specifier.length === 0) {
        continue
      }
      records.push({ specifier, line: lineOfIndex(masked, span[0]) })
    }
  }

  return records.sort((left, right) => left.line - right.line)
}

/** `@nerima-games/mc-sim/domain/thing` -> `@nerima-games/mc-sim`; non-org -> undefined. */
export const extractOrgPackageName = (specifier: string): string | undefined => {
  const match = new RegExp(`^${ORG_SCOPE}/([^/]+)`, 'u').exec(specifier)
  const name = match?.[1]
  return name === undefined ? undefined : `${ORG_SCOPE}/${name}`
}

/**
 * The shape the policy checks read.
 *
 * Every check below takes one of these, defaulting to `REPOSITORY_POLICY`.
 * Production behaviour is therefore unchanged — the parameter exists so that a
 * test can ask "what would this gate do if it were installed in mc-render?",
 * which is the only way to exercise the transitive-closure rule against the
 * real roster. Kernel's own row is empty, so from kernel's seat every foreign
 * import is `not-whitelisted` and the `transitive-import` branch is
 * unreachable — the most important rule in the file would otherwise ship
 * untested.
 */
export type PolicyView = {
  readonly thisPackage: string
  readonly dependencyGraph: ReadonlyMap<string, ReadonlySet<string>>
  readonly aliases: ReadonlyMap<string, string>
}

export const canonicalPackageName = (packageName: string, policy: PolicyView = REPOSITORY_POLICY): string =>
  policy.aliases.get(packageName) ?? packageName

// ---------------------------------------------------------------------------
// Policy checks (pure — unit-tested by test/check-dependency-whitelist.test.ts)
// ---------------------------------------------------------------------------

/** Direct dependencies of this repository, per the authoritative graph row. */
export const allowedDirectDependencies = (policy: PolicyView = REPOSITORY_POLICY): ReadonlySet<string> =>
  policy.dependencyGraph.get(policy.thisPackage) ?? new Set<string>()

/**
 * Shortest path `from -> ... -> to` in the declared graph, or undefined.
 * Used to explain *why* an import is a transitive-closure violation.
 */
export const findTransitivePath = (
  graph: ReadonlyMap<string, ReadonlySet<string>>,
  from: string,
  to: string,
): ReadonlyArray<string> | undefined => {
  const queue: Array<ReadonlyArray<string>> = [[from]]
  const visited = new Set<string>([from])

  while (queue.length > 0) {
    const currentPath = queue.shift()
    const tail = currentPath?.[currentPath.length - 1]
    if (currentPath === undefined || tail === undefined) {
      continue
    }
    for (const next of graph.get(tail) ?? []) {
      if (next === to) {
        return [...currentPath, next]
      }
      if (!visited.has(next)) {
        visited.add(next)
        queue.push([...currentPath, next])
      }
    }
  }

  return undefined
}

/**
 * Reject every cycle in the declared graph. No allowlist, by design (rule 2).
 */
export const findCycles = (graph: ReadonlyMap<string, ReadonlySet<string>>): ReadonlyArray<Violation> => {
  const violations: Array<Violation> = []
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const stack: Array<string> = []

  const visit = (node: string): void => {
    if (visiting.has(node)) {
      const cycleStart = stack.indexOf(node)
      violations.push({
        filePath: 'scripts/check-dependency-whitelist.ts',
        line: 1,
        rule: 'cycle',
        message:
          `dependency cycle: ${[...stack.slice(cycleStart), node].join(' -> ')}. ` +
          'Cycles are rejected outright in this project — there is no co-evolution allowlist. ' +
          'Break it by extracting the shared vocabulary into @nerima-games/mc-kernel.',
      })
      return
    }
    if (visited.has(node)) {
      return
    }
    visiting.add(node)
    stack.push(node)
    for (const next of graph.get(node) ?? []) {
      visit(next)
    }
    stack.pop()
    visiting.delete(node)
    visited.add(node)
  }

  for (const node of graph.keys()) {
    visit(node)
  }

  return violations
}

/** Sanity-check `REPOSITORY_POLICY` itself before using it to judge anything. */
export const checkPolicyConfiguration = (policy: PolicyView = REPOSITORY_POLICY): ReadonlyArray<Violation> => {
  const where = 'scripts/check-dependency-whitelist.ts'
  const violations: Array<Violation> = []
  const { thisPackage, dependencyGraph } = policy

  if (!dependencyGraph.has(thisPackage)) {
    violations.push({
      filePath: where,
      line: 1,
      rule: 'policy-config',
      message: `REPOSITORY_POLICY.dependencyGraph has no row for thisPackage (${thisPackage}); add one, even if empty.`,
    })
  }

  for (const [source, targets] of dependencyGraph) {
    for (const target of targets) {
      if (target === source) {
        violations.push({
          filePath: where,
          line: 1,
          rule: 'policy-config',
          message: `${source} lists itself as a dependency.`,
        })
      }
      if (target === KERNEL_PACKAGE) {
        violations.push({
          filePath: where,
          line: 1,
          rule: 'policy-config',
          message: `${source} lists ${KERNEL_PACKAGE} explicitly; kernel is universally importable and must not appear in the graph.`,
        })
      }
      if (!dependencyGraph.has(target)) {
        violations.push({
          filePath: where,
          line: 1,
          rule: 'policy-config',
          message: `${source} depends on ${target}, which has no row in the graph; cycle detection cannot see past it.`,
        })
      }
    }
  }

  violations.push(...findCycles(dependencyGraph))
  return violations
}

export type ImportSite = {
  readonly importedPackage: string
  readonly filePath: string
  readonly line: number
  /** Tests and repo tooling; may use devDependencies, is never shipped. */
  readonly isToolingOrTest: boolean
}

export type DeclaredDependencies = {
  readonly dependencies: ReadonlySet<string>
  readonly devDependencies: ReadonlySet<string>
}

/**
 * The whole import policy, in one place. Returns undefined when the import is
 * allowed.
 */
export const classifyImport = (
  site: ImportSite,
  declared: DeclaredDependencies,
  policy: PolicyView = REPOSITORY_POLICY,
): Violation | undefined => {
  const { thisPackage, dependencyGraph } = policy
  const imported = canonicalPackageName(site.importedPackage, policy)
  const at = { filePath: site.filePath, line: site.line }

  if (imported === thisPackage) {
    return {
      ...at,
      rule: 'self-import',
      message: `imports ${imported}, which is this package; use a relative import instead.`,
    }
  }

  // Checked before the whitelist so that the specific, actionable message wins
  // over the generic "not a direct dependency" one.
  const isDevOnly = DEV_ONLY_PACKAGES.has(imported)

  if (isDevOnly && !site.isToolingOrTest) {
    return {
      ...at,
      rule: 'dev-only-package-in-shipped-source',
      message: `imports ${imported} from shipped source. It is developer tooling and may only be used from tests and scripts; a runtime dependency on it would delete input handling from the shipped game.`,
    }
  }

  const isKernel = imported === KERNEL_PACKAGE
  const isDirectDependency = allowedDirectDependencies(policy).has(imported)

  // A dev-only package creates no runtime edge, so it needs no row in the
  // dependency graph — it cannot participate in a cycle. It still has to be
  // declared in devDependencies, which the check below enforces.
  if (!isKernel && !isDevOnly && !isDirectDependency) {
    if (!dependencyGraph.has(imported)) {
      return {
        ...at,
        rule: 'unknown-package',
        message: `imports ${imported}, which is not a known ${ORG_SCOPE} package. Add it to REPOSITORY_POLICY.dependencyGraph if it is real, or fix the typo.`,
      }
    }

    const viaPath = findTransitivePath(dependencyGraph, thisPackage, imported)
    if (viaPath !== undefined) {
      return {
        ...at,
        rule: 'transitive-import',
        message:
          `imports ${imported}, which ${thisPackage} only reaches transitively (${viaPath.join(' -> ')}). ` +
          'A transitive dependency is not an import licence. Either declare it as a direct dependency ' +
          '(REPOSITORY_POLICY.dependencyGraph + package.json), or do not import it.',
      }
    }

    return {
      ...at,
      rule: 'not-whitelisted',
      message:
        `imports ${imported}, which is not a direct dependency of ${thisPackage}. ` +
        `Allowed: ${describeAllowed(policy)}.`,
    }
  }

  const declaredAnywhere = declared.dependencies.has(imported) || declared.devDependencies.has(imported)

  if (site.isToolingOrTest ? !declaredAnywhere : !declared.dependencies.has(imported)) {
    return {
      ...at,
      rule: 'undeclared-dependency',
      message: site.isToolingOrTest
        ? `imports ${imported}, which is declared in neither "dependencies" nor "devDependencies" of package.json.`
        : `imports ${imported} from shipped source, but it is not declared in "dependencies" of package.json.`,
    }
  }

  return undefined
}

const describeAllowed = (policy: PolicyView = REPOSITORY_POLICY): string => {
  const allowed = [...allowedDirectDependencies(policy)].sort()
  const rendered = allowed.length === 0 ? 'nothing' : allowed.join(', ')
  return `${rendered} (plus ${KERNEL_PACKAGE}, which every repository may import)`
}

/** package.json-level checks: the manifest must agree with the policy. */
export const checkDeclaredDependencies = (
  declared: DeclaredDependencies,
  policy: PolicyView = REPOSITORY_POLICY,
): ReadonlyArray<Violation> => {
  const violations: Array<Violation> = []
  const allowed = allowedDirectDependencies(policy)

  for (const dependency of declared.dependencies) {
    const canonical = canonicalPackageName(dependency, policy)
    if (!canonical.startsWith(`${ORG_SCOPE}/`)) {
      continue
    }
    if (DEV_ONLY_PACKAGES.has(canonical)) {
      violations.push({
        filePath: 'package.json',
        line: 1,
        rule: 'dev-only-package-in-dependencies',
        message: `${canonical} appears in "dependencies"; it is devDependency-only. A runtime dependency on it would delete input handling from the shipped game. Move it to "devDependencies".`,
      })
      continue
    }
    if (canonical !== KERNEL_PACKAGE && !allowed.has(canonical)) {
      violations.push({
        filePath: 'package.json',
        line: 1,
        rule: 'undeclared-in-policy',
        message: `"dependencies" contains ${canonical}, which REPOSITORY_POLICY does not allow. Allowed: ${describeAllowed(policy)}.`,
      })
    }
  }

  for (const dependency of declared.devDependencies) {
    const canonical = canonicalPackageName(dependency, policy)
    if (!canonical.startsWith(`${ORG_SCOPE}/`)) {
      continue
    }
    if (canonical !== KERNEL_PACKAGE && !DEV_ONLY_PACKAGES.has(canonical) && !allowed.has(canonical)) {
      violations.push({
        filePath: 'package.json',
        line: 1,
        rule: 'undeclared-in-policy',
        message: `"devDependencies" contains ${canonical}, which REPOSITORY_POLICY does not allow. Allowed: ${describeAllowed(policy)}.`,
      })
    }
  }

  return violations
}

/** Raw clock reads (rule 7). Matches on the masked source; exemptions read the raw line. */
export const findBannedTimeSources = (rawSource: string, filePath: string): ReadonlyArray<Violation> => {
  const maskedCode = maskSource(rawSource)
  const violations: Array<Violation> = []
  const rawLines = rawSource.split(/\r?\n/u)

  for (const { pattern, what } of BANNED_TIME_SOURCES) {
    pattern.lastIndex = 0
    for (const match of maskedCode.matchAll(pattern)) {
      if (match.index === undefined) {
        continue
      }
      const line = lineOfIndex(maskedCode, match.index)
      if ((rawLines[line - 1] ?? '').includes(TIME_SOURCE_ESCAPE_HATCH)) {
        continue
      }
      violations.push({
        filePath,
        line,
        rule: 'banned-time-source',
        message:
          `uses ${what}. All time must come from the injected clock Port (@nerima-games/mc-kernel ClockPort), ` +
          `so that simulation is deterministic and replayable. If this is the adapter that implements the Port, ` +
          `mark the line with a "${TIME_SOURCE_ESCAPE_HATCH}" comment.`,
      })
    }
  }

  return violations
}

// ---------------------------------------------------------------------------
// Filesystem traversal and entry point
// ---------------------------------------------------------------------------

const rootDir = process.cwd()

const toPosix = (filePath: string): string => filePath.split(path.sep).join('/')

const relativeFromRoot = (absolutePath: string): string => toPosix(path.relative(rootDir, absolutePath))

const isTypeScriptSource = (filePath: string): boolean =>
  filePath.endsWith('.ts') && !filePath.endsWith('.d.ts')

/**
 * Shipped source is `index.ts` and everything under `domain/` and `stages/`.
 *
 * The distinction matters for rule 6: `test/` and `scripts/` may import
 * mc-playground-kit (that is what a preview harness is for), shipped source may
 * not. Getting this predicate wrong in the permissive direction would silently
 * legalise the one import this project most needs to forbid.
 */
export const isToolingOrTestPath = (relativePath: string): boolean =>
  !(
    relativePath === 'index.ts' ||
    relativePath.startsWith('domain/') ||
    relativePath.startsWith('stages/')
  )

const collectFrom = async (absolutePath: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(absolutePath, { withFileTypes: true }).catch(() => undefined)

  if (entries === undefined) {
    return isTypeScriptSource(absolutePath) ? [absolutePath] : []
  }

  const nested = await Promise.all(
    entries
      .filter((entry) => !SKIPPED_DIRECTORIES.has(entry.name))
      .map(async (entry) => {
        const child = path.join(absolutePath, entry.name)
        if (entry.isDirectory()) {
          return collectFrom(child)
        }
        return entry.isFile() && isTypeScriptSource(child) ? [child] : []
      }),
  )

  return nested.flat()
}

const collectSourceFiles = async (): Promise<ReadonlyArray<string>> => {
  const perRoot = await Promise.all(SCAN_ROOTS.map((root) => collectFrom(path.join(rootDir, root))))
  return [...new Set(perRoot.flat())].sort()
}

const readDeclaredDependencies = async (): Promise<DeclaredDependencies> => {
  const raw = await readFile(path.join(rootDir, 'package.json'), 'utf8')
  const manifest = JSON.parse(raw) as {
    readonly dependencies?: Readonly<Record<string, string>>
    readonly devDependencies?: Readonly<Record<string, string>>
  }
  return {
    dependencies: new Set(Object.keys(manifest.dependencies ?? {})),
    devDependencies: new Set(Object.keys(manifest.devDependencies ?? {})),
  }
}

export const main = async (): Promise<number> => {
  const violations: Array<Violation> = [...checkPolicyConfiguration()]

  const declared = await readDeclaredDependencies()
  violations.push(...checkDeclaredDependencies(declared))

  const files = await collectSourceFiles()
  const sources = await Promise.all(files.map(async (file) => ({ file, source: await readFile(file, 'utf8') })))

  for (const { file, source } of sources) {
    const relativePath = relativeFromRoot(file)
    const isToolingOrTest = isToolingOrTestPath(relativePath)

    for (const record of parseImports(source)) {
      const importedPackage = extractOrgPackageName(record.specifier)
      if (importedPackage === undefined) {
        continue
      }
      const violation = classifyImport(
        { importedPackage, filePath: relativePath, line: record.line, isToolingOrTest },
        declared,
      )
      if (violation !== undefined) {
        violations.push(violation)
      }
    }

    violations.push(...findBannedTimeSources(source, relativePath))
  }

  if (violations.length === 0) {
    console.log(
      `check-dependency-whitelist: OK — ${String(files.length)} file(s) scanned, ` +
        `allowed direct dependencies: ${describeAllowed()}.`,
    )
    return 0
  }

  console.error(`check-dependency-whitelist: ${String(violations.length)} violation(s):`)
  for (const violation of violations) {
    console.error(`  ${violation.filePath}:${String(violation.line)} [${violation.rule}] ${violation.message}`)
  }
  console.error('')
  console.error('This gate is a hard failure by design. See the header of scripts/check-dependency-whitelist.ts.')
  return 1
}

const isDirectRun = (): boolean => {
  const entry = process.argv[1]
  return entry !== undefined && path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url))
}

if (isDirectRun()) {
  process.exit(await main())
}
