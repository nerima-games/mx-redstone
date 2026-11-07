import { resolve } from 'node:path'
import { describe, expect, it } from '@effect/vitest'
import * as ts from 'typescript/unstable/ast'
import { API } from 'typescript/unstable/sync'
import { scenarioRegistry } from '../apps/browser-harness/scenario-registry.js'
import {
  verificationAngles,
  verificationLedger,
  plannedScenarioIds,
  type VerificationAngle,
  type VerificationCell,
  type VerificationLedger,
} from './support/redstone-verification-matrix.js'

type CoveredCell = Extract<VerificationCell, { status: 'covered' }>

const parseSourceFiles = (files: ReadonlyArray<string>): ReadonlyMap<string, ts.SourceFile> => {
  const filePaths = new Map(files.map((file) => [file, resolve(process.cwd(), file)]))
  const api = new API({ cwd: process.cwd() })
  try {
    const snapshot = api.updateSnapshot({ openFiles: [...filePaths.values()] })
    try {
      const parsedFiles = new Map<string, ts.SourceFile>()
      for (const [file, filePath] of filePaths) {
        const project = snapshot.getDefaultProjectForFile(filePath)
        if (project === undefined) {
          throw new Error(`TypeScript did not create a project for ${file}`)
        }
        const sourceFile = project.program.getSourceFile(filePath)
        if (sourceFile === undefined) {
          throw new Error(`TypeScript did not parse ${file}`)
        }
        parsedFiles.set(file, sourceFile)
      }
      return parsedFiles
    } finally {
      snapshot.dispose()
    }
  } finally {
    api.close()
  }
}

const componentKinds = (): ReadonlyArray<string> => {
  const sourceFile = parseSourceFiles(['src/domain/power-graph.ts']).get('src/domain/power-graph.ts')
  if (sourceFile === undefined) {
    throw new Error('ComponentKind source file was not parsed')
  }
  const alias = sourceFile.statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === 'ComponentKind',
  )
  if (alias === undefined) {
    throw new Error('ComponentKind type alias was not found in src/domain/power-graph.ts')
  }
  if (!ts.isUnionTypeNode(alias.type)) {
    throw new Error('ComponentKind must remain a string-literal union')
  }

  return alias.type.types.map((member) => {
    if (!ts.isLiteralTypeNode(member) || !ts.isStringLiteral(member.literal)) {
      throw new Error('ComponentKind contains a non-string-literal member')
    }
    return member.literal.text
  })
}

const componentSubjects = [...componentKinds(), 'sticky-piston']

const ledgerProblems = (
  ledger: VerificationLedger,
  subjects: ReadonlyArray<string>,
  angles: ReadonlyArray<VerificationAngle>,
): ReadonlyArray<string> => {
  const problems: Array<string> = []
  const subjectSet = new Set(subjects)
  const angleSet = new Set<string>(angles)

  for (const subject of subjects) {
    if (!Object.hasOwn(ledger, subject)) {
      problems.push(`missing ledger subject ${subject}`)
    }
  }

  for (const subject of Object.keys(ledger)) {
    if (!subjectSet.has(subject)) {
      problems.push(`unexpected ledger subject ${subject}`)
    }

    const cells = ledger[subject]
    if (cells === undefined) {
      problems.push(`subject ${subject} has no angle map`)
      continue
    }

    for (const angle of angles) {
      const cell = cells[angle]
      if (cell === undefined) {
        problems.push(`missing angle ${angle} for ${subject}`)
        continue
      }

      if (cell.status === 'excluded') {
        if (cell.reason.trim().length === 0) {
          problems.push(`exclusion ${subject}/${angle} has no reason`)
        }
        if (cell.evidence.trim().length === 0 || !/\S+:\d+/.test(cell.evidence)) {
          problems.push(`exclusion ${subject}/${angle} has no file:line evidence`)
        }
      }
      if (cell.status === 'gap' && cell.reason.trim().length === 0) {
        problems.push(`gap ${subject}/${angle} has no reason`)
      }
      if (cell.status === 'covered' && (cell.file.trim().length === 0 || cell.test.trim().length === 0)) {
        problems.push(`coverage ${subject}/${angle} has no file or test title`)
      }
    }

    for (const angle of Object.keys(cells)) {
      if (!angleSet.has(angle)) {
        problems.push(`unexpected angle ${angle} for ${subject}`)
      }
    }
  }

  return problems
}

