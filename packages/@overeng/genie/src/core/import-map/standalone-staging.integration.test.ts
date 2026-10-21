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

// Inventory literal paths conservatively, then inspect staging operations too.
// Unresolved extension-bearing arguments fail closed and require an exact,
// reasoned operation/argument exemption, rather than silently escaping the scan.
const extensionPattern = Object.keys(inventory.extensions)
  .map((extension) => extension.slice(1))
  .join('|')
const sourceReferences = new RegExp(
  String.raw`(?<base>\.{1,2}\/[\w./@+-]+|\b\w+)\s*\+\s*"(?<suffix>\/[^"\n]+\.(?:${extensionPattern}))"|(?<direct>\.{1,2}\/[\w./@+-]+\.(?:${extensionPattern}))\b`,
  'g',
)

type StagingReference = {
  readonly source: string | undefined
  readonly argument: string
  readonly operation: string
  readonly index: number
  readonly end: number
}

const repositoryRoots: Record<string, true> = {
  repoRoot: true,
  repositoryRoot: true,
  sourceRoot: true,
}

const scanStagingReferences = (nix: string, content: string): StagingReference[] => {
  const references: StagingReference[] = []
  const inComment = (index: number): boolean =>
    content
      .slice(content.lastIndexOf('\n', index) + 1, index)
      .trimStart()
      .startsWith('#')
  for (const match of content.matchAll(sourceReferences)) {
    if (inComment(match.index) === true) continue
    const { base, suffix, direct } = match.groups!
    const resolvable =
      base === undefined || base.startsWith('.') === true || Object.hasOwn(repositoryRoots, base)
    const source =
      resolvable === true
        ? path.relative(
            root,
            base !== undefined
              ? path.resolve(
                  base.startsWith('.') === true
                    ? path.resolve(root, path.dirname(nix), base)
                    : root,
                  `.${suffix}`,
                )
              : path.resolve(root, path.dirname(nix), direct!),
          )
        : undefined
    references.push({
      source,
      argument: match[0],
      operation: 'path',
      index: match.index,
      end: match.index + match[0].length,
    })
  }

  const fileTokens = new RegExp(
    String.raw`(?:\$\{[^}\n]+\}|[\w@./$+-])(?:\$\{[^}\n]+\}|[\w@./$+-])*\.(?:${extensionPattern})\b`,
    'g',
  )
  const inspect = (operation: string, body: string, offset: number): void => {
    const tokens = [...body.matchAll(fileTokens)]
    const covered =
      references.some(
        (reference) =>
          reference.operation === 'path' &&
          reference.index >= offset &&
          reference.end <= offset + body.length,
      ) || tokens.some((token) => token[0].includes('/'))
    for (const token of tokens) {
      const argument = token[0]
      const index = offset + token.index
      if (
        references.some(
          (reference) =>
            reference.operation === 'path' && index >= reference.index && index < reference.end,
        ) === true
      )
        continue
      // writeText's output basename is not a second source when its source path
      // is already inventoried; a source-less generated file needs an exemption.
      if (
        covered === true &&
        argument.includes('/') === false &&
        (operation.startsWith('write') === true || operation === 'path')
      )
        continue
      const interpolated = argument.match(/^\$\{([^}]+)\}\/(.+)$/)
      const source =
        interpolated !== null
          ? Object.hasOwn(repositoryRoots, interpolated[1]!) === true
            ? interpolated[2]
            : undefined
          : argument.includes('${') === false &&
              argument.includes('$') === false &&
              argument.includes('/') === true &&
              path.isAbsolute(argument) === false
            ? path.posix.normalize(argument)
            : undefined
      references.push({ source, argument, operation, index, end: index + argument.length })
    }
    for (const mention of body.matchAll(new RegExp(String.raw`\.(?:${extensionPattern})\b`, 'g'))) {
      if (
        tokens.some(
          (token) => mention.index >= token.index && mention.index < token.index + token[0].length,
        ) === false
      ) {
        references.push({
          source: undefined,
          argument: body.trim(),
          operation,
          index: offset + mention.index,
          end: offset + body.length,
        })
      }
    }
  }
  // Find the containing Nix expression's terminator without treating semicolons
  // inside strings, interpolations, or attrsets as the end of its arguments.
  const operationEnd = (start: number): number => {
    type Quote = 'double' | 'indented'
    let quote: Quote | undefined
    const stack: { closer: string; quote?: Quote }[] = []
    const closers: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
    for (let index = start; index < content.length; index++) {
      const char = content[index]
      if (quote !== undefined) {
        if (quote === 'double' && char === '\\') {
          index++
          continue
        }
        if (
          quote === 'indented' &&
          content.startsWith("''", index) === true &&
          ["'", '\\', '$'].includes(content[index + 2] ?? '') === true
        ) {
          index += 3
          continue
        }
        if (content.startsWith('${', index) === true) {
          stack.push({ closer: '}', quote })
          quote = undefined
          index++
        } else if (quote === 'double' && char === '"') {
          quote = undefined
        } else if (quote === 'indented' && content.startsWith("''", index) === true) {
          quote = undefined
          index++
        }
        continue
      }
      if (char === '#') {
        const end = content.indexOf('\n', index)
        if (end === -1) return content.length
        index = end
      } else if (content.startsWith('/*', index) === true) {
        const end = content.indexOf('*/', index + 2)
        if (end === -1) return content.length
        index = end + 1
      } else if (char === '"') {
        quote = 'double'
      } else if (content.startsWith("''", index) === true) {
        quote = 'indented'
        index++
      } else if (char !== undefined && Object.hasOwn(closers, char) === true) {
        stack.push({ closer: closers[char]! })
      } else if (stack.length > 0 && char === stack.at(-1)?.closer) {
        quote = stack.pop()?.quote
      } else if (char === ';' && stack.length === 0) {
        return index
      }
    }
    return content.length
  }
  // Conservative statement windows include multiline readFile/writeText and
  // builtins.path arguments. Nested operations are inspected independently.
  for (const match of content.matchAll(
    /\b(?:builtins\.path|(?:builtins\.)?readFile|(?:builtins\.)?copyPathToStore|writeText\w*|writeScript\w*)\b/g,
  )) {
    if (inComment(match.index) === true) continue
    const start = match.index + match[0].length
    inspect(match[0].replace('builtins.', ''), content.slice(start, operationEnd(start)), start)
  }
  for (const match of content.matchAll(/\b(cp|install)\s+([^\n]*(?:\\\n[^\n]*)*)/g)) {
    if (inComment(match.index) === true) continue
    const body = match[2]!
    const operands = [...body.matchAll(/"(?:\\.|[^"])*"|'[^']*'|(?:\$\{[^}]*\}|[^\s])+/g)].filter(
      (operand) => operand[0].startsWith('-') === false,
    )
    // The last operand is the destination, not a repo source.
    for (const operand of operands.slice(0, -1)) {
      inspect(match[1]!, operand[0], match.index + match[0].indexOf(body) + operand.index)
    }
  }
  return references
}

