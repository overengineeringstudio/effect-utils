import { readdirSync, readFileSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '../../..', '..', '..')
const packagesRoot = resolve(repoRoot, 'packages/@overeng')

const rawOtelCall = /\b(?:Effect|Stream)\.(?:withSpan|annotateCurrentSpan)\s*\(/g

const allowedRawOtelFiles = new Set([
  'packages/@overeng/otel-contract/src/mod.ts',
  'packages/@overeng/notion-datasource-sync/src/observability/observability.ts',
  'packages/@overeng/utils-dev/src/otelite/otel.ts',
])

const isProductionSource = (path: string) =>
  path.endsWith('.ts') &&
  path.includes('/src/') &&
  path.includes('/node_modules/') === false &&
  path.includes('/dist/') === false &&
  path.includes('/examples/') === false &&
  path.includes('/__tests__/') === false &&
  /\.(?:test|unit\.test|integration\.test|e2e\.test)\.ts$/.test(path) === false

const sourceFiles = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir).flatMap((entry) => {
    const path = resolve(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory() === true) return sourceFiles(path)
    return isProductionSource(path) === true ? [path] : []
  })

const removeComments = (source: string) =>
  ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      removeComments: true,
      target: ts.ScriptTarget.ESNext,
    },
  }).outputText

describe('raw OTEL boundary', () => {
  it('routes production span instrumentation through schema-backed helpers', () => {
    const violations = sourceFiles(packagesRoot).flatMap((path) => {
      const relativePath = relative(repoRoot, path)
      if (allowedRawOtelFiles.has(relativePath) === true) return []

      const source = removeComments(readFileSync(path, 'utf8'))
      return [...source.matchAll(rawOtelCall)].map((match) => `${relativePath}:${match[0]}`)
    })

    expect(violations).toEqual([])
  })
})