const isTestTitleCall = (expression: ts.Expression): boolean => {
  if (ts.isIdentifier(expression)) {
    return expression.text === 'it' || expression.text === 'test'
  }
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === 'effect' &&
    ts.isIdentifier(expression.expression) &&
    (expression.expression.text === 'it' || expression.expression.text === 'test')
  )
}

const stringProperties = (object: ts.ObjectLiteralExpression): ReadonlyMap<string, string> => {
  const properties = new Map<string, string>()
  for (const property of object.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      ts.isStringLiteral(property.initializer)
    ) {
      properties.set(property.name.text, property.initializer.text)
    }
  }
  return properties
}

const caseRows = (sourceFile: ts.SourceFile): ReadonlyArray<ReadonlyMap<string, string>> | undefined => {
  let rows: ReadonlyArray<ReadonlyMap<string, string>> | undefined = undefined
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'cases' &&
      node.initializer !== undefined &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      const foundRows: Array<ReadonlyMap<string, string>> = []
      for (const element of node.initializer.elements) {
        if (ts.isObjectLiteralExpression(element)) {
          foundRows.push(stringProperties(element))
        }
      }
      if (
        rows === undefined &&
        foundRows.length > 0 &&
        foundRows.every((row) => row.has('block') && row.has('kind'))
      ) {
        rows = foundRows
      }
    }
    node.forEachChild(visit)
  }
  visit(sourceFile)
  return rows
}

const forOfVariable = (statement: ts.ForOfStatement): string | undefined => {
  if (!ts.isVariableDeclarationList(statement.initializer)) return undefined
  const declaration = statement.initializer.declarations[0]
  if (declaration === undefined || !ts.isIdentifier(declaration.name)) return undefined
  return declaration.name.text
}

const expandTitle = (
  template: ts.TemplateExpression,
  variable: string,
  values: ReadonlyMap<string, string>,
): string | undefined => {
  let title = template.head.text
  for (const span of template.templateSpans) {
    if (
      !ts.isPropertyAccessExpression(span.expression) ||
      !ts.isIdentifier(span.expression.expression) ||
      span.expression.expression.text !== variable
    ) {
      return undefined
    }
    const value = values.get(span.expression.name.text)
    if (value === undefined) return undefined
    title += `${value}${span.literal.text}`
  }
  return title
}

const addGeneratedTitles = (
  node: ts.Node,
  variable: string,
  rows: ReadonlyArray<ReadonlyMap<string, string>>,
  titles: Set<string>,
): void => {
  if (ts.isCallExpression(node) && isTestTitleCall(node.expression)) {
    const title = node.arguments[0]
    if (title !== undefined && ts.isTemplateExpression(title)) {
      for (const row of rows) {
        const expanded = expandTitle(title, variable, row)
        if (expanded !== undefined) titles.add(expanded)
      }
    }
  }
  node.forEachChild((child) => addGeneratedTitles(child, variable, rows, titles))
}

const testTitles = (sourceFile: ts.SourceFile): ReadonlySet<string> => {
  const titles = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isTestTitleCall(node.expression)) {
      const title = node.arguments[0]
      if (title !== undefined && (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title))) {
        titles.add(title.text)
      }
    }
    if (
      ts.isForOfStatement(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'cases'
    ) {
      const variable = forOfVariable(node)
      const rows = caseRows(sourceFile)
      if (variable !== undefined && rows !== undefined) {
        addGeneratedTitles(node.statement, variable, rows, titles)
      }
    }
    if (
      ts.isForOfStatement(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'scenarioRegistry'
    ) {
      const variable = forOfVariable(node)
      if (variable !== undefined) {
        const rows = scenarioRegistry.map(({ id }) => new Map<string, string>([['id', id]]))
        addGeneratedTitles(node.statement, variable, rows, titles)
      }
    }
    node.forEachChild(visit)
  }
  visit(sourceFile)
  return titles
}