const isInventoried = (nix: string, reference: StagingReference): boolean =>
  reference.source !== undefined
    ? inventory.sources.some(
        (entry) => entry.source === reference.source && entry.nix.includes(nix),
      ) ||
      inventory.exemptions.some(
        (entry) =>
          entry.source === reference.source && entry.nix === nix && entry.reason.trim().length > 0,
      )
    : inventory.unresolvedStagings.some(
        (entry) =>
          entry.nix === nix &&
          entry.operation === reference.operation &&
          entry.argument === reference.argument &&
          entry.reason.trim().length > 0,
      )

const assertIsolatableExtension = (source: string): void => {
  expect(
    Object.entries(inventory.extensions).some(
      ([extension, supported]) => path.extname(source) === extension && supported === true,
    ),
    `${source}: unsupported standalone source extension; Node 24 cannot import JSX/TSX without transformation. See extensions in nix/standalone-staging.json.`,
  ).toBe(true)
}

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
      for (const reference of scanStagingReferences(nix, content)) {
        found.add(`${nix}:${reference.source ?? `${reference.operation}:${reference.argument}`}`)
        if (isInventoried(nix, reference) === false) {
          missing.push(
            `${nix}:${content.slice(0, reference.index).split('\n').length} -> ${reference.source ?? `unresolved ${reference.operation} argument ${JSON.stringify(reference.argument)}`}`,
          )
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
    for (const entry of inventory.unresolvedStagings) {
      expect(
        found.has(`${entry.nix}:${entry.operation}:${entry.argument}`),
        `Stale staging exemption: ${entry.nix}:${entry.operation}:${entry.argument}`,
      ).toBe(true)
    }
  })

  it.each([
    ['relative readFile', 'builtins.readFile ./x.ts;', './x.ts'],
    ['CommonJS TypeScript readFile', 'builtins.readFile ./x.cts;', './x.cts'],
    ['concatenated readFile', 'builtins.readFile (base + "/x.ts");', '/x.ts'],
    ['interpolated readFile', 'builtins.readFile "${root}/x.mjs";', '${root}/x.mjs'],
    [
      'known-root interpolation',
      'builtins.readFile "${repoRoot}/scripts/x.mjs";',
      '${repoRoot}/scripts/x.mjs',
    ],
    ['workspace-relative cp', 'cp scripts/x.mjs "$out"', 'scripts/x.mjs'],
    ['interpolated cp', 'cp ${src}/x.ts "$out"', '${src}/x.ts'],
    ['interpolated install', 'install -m 755 ${src}/x.ts "$out"', '${src}/x.ts'],
    [
      'attrset after semicolon',
      'builtins.path { name = "fixture"; path = "${src}/x.ts"; };',
      '${src}/x.ts',
    ],
    ['copyPathToStore interpolation', 'builtins.copyPathToStore "${src}/x.ts";', '${src}/x.ts'],
    ['computed extension', 'builtins.readFile ("x" + ".ts");', '.ts'],
    [
      'nested writeText/readFile',
      'pkgs.writeText "runner" (builtins.readFile "${root}/x.mjs");',
      '${root}/x.mjs',
    ],
  ])('rejects an unlisted staging fixture: %s', (_name, content, argument) => {
    const references = scanStagingReferences('standalone-staging-fixture.nix', content)
    expect(
      references.filter(
        (reference) =>
          reference.argument.includes(argument) &&
          isInventoried('standalone-staging-fixture.nix', reference) === false,
      ).length,
    ).toBeGreaterThan(0)
  })

  for (const entry of inventory.sources) {
    it(`${entry.source} imports only Node builtins or explicitly staged edges`, async () => {
      assertIsolatableExtension(entry.source)
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
