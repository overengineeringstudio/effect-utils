import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
  isStringLiteral,
  isNoSubstitutionTemplateLiteral,
  SyntaxKind,
} from 'typescript/unstable/ast'
import { describe, expect, it } from 'vitest'

import { runTsFileAnalysis } from '../../runtime/node/ts-api.ts'

const root = fileURLToPath(new URL('../../../../../../', import.meta.url))

// This repository-wide fixture is read at runtime, not included in Genie's package closure.
const inventory = JSON.parse(
  readFileSync(path.join(root, 'nix/standalone-staging.json'), 'utf8'),
) as {
  readonly extensions: Readonly<Record<string, boolean>>
  readonly nixFiles: Readonly<Record<string, NixFileClassification>>
  readonly sources: readonly (StagedSource & {
    readonly initializationError: string
    readonly allowedImports: Readonly<Record<string, string>>
  })[]
}

// Classify every Nix file containing a JS/TS reference, regardless of syntax or
// position. This intentionally has no Nix/shell statement parser.
const extensionPattern = Object.keys(inventory.extensions)
  .map((extension) => extension.slice(1))
  .join('|')
const sourceReferences = new RegExp('[\\w./${}-]+\\.(?:' + extensionPattern + ')\\b', 'g')

type NixFileClassification = {
  readonly stages?: boolean
  readonly noStandaloneStaging?: string
}

type StagedSource = {
  readonly source: string
  readonly nix: readonly string[]
}