const coveredTitleProblems = (ledger: VerificationLedger): ReadonlyArray<string> => {
  const problems: Array<string> = []
  const cellsByFile = new Map<string, Array<Readonly<{ subject: string; angle: string; cell: CoveredCell }>>>()

  for (const [subject, cells] of Object.entries(ledger)) {
    if (cells === undefined) continue
    for (const [angle, cell] of Object.entries(cells)) {
      if (cell === undefined || cell.status !== 'covered') continue
      const fileCells = cellsByFile.get(cell.file) ?? []
      fileCells.push({ subject, angle, cell })
      cellsByFile.set(cell.file, fileCells)
    }
  }

  const titlesByFile = new Map(
    [...parseSourceFiles([...cellsByFile.keys()])].map(([file, sourceFile]) => [file, testTitles(sourceFile)]),
  )

  for (const [file, cells] of cellsByFile) {
    const titles = titlesByFile.get(file)
    if (titles === undefined) {
      throw new Error(`test titles were not read for ${file}`)
    }
    for (const { subject, angle, cell } of cells) {
      if (!titles.has(cell.test)) {
        problems.push(`missing test title ${JSON.stringify(cell.test)} in ${file} for ${subject}/${angle}`)
      }
    }
  }

  return problems
}

const statusCounts = { covered: 0, excluded: 0, gap: 0 }
for (const cells of Object.values(verificationLedger)) {
  for (const cell of Object.values(cells)) {
    if (cell !== undefined) statusCounts[cell.status] += 1
  }
}

describe('redstone verification matrix', () => {
  it(`covers the source kinds and all ten angles (${statusCounts.covered} covered, ${statusCounts.excluded} excluded, ${statusCounts.gap} gaps)`, () => {
    // Catches a new component, missing angle, stray row, or unsupported exclusion becoming invisible.
    expect(verificationAngles).toHaveLength(10)
    expect(new Set(verificationAngles).size).toBe(10)
    expect(statusCounts).toStrictEqual({ covered: 157, excluded: 33, gap: 0 })
    expect(ledgerProblems(verificationLedger, componentSubjects, verificationAngles)).toStrictEqual([])
  })

  it('points every covered cell at an existing test title', () => {
    // Catches stale coverage references after a test is renamed or removed.
    expect(coveredTitleProblems(verificationLedger)).toStrictEqual([])
  })

  it('registers every plan scenario exactly once', () => {
    // Catches scenario drift, duplicates, or missing registrations against the planned scenario set.
    const expectedIds = plannedScenarioIds
    const actualIds = scenarioRegistry.map(({ id }) => id)
    expect(expectedIds).toHaveLength(23)
    expect(new Set(expectedIds).size).toBe(23)
    expect(actualIds).toHaveLength(23)
    expect(new Set(actualIds).size).toBe(23)
    expect([...actualIds].sort()).toStrictEqual([...expectedIds].sort())
  })

  it('rejects a ledger with one missing angle', () => {
    // Catches a completeness validator that passes when one coverage cell disappears.
    const subject = componentSubjects.find((candidate) => verificationLedger[candidate] !== undefined)
    if (subject === undefined) {
      throw new Error('verification ledger has no subject for the negative control')
    }
    const cells = verificationLedger[subject]
    if (cells === undefined) {
      throw new Error(`verification ledger has no angle map for ${subject}`)
    }
    const angle = verificationAngles.find((candidate) => cells[candidate] !== undefined)
    if (angle === undefined) {
      throw new Error(`verification ledger has no cell for ${subject}`)
    }

    const { [angle]: removedCell, ...remainingCells } = cells
    const brokenLedger: VerificationLedger = { ...verificationLedger, [subject]: remainingCells }
    expect(removedCell).not.toBeUndefined()
    expect(ledgerProblems(brokenLedger, componentSubjects, verificationAngles)).toContain(
      `missing angle ${angle} for ${subject}`,
    )
  })
})
