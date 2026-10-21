import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import type { Node } from 'typescript/unstable/ast'
import {
  isCallExpression,
  isExportDeclaration,
  isExternalModuleReference,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isNamedExports,
  isNamedImports,
  isStringLiteral,
  isNoSubstitutionTemplateLiteral,
  SyntaxKind,
} from 'typescript/unstable/ast'
import { describe, expect, it } from 'vitest'

import inventory from '../../../../../../nix/standalone-staging.json'
import { runTsFileAnalysis } from '../../runtime/node/ts-api.ts'

const root = fileURLToPath(new URL('../../../../../../', import.meta.url))

// Conservative by design: all literal repo JS/TS paths in Nix are reviewed, not
// just known writeText spellings. This includes readFile, interpolation, path
// values, builtins.path/copyPathToStore and cp. Workspace commands and deliberate
// closures need a source + Nix-file exemption with a reason in the inventory.
// Concatenated paths support a literal relative base or a repo-root variable.
// Keep JS/TS staging paths literal: computed paths cannot be inventoried reliably.
const sourceReferences =
  /(?<base>\.{1,2}\/[\w./@+-]+|\b\w+)\s*\+\s*"(?<suffix>\/[^"\n]+\.(?:ts|mts|mjs|cjs|js))"|(?<direct>\.{1,2}\/[\w./@+-]+\.(?:ts|mts|mjs|cjs|js))\b/g