const checkNixFileInventory = ({
  files,
  classifications,
  sources,
}: {
  readonly files: Readonly<Record<string, string>>
  readonly classifications: Readonly<Record<string, NixFileClassification>>
  readonly sources: readonly StagedSource[]
}): string[] => {
  const errors: string[] = []
  const references: Record<string, readonly string[]> = {}
  for (const [nix, content] of Object.entries(files)) {
    const found = [...content.matchAll(sourceReferences)].map((match) => match[0])
    references[nix] = found
    if (found.length > 0 && classifications[nix] === undefined) {
      errors.push(
        `${nix}: unclassified Nix file references ${found[0]}; in nix/standalone-staging.json nixFiles["${nix}"], add {"stages": true} plus sources entries for standalone files, or {"noStandaloneStaging": "<reason>"} when no repository JS/TS source is staged alone`,
      )
    }
  }
  for (const [nix, classification] of Object.entries(classifications)) {
    if ((references[nix]?.length ?? 0) === 0) {
      errors.push(`${nix}: stale Nix-file classification has no JS/TS references`)
    }
    const stages = classification.stages === true
    const noStandalone =
      typeof classification.noStandaloneStaging === 'string' &&
      classification.noStandaloneStaging.trim().length > 0
    if (stages === noStandalone) {
      errors.push(`${nix}: classify as either stages or noStandaloneStaging with a nonempty reason`)
    }
    if (stages === true && sources.some((entry) => entry.nix.includes(nix)) === false) {
      errors.push(`${nix}: stages file has no standalone inventory entry`)
    }
  }
  for (const entry of sources) {
    for (const nix of entry.nix) {
      if (classifications[nix]?.stages !== true) {
        errors.push(`${nix}: standalone source ${entry.source} requires a stages classification`)
      }
      const appears = (references[nix] ?? []).some((reference) => {
        const literal = reference.replace(/^\$\{/, '')
        if (literal.startsWith('./') === true || literal.startsWith('../') === true) {
          return (
            path.posix.normalize(path.posix.join(path.posix.dirname(nix), literal)) === entry.source
          )
        }
        // Concatenated root suffixes and scoped paths appear as fragments.
        // The all-position token scan splits at @; never accept only a basename.
        const fragment = literal.replace(/^\//, '')
        return (
          fragment === entry.source ||
          (fragment.includes('/') === true && entry.source.endsWith(fragment))
        )
      })
      if (appears === false) {
        errors.push(`${nix}: stale standalone source reference ${entry.source}`)
      }
    }
  }
  return errors
}

const assertIsolatableExtension = (source: string): void => {
  expect(
    Object.entries(inventory.extensions).some(
      ([extension, supported]) => path.extname(source) === extension && supported === true,
    ),
    `${source}: unsupported standalone source extension; Node 24 cannot import JSX/TSX without transformation. See extensions in nix/standalone-staging.json.`,
  ).toBe(true)
}

// bun:ffi is provided by Bun, not node_modules. Keep this exact rather than
// accepting arbitrary bun: specifiers. The isolated Node load below still
// requires Bun-only imports to stay off the Node initialization path.
const isRuntimeBuiltin = (specifier: string): boolean =>
  isBuiltin(specifier) || specifier === 'bun:ffi'

const runtimeSpecifiers = (sourceFile: Node, source: string): string[] => {
  const specifiers: string[] = []
  const record = (node: Node | undefined): void => {
    expect(
      node !== undefined &&
        (isStringLiteral(node) === true || isNoSubstitutionTemplateLiteral(node) === true),
      `${source}: non-literal module dependency cannot be checked in isolation`,
    ).toBe(true)
    if (
      node !== undefined &&
      (isStringLiteral(node) === true || isNoSubstitutionTemplateLiteral(node) === true)
    )
      specifiers.push(node.text)
  }
  const visit = (node: Node): void => {
    // Node stripping retains inline-only imports as `import {} from ...`.
    // Only a whole-declaration `import type` / `export type` erases the edge.
    if (
      isImportDeclaration(node) === true &&
      node.importClause?.phaseModifier !== SyntaxKind.TypeKeyword
    )
      record(node.moduleSpecifier)
    if (
      isExportDeclaration(node) === true &&
      node.isTypeOnly === false &&
      node.moduleSpecifier !== undefined
    )
      record(node.moduleSpecifier)
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
  visit(sourceFile)
  return specifiers
}

describe('standalone Nix-staged JS/TS sources (issue #1994)', () => {
  it.each([
    ['node:fs', true],
    ['fs', true],
    ['bun:ffi', true],
    ['bun:missing', false],
    ['some-package', false],
    ['./sibling.ts', false],
  ] as const)(
    'classifies runtime builtin %s without admitting unstaged packages',
    (specifier, builtin) => {
      expect(isRuntimeBuiltin(specifier)).toBe(builtin)
    },
  )

  for (const fixture of [
    {
      name: 'whole type import',
      code: "import type { X } from './sib.ts'",
      node: 0,
      bun: 0,
      edges: [],
    },
    {
      name: 'inline-only type import',
      code: "import { type X } from './sib.ts'",
      node: 1,
      bun: 0,
      edges: ['./sib.ts'],
    },
    { name: 'side-effect import', code: "import './sib.ts'", node: 1, bun: 1, edges: ['./sib.ts'] },
    {
      name: 'mixed import',
      code: "import { type X, y } from './sib.ts'; console.log(y)",
      node: 1,
      bun: 1,
      edges: ['./sib.ts'],
    },
  ]) {
    it(`classifies ${fixture.name} consistently with isolated Node stripping`, async () => {
      const isolated = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'staging-import-form-')))
      try {
        const source = path.join(isolated, 'fixture.mts')
        writeFileSync(source, fixture.code)
        await runTsFileAnalysis({
          cwd: isolated,
          initialFiles: [source],
          use: async (session) => {
            const outcome = await session.analyze(source)
            expect(outcome.kind).toBe('analyzed')
            if (outcome.kind !== 'analyzed') return
            expect(runtimeSpecifiers(outcome.analysis.sourceFile, fixture.name)).toEqual(
              fixture.edges,
            )
          },
        })
        for (const [runtime, expected] of [
          [process.env.NODE_BIN ?? 'node', fixture.node],
          [process.env.BUN_BIN ?? 'bun', fixture.bun],
        ] as const) {
          const result = spawnSync(runtime, [source], {
            cwd: isolated,
            encoding: 'utf8',
            timeout: 10_000,
            env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', BUN_OPTIONS: '' },
          })
          expect(result.status, `${fixture.name}: ${runtime}: ${result.stderr}`).toBe(expected)
          if (expected !== 0) expect(result.stderr).toContain('sib.ts')
        }
      } finally {
        rmSync(isolated, { recursive: true, force: true })
      }
    })
  }

  it('classifies every Nix file with JS/TS references and rejects stale inventory', () => {
    const result = spawnSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*.nix'],
      { cwd: root, encoding: 'utf8' },
    )
    expect(result.status, result.stderr).toBe(0)
    const files: Record<string, string> = {}
    for (const nix of new Set(result.stdout.split('\0').filter(Boolean))) {
      files[nix] = readFileSync(path.join(root, nix), 'utf8')
    }
    expect(
      checkNixFileInventory({
        files,
        classifications: inventory.nixFiles,
        sources: inventory.sources,
      }),
    ).toEqual([])
  })

  it.each([
    ['relative readFile', 'builtins.readFile ./x.ts;'],
    ['CommonJS TypeScript readFile', 'builtins.readFile ./x.cts;'],
    ['concatenated readFile', 'builtins.readFile (base + "/x.ts");'],
    ['interpolated readFile', 'builtins.readFile "${root}/x.mjs";'],
    ['known-root interpolation', 'builtins.readFile "${repoRoot}/scripts/x.mjs";'],
    ['workspace-relative cp', 'cp scripts/x.mjs "$out"'],
    ['interpolated cp', 'cp ${src}/x.ts "$out"'],
    ['interpolated install', 'install -m 755 ${src}/x.ts "$out"'],
    ['attrset after semicolon', 'builtins.path { name = "fixture"; path = "${src}/x.ts"; };'],
    ['copyPathToStore', 'builtins.copyPathToStore "${src}/x.ts";'],
    ['nested writeText/readFile', 'pkgs.writeText "runner" (builtins.readFile "${root}/x.mjs");'],
    ['cp target directory', 'cp -t "$out" scripts/x.mjs'],
    ['install target directory', 'install -t "$out" scripts/x.mjs'],
    [
      'let-bound interpolation',
      'let script = "${root}/x.mjs"; in pkgs.writeText "runner" (builtins.readFile script);',
    ],
    ['scoped constructor', 'with builtins; readFile ./x.ts'],
    ['writeTextFile', 'pkgs.writeTextFile { name = "x.ts"; text = source; }'],
    ['fileContents', 'lib.fileContents ./x.ts'],
    ['toFile', 'builtins.toFile "x.ts" source'],
  ])('rejects a new unclassified file containing %s', (_name, content) => {
    expect(
      checkNixFileInventory({
        files: { 'fixture.nix': content },
        classifications: {},
        sources: [],
      }).some((error) => error.includes('unclassified Nix file')),
    ).toBe(true)
  })

  it('rejects a stale source even when its output basename remains', () => {
    expect(
      checkNixFileInventory({
        files: { 'fixture.nix': 'pkgs.writeText "missing.ts" (builtins.readFile ./present.ts);' },
        classifications: { 'fixture.nix': { stages: true } },
        sources: [{ source: 'scripts/missing.ts', nix: ['fixture.nix'] }],
      }),
    ).toContain('fixture.nix: stale standalone source reference scripts/missing.ts')
  })

  it('rejects a stages file without a standalone entry', () => {
    expect(
      checkNixFileInventory({
        files: { 'fixture.nix': 'builtins.readFile ./x.ts;' },
        classifications: { 'fixture.nix': { stages: true } },
        sources: [],
      }),
    ).toContain('fixture.nix: stages file has no standalone inventory entry')
  })

  it('requires a reason for noStandaloneStaging', () => {
    expect(
      checkNixFileInventory({
        files: { 'fixture.nix': 'bun ./x.ts' },
        classifications: { 'fixture.nix': { noStandaloneStaging: '' } },
        sources: [],
      }),
    ).toContain(
      'fixture.nix: classify as either stages or noStandaloneStaging with a nonempty reason',
    )
  })

  it('documents the computed-extension residual', () => {
    expect(
      checkNixFileInventory({
        files: { 'fixture.nix': 'builtins.readFile ("x." + "ts");' },
        classifications: {},
        sources: [],
      }),
    ).toEqual([])
  })

  for (const entry of inventory.sources) {
    it(`${entry.source} imports only runtime builtins or explicitly staged edges`, async () => {
      assertIsolatableExtension(entry.source)
      const source = path.join(root, entry.source)
      await runTsFileAnalysis({
        cwd: path.dirname(source),
        initialFiles: [source],
        use: async (session) => {
          const outcome = await session.analyze(source)
          expect(outcome.kind).toBe('analyzed')
          if (outcome.kind !== 'analyzed') return
          const specifiers = runtimeSpecifiers(outcome.analysis.sourceFile, entry.source)
          const allowed = entry.allowedImports
          expect(
            specifiers.filter(
              (specifier) => !isRuntimeBuiltin(specifier) && !Object.hasOwn(allowed, specifier),
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
      assertIsolatableExtension(entry.source)
      const isolated = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'standalone-staging-')))
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
