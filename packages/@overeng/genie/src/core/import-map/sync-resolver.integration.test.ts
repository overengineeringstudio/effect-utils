import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Node } from 'typescript/unstable/ast'
import {
  isCallExpression,
  isExportDeclaration,
  isExternalModuleReference,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isImportTypeNode,
  isLiteralTypeNode,
  isStringLiteral,
  SyntaxKind,
} from 'typescript/unstable/ast'
import { describe, expect, it } from 'vitest'

import {
  beginInputRecording,
  endInputRecording,
  inputFileSystem,
} from '../../runtime/node/inputs.ts'
import { runTsFileAnalysis } from '../../runtime/node/ts-api.ts'
import { resolveImportMapSpecifierForImporterSync } from './sync-resolver.ts'

const resolverPath = fileURLToPath(new URL('./sync-resolver.ts', import.meta.url))

/** Decision 0003: pnpm stages this file alone, not its relative dependency closure. */
describe('standalone bootstrap sync resolver', () => {
  it('imports only explicit node: builtins, with no relative module dependencies (decision 0003)', async () => {
    await runTsFileAnalysis({
      cwd: path.dirname(resolverPath),
      initialFiles: [resolverPath],
      use: async (session) => {
        const outcome = await session.analyze(resolverPath)
        expect(outcome.kind).toBe('analyzed')
        if (outcome.kind !== 'analyzed') return

        const specifiers: string[] = []
        const visit = (node: Node): void => {
          // Include type-only imports and re-exports: this module must stay self-contained.
          if (isImportDeclaration(node) || isExportDeclaration(node)) {
            const specifier = node.moduleSpecifier
            if (specifier !== undefined) {
              expect(isStringLiteral(specifier)).toBe(true)
              if (isStringLiteral(specifier)) specifiers.push(specifier.text)
            }
          }
          if (isImportEqualsDeclaration(node) && isExternalModuleReference(node.moduleReference)) {
            const specifier = node.moduleReference.expression
            expect(specifier !== undefined && isStringLiteral(specifier)).toBe(true)
            if (specifier !== undefined && isStringLiteral(specifier)) specifiers.push(specifier.text)
          }
          if (isImportTypeNode(node)) {
            expect(isLiteralTypeNode(node.argument)).toBe(true)
            if (isLiteralTypeNode(node.argument)) {
              expect(isStringLiteral(node.argument.literal)).toBe(true)
              if (isStringLiteral(node.argument.literal)) specifiers.push(node.argument.literal.text)
            }
          }
          if (
            isCallExpression(node) &&
            (node.expression.kind === SyntaxKind.ImportKeyword ||
              (isIdentifier(node.expression) && node.expression.text === 'require'))
          ) {
            const [specifier] = node.arguments
            expect(specifier !== undefined && isStringLiteral(specifier)).toBe(true)
            if (specifier !== undefined && isStringLiteral(specifier)) specifiers.push(specifier.text)
          }
          node.forEachChild((child) => {
            visit(child)
            return undefined
          })
        }
        visit(outcome.analysis.sourceFile)
        expect(specifiers.length).toBeGreaterThan(0)
        expect(
          specifiers.filter((specifier) => !specifier.startsWith('node:') || !isBuiltin(specifier)),
        ).toEqual([])
      },
    })
  })

  it('loads the resolver copied alone into pnpm staging without installed dependencies', () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'genie-sync-resolver-')))
    try {
      copyFileSync(resolverPath, path.join(root, 'sync-resolver.ts'))
      const result = spawnSync(
        'bun',
        [
          '--no-install',
          '-e',
          `
            import assert from 'node:assert/strict'
            import path from 'node:path'
            import {
              isImportMapSpecifier,
              parseImportMapFromPackageJsonContent,
              resolveImportMapSpecifier,
            } from './sync-resolver.ts'
            const importMap = parseImportMapFromPackageJsonContent('{"imports":{"#fixture/*":"./src/*"}}')
            assert.equal(isImportMapSpecifier('#fixture/mod.ts'), true)
            assert.equal(isImportMapSpecifier('effect'), false)
            assert.equal(resolveImportMapSpecifier({
              specifier: '#fixture/mod.ts', importMap, packageJsonDir: process.cwd(),
            }), path.join(process.cwd(), 'src/mod.ts'))
            assert.equal(resolveImportMapSpecifier({
              specifier: '#missing', importMap, packageJsonDir: process.cwd(),
            }), null)
          `,
        ],
        { cwd: root, encoding: 'utf8', timeout: 10_000 },
      )
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr + result.stdout).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('records present and missing import-map and member probes through the injected filesystem', () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'genie-sync-resolver-inputs-')))
    try {
      const sourceDir = path.join(root, 'src')
      const memberDir = path.join(root, 'repos', 'bootstrap-fixture')
      mkdirSync(sourceDir)
      mkdirSync(memberDir, { recursive: true })
      writeFileSync(path.join(root, 'package.json'), '{"imports":{"#fixture/*":"./src/*"}}')
      writeFileSync(path.join(root, 'megarepo.lock'), '{"members":{}}')
      const inputs = beginInputRecording()
      try {
        const options = {
          importerPath: path.join(sourceDir, 'entry.ts'),
          workspaceRoot: root,
          fs: inputFileSystem,
        }
        expect(resolveImportMapSpecifierForImporterSync({ ...options, specifier: '#fixture/mod.ts' })).toBe(
          path.join(sourceDir, 'mod.ts'),
        )
        expect(resolveImportMapSpecifierForImporterSync({ ...options, specifier: '#mr/bootstrap-fixture/mod.ts' })).toBe(
          path.join(memberDir, 'mod.ts'),
        )
        for (const consultedPath of [
          path.join(sourceDir, 'package.json'),
          path.join(sourceDir, 'package.json.genie.ts'),
          path.join(root, 'package.json'),
          path.join(root, 'megarepo.lock'),
          memberDir,
        ]) {
          expect(inputs.has(consultedPath), consultedPath).toBe(true)
        }
      } finally {
        endInputRecording()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
