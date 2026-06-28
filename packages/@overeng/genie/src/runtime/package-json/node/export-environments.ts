import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

import ts from 'typescript'

import type { ExportEnvironmentContract, PackageJsonValidationRuntime } from '../mod.ts'
import type { ValidationIssue } from '../validation.ts'

type ExportsEntry = string | Record<string, string>

type EnvironmentProfile = {
  conditions: readonly string[]
  forbiddenImports: readonly string[]
  forbiddenGlobals: readonly string[]
  typecheck?: {
    lib: readonly string[]
    types: readonly string[]
    customConditions?: readonly string[]
    moduleResolution?: ts.ModuleResolutionKind
  }
}

type GraphResult = {
  files: readonly string[]
  issues: readonly ValidationIssue[]
}

const validatorVersion = 'package-json-export-environments-v1'

const builtinEnvironmentProfiles: Record<string, EnvironmentProfile> = {
  'isomorphic-es2024': {
    conditions: ['import', 'default'],
    forbiddenImports: ['node:*', 'bun', 'bun:*'],
    forbiddenGlobals: ['Bun', 'window', 'document'],
    typecheck: { lib: ['lib.es2024.d.ts'], types: [] },
  },
  node: {
    conditions: ['node', 'import', 'default'],
    forbiddenImports: [],
    forbiddenGlobals: [],
    typecheck: { lib: ['lib.es2024.d.ts'], types: ['node'] },
  },
  bun: {
    conditions: ['bun', 'import', 'default'],
    forbiddenImports: [],
    forbiddenGlobals: [],
    typecheck: { lib: ['lib.es2024.d.ts'], types: ['bun'] },
  },
  browser: {
    conditions: ['browser', 'import', 'default'],
    forbiddenImports: ['node:*', 'bun', 'bun:*'],
    forbiddenGlobals: ['Bun', 'process'],
    typecheck: { lib: ['lib.es2024.d.ts', 'lib.dom.d.ts'], types: [] },
  },
  webworker: {
    conditions: ['worker', 'browser', 'import', 'default'],
    forbiddenImports: ['node:*', 'bun', 'bun:*'],
    forbiddenGlobals: ['Bun', 'process', 'window', 'document'],
    typecheck: { lib: ['lib.es2024.d.ts', 'lib.webworker.d.ts'], types: [] },
  },
  workerd: {
    conditions: ['workerd', 'worker', 'browser', 'import', 'default'],
    forbiddenImports: ['node:*', 'bun', 'bun:*'],
    forbiddenGlobals: ['Bun', 'process', 'window', 'document'],
    typecheck: {
      lib: ['lib.es2024.d.ts', 'lib.webworker.d.ts'],
      types: ['@cloudflare/workers-types'],
      customConditions: ['workerd'],
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    },
  },
  'react-native': {
    conditions: ['react-native', 'import', 'default'],
    forbiddenImports: ['node:*', 'bun', 'bun:*'],
    forbiddenGlobals: ['Bun', 'window', 'document'],
    typecheck: {
      lib: ['lib.es2024.d.ts'],
      types: ['react-native'],
      customConditions: ['react-native'],
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    },
  },
}

const issue = ({
  packageName,
  dependency,
  message,
  rule,
}: {
  packageName: string
  dependency: string
  message: string
  rule: string
}): ValidationIssue => ({
  severity: 'error',
  packageName,
  dependency,
  message,
  rule,
})

const matchesForbiddenImport = ({
  specifier,
  pattern,
}: {
  specifier: string
  pattern: string
}): boolean => {
  if (pattern.endsWith('*') === true) return specifier.startsWith(pattern.slice(0, -1))
  return specifier === pattern
}

const resolveRelativeImport = ({
  fromFile,
  specifier,
}: {
  fromFile: string
  specifier: string
}): string | undefined => {
  if (specifier.startsWith('.') === false) return undefined
  const resolved = path.resolve(path.dirname(fromFile), specifier)
  if (existsSync(resolved) === true) return resolved
  for (const suffix of ['.ts', '.tsx', '.mts', '.cts', '/mod.ts', '/index.ts']) {
    const candidate = `${resolved}${suffix}`
    if (existsSync(candidate) === true) return candidate
  }
  return undefined
}