describe('standalone Nix-staged JS/TS sources (issue #1994)', () => {
  it('inventories every literal source reference in Nix', () => {
    const files = spawnSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*.nix'],
      { cwd: root, encoding: 'utf8' },
    )
    expect(files.status, files.stderr).toBe(0)
    const found = new Set<string>()
    const missing: string[] = []
    for (const nix of new Set(files.stdout.split('\0').filter(Boolean))) {
      const content = readFileSync(path.join(root, nix), 'utf8')
      for (const match of content.matchAll(sourceReferences)) {
        const prefix = content.slice(content.lastIndexOf('\n', match.index) + 1, match.index)
        if (prefix.trimStart().startsWith('#') === true) continue
        const { base, suffix, direct } = match.groups!
        const source = path.relative(
          root,
          base !== undefined
            ? path.resolve(
                base.startsWith('.') === true ? path.resolve(root, path.dirname(nix), base) : root,
                `.${suffix}`,
              )
            : path.resolve(root, path.dirname(nix), direct!),
        )
        const key = `${nix}:${source}`
        found.add(key)
        if (
          inventory.sources.some((entry) => entry.source === source && entry.nix.includes(nix)) ===
            false &&
          inventory.exemptions.some(
            (entry) =>
              entry.source === source && entry.nix === nix && entry.reason.trim().length > 0,
          ) === false
        ) {
          missing.push(`${nix}:${content.slice(0, match.index).split('\n').length} -> ${source}`)
        }
      }
    }
    expect(
      missing,
      'Add standalone sources (or an explicit closure/workspace exemption with a reason) to nix/standalone-staging.json',
    ).toEqual([])
    for (const entry of inventory.sources) {
      for (const nix of entry.nix)
        expect(found.has(`${nix}:${entry.source}`), `Stale staging: ${nix}:${entry.source}`).toBe(
          true,
        )
    }
    for (const entry of inventory.exemptions)
      expect(
        found.has(`${entry.nix}:${entry.source}`),
        `Stale exemption: ${entry.nix}:${entry.source}`,
      ).toBe(true)
  })

  for (const entry of inventory.sources) {
    it(`${entry.source} imports only Node builtins or explicitly staged edges`, async () => {
      const source = path.join(root, entry.source)
      await runTsFileAnalysis({
        cwd: path.dirname(source),
        initialFiles: [source],
        use: async (session) => {
          const outcome = await session.analyze(source)
          expect(outcome.kind).toBe('analyzed')
          if (outcome.kind !== 'analyzed') return
          const specifiers: string[] = []
          const record = (node: Node | undefined): void => {
            expect(
              node !== undefined &&
                (isStringLiteral(node) === true || isNoSubstitutionTemplateLiteral(node) === true),
              `${entry.source}: non-literal module dependency cannot be checked in isolation`,
            ).toBe(true)
            if (
              node !== undefined &&
              (isStringLiteral(node) === true || isNoSubstitutionTemplateLiteral(node) === true)
            )
              specifiers.push(node.text)
          }
          const visit = (node: Node): void => {
            // Type-only edges are erased by Bun/TypeScript and need no staged file.
            if (isImportDeclaration(node) === true && node.importClause?.isTypeOnly !== true) {
              const clause = node.importClause
              const bindings = clause?.namedBindings
              const erased =
                clause?.name === undefined &&
                bindings !== undefined &&
                isNamedImports(bindings) &&
                bindings.elements.length > 0 &&
                bindings.elements.every((element) => element.isTypeOnly)
              if (erased === false) record(node.moduleSpecifier)
            }
            if (
              isExportDeclaration(node) === true &&
              node.isTypeOnly === false &&
              node.moduleSpecifier !== undefined
            ) {
              const clause = node.exportClause
              const erased =
                clause !== undefined &&
                isNamedExports(clause) &&
                clause.elements.length > 0 &&
                clause.elements.every((element) => element.isTypeOnly)
              if (erased === false) record(node.moduleSpecifier)
            }
            if (
              isImportEqualsDeclaration(node) === true &&
              node.isTypeOnly === false &&
              isExternalModuleReference(node.moduleReference) === true
            )
              record(node.moduleReference.expression)
            if (
              isCallExpression(node) === true &&
              (node.expression.kind === SyntaxKind.ImportKeyword ||
                (isIdentifier(node.expression) === true && node.expression.text === 'require'))
            )
              record(node.arguments[0])
            node.forEachChild((child) => {
              visit(child)
              return undefined
            })
          }
          visit(outcome.analysis.sourceFile)
          const allowed = entry.allowedImports
          expect(
            specifiers.filter(
              (specifier) => !isBuiltin(specifier) && !Object.hasOwn(allowed, specifier),
            ),
            entry.source,
          ).toEqual([])
          for (const [specifier, target] of Object.entries(allowed)) {
            expect(specifiers, `Stale allowed edge: ${entry.source} -> ${specifier}`).toContain(
              specifier,
            )
            expect(
              inventory.sources.some((candidate) => candidate.source === target),
              `Allowed edge must itself be isolation-checked: ${target}`,
            ).toBe(true)
          }
        },
      })
    })
    it(`${entry.source} loads from an isolated directory without node_modules`, () => {
      const isolated = mkdtempSync(path.join(os.tmpdir(), 'standalone-staging-'))
      try {
        // Node 24 strips TS types without resolving erased type-only imports.
        // CLI-only entries may stop at a declared, exact argument-validation error.
        const destination = path.join(isolated, path.basename(entry.source))
        let content = readFileSync(path.join(root, entry.source), 'utf8')
        for (const [specifier, target] of Object.entries(entry.allowedImports)) {
          const stagedTarget = path.join(isolated, path.basename(target))
          writeFileSync(stagedTarget, readFileSync(path.join(root, target)))
          content = content.replaceAll(specifier, pathToFileURL(stagedTarget).href)
        }
        writeFileSync(destination, content)
        // The native hook registers a resolver for an explicitly supplied path.
        // Importing it does not load the native package itself.
        mkdirSync(path.join(isolated, 'native/lib'), { recursive: true })
        writeFileSync(path.join(isolated, 'native/lib/index.js'), '')
        const result = spawnSync(
          'node',
          [
            '--input-type=module',
            '-e',
            `
          try {
            // Runtime-selected isolated path: exercise the module loading boundary.
            await import(${JSON.stringify(pathToFileURL(destination).href)})
            if (${JSON.stringify(entry.initializationError)} !== '') throw new Error('Expected CLI argument validation')
          } catch (error) {
            if (${JSON.stringify(entry.initializationError)} === '' ||
                error.message !== ${JSON.stringify(entry.initializationError)}) throw error
          }
        `,
          ],
          {
            cwd: isolated,
            encoding: 'utf8',
            timeout: 10_000,
            env: {
              ...process.env,
              NODE_OPTIONS: '',
              NODE_PATH: '',
              NODE_PTY_NATIVE_PACKAGE: path.join(isolated, 'native'),
              NODE_MODULES_DIRS: '',
              NODE_MODULES_HELPER_MODE: 'health',
              PNPM_ROOT_MODULES_YAML: 'node_modules/.modules.yaml',
              PNPM_CONFIG_ENABLE_GLOBAL_VIRTUAL_STORE: 'false',
            },
          },
        )
        expect(result.error).toBeUndefined()
        expect(result.status, result.stderr + result.stdout).toBe(0)
      } finally {
        rmSync(isolated, { recursive: true, force: true })
      }
    })
  }
})