const findForbiddenGlobals = ({
  file,
  source,
  profile,
  packageName,
  exportPath,
}: {
  file: string
  source: string
  profile: EnvironmentProfile
  packageName: string
  exportPath: string
}): ValidationIssue[] => {
  if (profile.forbiddenGlobals.length === 0) return []

  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const issues: ValidationIssue[] = []
  const forbiddenGlobals = new Set(profile.forbiddenGlobals)

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) === true && forbiddenGlobals.has(node.text) === true) {
      issues.push(
        issue({
          packageName,
          dependency: exportPath,
          message: `${path.relative(process.cwd(), file)} references forbidden global "${node.text}" for this export environment.`,
          rule: 'package-json-export-environment-global',
        }),
      )
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return issues
}

const scanGraph = ({
  entry,
  profile,
  packageName,
  exportPath,
}: {
  entry: string
  profile: EnvironmentProfile
  packageName: string
  exportPath: string
}): GraphResult => {
  const seen = new Set<string>()
  const pending = [entry]
  const issues: ValidationIssue[] = []

  while (pending.length > 0) {
    const file = pending.pop()
    if (file === undefined || seen.has(file) === true) continue
    seen.add(file)

    const source = readFileSync(file, 'utf8')
    const preprocessed = ts.preProcessFile(source, true, true)

    for (const imported of preprocessed.importedFiles) {
      const specifier = imported.fileName
      const forbiddenPattern = profile.forbiddenImports.find((pattern) =>
        matchesForbiddenImport({ specifier, pattern }),
      )
      if (forbiddenPattern !== undefined) {
        issues.push(
          issue({
            packageName,
            dependency: exportPath,
            message: `${path.relative(process.cwd(), file)} imports "${specifier}", which is forbidden by this export environment.`,
            rule: 'package-json-export-environment-import',
          }),
        )
        continue
      }

      const resolved = resolveRelativeImport({ fromFile: file, specifier })
      if (resolved !== undefined) pending.push(resolved)
    }

    issues.push(...findForbiddenGlobals({ file, source, profile, packageName, exportPath }))
  }

  return { files: [...seen].toSorted(), issues }
}

const resolveExportTarget = ({
  entry,
  profile,
}: {
  entry: ExportsEntry
  profile: EnvironmentProfile
}): string | undefined => {
  if (typeof entry === 'string') return entry
  for (const condition of profile.conditions) {
    const target = entry[condition]
    if (typeof target === 'string') return target
  }
  return undefined
}

const cacheRoot = (cwd: string): string =>
  path.join(cwd, '.devenv/task-cache/genie-package-json-export-environments')

const sha256 = (content: string): string => createHash('sha256').update(content).digest('hex')

const proofCacheKey = ({
  files,
  contract,
  profile,
}: {
  files: readonly string[]
  contract: ExportEnvironmentContract
  profile: EnvironmentProfile
}): string => {
  const hash = createHash('sha256')
  hash.update(validatorVersion)
  hash.update('\n')
  hash.update(ts.version)
  hash.update('\n')
  hash.update(JSON.stringify(contract))
  hash.update('\n')
  hash.update(JSON.stringify(profile))
  for (const file of files) {
    hash.update('\n')
    hash.update(file)
    hash.update('\n')
    hash.update(sha256(readFileSync(file, 'utf8')))
  }
  return hash.digest('hex')
}

const hasCachedProof = ({ cwd, key }: { cwd: string; key: string }): boolean =>
  existsSync(path.join(cacheRoot(cwd), `${key}.ok`))

const writeCachedProof = ({ cwd, key }: { cwd: string; key: string }): void => {
  const root = cacheRoot(cwd)
  mkdirSync(root, { recursive: true })
  writeFileSync(path.join(root, `${key}.ok`), 'ok\n')
}

const typecheck = ({
  cwd,
  entry,
  files,
  contract,
  profile,
  packageName,
  exportPath,
}: {
  cwd: string
  entry: string
  files: readonly string[]
  contract: ExportEnvironmentContract
  profile: EnvironmentProfile
  packageName: string
  exportPath: string
}): { issues: ValidationIssue[]; cache: { hits: number; misses: number } } => {
  if (contract.typeProof !== 'strict') return { issues: [], cache: { hits: 0, misses: 0 } }
  if (profile.typecheck === undefined) {
    return {
      cache: { hits: 0, misses: 0 },
      issues: [
        issue({
          packageName,
          dependency: exportPath,
          message: `Environment "${contract.environment}" does not define a TypeScript proof profile.`,
          rule: 'package-json-export-environment-type-profile',
        }),
      ],
    }
  }

  const key = proofCacheKey({ files, contract, profile })
  if (hasCachedProof({ cwd, key }) === true) return { issues: [], cache: { hits: 1, misses: 0 } }

  const program = ts.createProgram([entry], {
    lib: [...profile.typecheck.lib],
    types: [...profile.typecheck.types],
    strict: true,
    noEmit: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: profile.typecheck.moduleResolution ?? ts.ModuleResolutionKind.NodeNext,
    allowImportingTsExtensions: true,
    skipLibCheck: true,
    ...(profile.typecheck.customConditions === undefined
      ? {}
      : { customConditions: [...profile.typecheck.customConditions] }),
  })

  const diagnostics = ts.getPreEmitDiagnostics(program)
  if (diagnostics.length === 0) {
    writeCachedProof({ cwd, key })
    return { issues: [], cache: { hits: 0, misses: 1 } }
  }

  return {
    cache: { hits: 0, misses: 1 },
    issues: diagnostics.slice(0, 20).map((diagnostic) =>
      issue({
        packageName,
        dependency: exportPath,
        message: `TypeScript environment proof failed for "${contract.environment}": ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
        rule: 'package-json-export-environment-type-proof',
      }),
    ),
  }
}

/** Package-json-owned node validation runtime injected during Genie validation. */
export const nodePackageJsonValidationRuntime: PackageJsonValidationRuntime = {
  validateExportEnvironments: (args) => {
    const start = performance.now()
    const issues: ValidationIssue[] = []
    let hits = 0
    let misses = 0

    for (const [exportPath, contract] of Object.entries(args.contracts)) {
      const profile = builtinEnvironmentProfiles[contract.environment]
      if (profile === undefined) {
        issues.push(
          issue({
            packageName: args.packageName,
            dependency: exportPath,
            message: `Unknown export environment "${contract.environment}".`,
            rule: 'package-json-export-environment-unknown',
          }),
        )
        continue
      }

      const exportEntry = args.exports[exportPath]
      if (exportEntry === undefined) continue

      const target = resolveExportTarget({ entry: exportEntry, profile })
      if (target === undefined) {
        issues.push(
          issue({
            packageName: args.packageName,
            dependency: exportPath,
            message: `Export "${exportPath}" has no target for environment "${contract.environment}" using conditions ${profile.conditions.join(', ')}.`,
            rule: 'package-json-export-environment-target',
          }),
        )
        continue
      }

      const entry = path.resolve(args.cwd, args.location, target)
      if (existsSync(entry) === false) {
        issues.push(
          issue({
            packageName: args.packageName,
            dependency: exportPath,
            message: `Export "${exportPath}" target does not exist: ${path.relative(args.cwd, entry)}`,
            rule: 'package-json-export-environment-target-exists',
          }),
        )
        continue
      }

      const graph = scanGraph({
        entry,
        profile,
        packageName: args.packageName,
        exportPath,
      })
      issues.push(...graph.issues)

      const typecheckResult = typecheck({
        cwd: args.cwd,
        entry,
        files: graph.files,
        contract,
        profile,
        packageName: args.packageName,
        exportPath,
      })
      hits += typecheckResult.cache.hits
      misses += typecheckResult.cache.misses
      issues.push(...typecheckResult.issues)
    }

    return {
      issues,
      durationMs: performance.now() - start,
      cache: { hits, misses },
    }
  },
}
