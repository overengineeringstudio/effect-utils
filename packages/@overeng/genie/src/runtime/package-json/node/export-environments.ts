import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

import type { ExportEnvironmentContract, PackageJsonValidationRuntime } from '../mod.ts'
import type { ValidationIssue } from '../validation.ts'

type TsNode = { readonly parent?: TsNode; readonly [key: string]: unknown }
type TsIdentifier = TsNode & { readonly text: string }
type TsNamedNode = TsNode & { readonly name?: TsIdentifier }
type TsRequiredNamedNode = TsNode & { readonly name: TsIdentifier }
type TsBindingElement = TsNode & { readonly name: TsBindingName }
type TsBindingName = TsIdentifier | (TsNode & { readonly elements: readonly TsBindingElement[] })
type TsDiagnostic = { readonly messageText: unknown }
type TsModuleResolution = 'bundler' | 'node-next'
type TypeScriptRuntime = {
  readonly ModuleKind: { readonly NodeNext: number }
  readonly ModuleResolutionKind: {
    readonly Bundler: number
    readonly NodeNext: number
  }
  readonly ScriptTarget: { readonly Latest: number }
  readonly version: string
  readonly createProgram: (rootNames: readonly string[], options: object) => unknown
  readonly createSourceFile: (
    fileName: string,
    sourceText: string,
    languageVersion: number,
    setParentNodes: boolean,
  ) => TsNode
  readonly flattenDiagnosticMessageText: (diagnostic: unknown, newLine: string) => string
  readonly forEachChild: (node: TsNode, callback: (node: TsNode) => void) => void
  readonly getPreEmitDiagnostics: (program: unknown) => readonly TsDiagnostic[]
  readonly isBindingElement: (node: TsNode) => node is TsBindingElement
  readonly isBlock: (node: TsNode) => boolean
  readonly isCaseBlock: (node: TsNode) => boolean
  readonly isCatchClause: (
    node: TsNode,
  ) => node is TsNode & { readonly variableDeclaration?: { readonly name: TsBindingName } }
  readonly isClassDeclaration: (node: TsNode) => node is TsNamedNode
  readonly isExportSpecifier: (node: TsNode) => node is TsRequiredNamedNode
  readonly isFunctionDeclaration: (node: TsNode) => node is TsNamedNode
  readonly isFunctionLike: (
    node: TsNode,
  ) => node is TsNode & { readonly parameters: readonly { readonly name: TsBindingName }[] }
  readonly isIdentifier: (node: TsNode) => node is TsIdentifier
  readonly isImportClause: (node: TsNode) => node is TsNamedNode
  readonly isImportSpecifier: (node: TsNode) => node is TsRequiredNamedNode
  readonly isInterfaceDeclaration: (node: TsNode) => node is TsNamedNode
  readonly isMethodDeclaration: (node: TsNode) => node is TsNamedNode
  readonly isModuleBlock: (node: TsNode) => boolean
  readonly isNamespaceImport: (node: TsNode) => node is TsRequiredNamedNode
  readonly isParameter: (node: TsNode) => node is TsNode & { readonly name: TsBindingName }
  readonly isPropertyAccessExpression: (node: TsNode) => node is TsNamedNode
  readonly isPropertyAssignment: (node: TsNode) => node is TsNamedNode
  readonly isPropertyDeclaration: (node: TsNode) => node is TsNamedNode
  readonly isSourceFile: (node: TsNode) => boolean
  readonly isTypeAliasDeclaration: (node: TsNode) => node is TsNamedNode
  readonly isVariableDeclaration: (
    node: TsNode,
  ) => node is TsNode & { readonly name: TsBindingName }
  readonly preProcessFile: (
    sourceText: string,
    readImportFiles?: boolean,
    detectJavaScriptImports?: boolean,
  ) => { readonly importedFiles: readonly { readonly fileName: string }[] }
}

const loadModule = createRequire(import.meta.url)
let tsCache: TypeScriptRuntime | undefined
const getTypeScript = (): TypeScriptRuntime => {
  const typeScriptModule = process.env.GENIE_TYPESCRIPT_MODULE
  if (typeScriptModule === undefined) {
    throw new Error('GENIE_TYPESCRIPT_MODULE is required to validate package export environments.')
  }
  tsCache ??=
    // The compiled Genie binary sets this to its packaged TypeScript module path.
    // eslint-disable-next-line import/no-dynamic-require
    Reflect.apply(loadModule, undefined, [typeScriptModule]) as TypeScriptRuntime
  return tsCache
}

type ExportsEntry = string | Record<string, string>

type EnvironmentProfile = {
  conditions: readonly string[]
  forbiddenImports: readonly string[]
  forbiddenGlobals: readonly string[]
  typecheck?: {
    lib: readonly string[]
    types: readonly string[]
    customConditions?: readonly string[]
    moduleResolution?: TsModuleResolution
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
    forbiddenGlobals: ['Bun', 'process', 'window', 'document'],
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
      moduleResolution: 'bundler',
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
      moduleResolution: 'bundler',
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
  if (pattern === 'node:*' && isBuiltin(specifier) === true) return true
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
  if (existsSync(resolved) === true && statSync(resolved).isFile() === true) return resolved

  const parsed = path.parse(resolved)
  const sourceExtensionsForRuntimeExtension: Record<string, readonly string[]> = {
    '.js': ['.ts', '.tsx'],
    '.jsx': ['.tsx', '.ts'],
    '.mjs': ['.mts', '.ts'],
    '.cjs': ['.cts', '.ts'],
  }
  const sourceExtensions = sourceExtensionsForRuntimeExtension[parsed.ext]
  if (sourceExtensions !== undefined) {
    const sourceBase = path.join(parsed.dir, parsed.name)
    for (const extension of sourceExtensions) {
      const candidate = `${sourceBase}${extension}`
      if (existsSync(candidate) === true) return candidate
    }
  }

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

  const ts = getTypeScript()
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const issues: ValidationIssue[] = []
  const forbiddenGlobals = new Set(profile.forbiddenGlobals)

  const addBindingNames = ({
    target,
    name,
  }: {
    target: Set<string>
    name: TsBindingName
  }): void => {
    if (ts.isIdentifier(name) === true) {
      target.add(name.text)
      return
    }
    for (const element of name.elements) {
      if (ts.isBindingElement(element) === true) addBindingNames({ target, name: element.name })
    }
  }

  const isScopeBoundary = (node: TsNode): boolean =>
    ts.isSourceFile(node) === true ||
    ts.isBlock(node) === true ||
    ts.isModuleBlock(node) === true ||
    ts.isCaseBlock(node) === true ||
    ts.isCatchClause(node) === true ||
    ts.isFunctionLike(node) === true

  const collectScopeDeclarations = (node: TsNode): Set<string> => {
    const declarations = new Set<string>()
    if (ts.isFunctionLike(node) === true) {
      for (const parameter of node.parameters) {
        addBindingNames({ target: declarations, name: parameter.name })
      }
    }
    if (ts.isCatchClause(node) === true && node.variableDeclaration !== undefined) {
      addBindingNames({ target: declarations, name: node.variableDeclaration.name })
    }

    const visitDeclaration = (child: TsNode): void => {
      if (child !== node && isScopeBoundary(child) === true) return
      if (ts.isImportSpecifier(child) === true) declarations.add(child.name.text)
      if (ts.isImportClause(child) === true && child.name !== undefined)
        declarations.add(child.name.text)
      if (ts.isNamespaceImport(child) === true) declarations.add(child.name.text)
      if (ts.isVariableDeclaration(child) === true)
        addBindingNames({ target: declarations, name: child.name })
      if (
        (ts.isFunctionDeclaration(child) === true ||
          ts.isClassDeclaration(child) === true ||
          ts.isInterfaceDeclaration(child) === true ||
          ts.isTypeAliasDeclaration(child) === true) &&
        child.name !== undefined
      ) {
        declarations.add(child.name.text)
      }
      ts.forEachChild(child, visitDeclaration)
    }

    ts.forEachChild(node, visitDeclaration)
    return declarations
  }

  const isDeclarationName = (node: TsIdentifier): boolean => {
    const parent = node.parent
    return (
      parent !== undefined &&
      ((ts.isBindingElement(parent) === true && parent.name === node) ||
        (ts.isImportSpecifier(parent) === true && parent.name === node) ||
        (ts.isImportClause(parent) === true && parent.name === node) ||
        (ts.isNamespaceImport(parent) === true && parent.name === node) ||
        (ts.isVariableDeclaration(parent) === true && parent.name === node) ||
        (ts.isFunctionDeclaration(parent) === true && parent.name === node) ||
        (ts.isParameter(parent) === true && parent.name === node) ||
        (ts.isClassDeclaration(parent) === true && parent.name === node) ||
        (ts.isInterfaceDeclaration(parent) === true && parent.name === node) ||
        (ts.isTypeAliasDeclaration(parent) === true && parent.name === node))
    )
  }

  const isPropertyName = (node: TsIdentifier): boolean => {
    const parent = node.parent
    return (
      parent !== undefined &&
      ((ts.isPropertyAccessExpression(parent) === true && parent.name === node) ||
        (ts.isPropertyAssignment(parent) === true && parent.name === node) ||
        (ts.isPropertyDeclaration(parent) === true && parent.name === node) ||
        (ts.isMethodDeclaration(parent) === true && parent.name === node) ||
        (ts.isExportSpecifier(parent) === true && parent.name === node))
    )
  }

  const visit = ({ node, scopes }: { node: TsNode; scopes: readonly Set<string>[] }): void => {
    const nextScopes =
      isScopeBoundary(node) === true ? [...scopes, collectScopeDeclarations(node)] : scopes

    if (
      ts.isIdentifier(node) === true &&
      forbiddenGlobals.has(node.text) === true &&
      isDeclarationName(node) === false &&
      isPropertyName(node) === false &&
      nextScopes.some((scope) => scope.has(node.text)) === false
    ) {
      issues.push(
        issue({
          packageName,
          dependency: exportPath,
          message: `${path.relative(process.cwd(), file)} references forbidden global "${node.text}" for this export environment.`,
          rule: 'package-json-export-environment-global',
        }),
      )
    }
    ts.forEachChild(node, (child) => visit({ node: child, scopes: nextScopes }))
  }

  visit({ node: sourceFile, scopes: [] })
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
  const ts = getTypeScript()
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
  const supportedConditions = new Set(profile.conditions)
  for (const [condition, target] of Object.entries(entry)) {
    if (supportedConditions.has(condition) === false) continue
    if (typeof target === 'string') return target
  }
  return undefined
}

const escapeRegExp = (input: string): string => input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const walkFiles = (root: string): readonly string[] => {
  if (existsSync(root) === false) return []
  const pending = [root]
  const files: string[] = []
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) continue
    const stat = statSync(current)
    if (stat.isDirectory() === true) {
      for (const child of readdirSync(current)) {
        pending.push(path.join(current, child))
      }
    } else if (stat.isFile() === true) {
      files.push(current)
    }
  }
  return files.toSorted()
}

const resolveTargetEntries = ({
  cwd,
  location,
  target,
}: {
  cwd: string
  location: string
  target: string
}): readonly string[] => {
  const absoluteTarget = path.resolve(cwd, location, target)
  if (target.includes('*') === false)
    return existsSync(absoluteTarget) === true ? [absoluteTarget] : []

  const wildcardIndex = absoluteTarget.indexOf('*')
  const basePrefix = absoluteTarget.slice(0, wildcardIndex)
  const baseDir = basePrefix.endsWith(path.sep) === true ? basePrefix : path.dirname(basePrefix)
  const targetPattern = new RegExp(`^${escapeRegExp(absoluteTarget).replaceAll('\\*', '.*')}$`)

  return walkFiles(baseDir).filter((file) => targetPattern.test(file))
}

const cacheRoot = (cwd: string): string =>
  path.join(cwd, '.devenv/task-cache/genie-package-json-export-environments')

const sha256 = (content: string): string => createHash('sha256').update(content).digest('hex')

const proofCacheKey = ({
  files,
  cacheInputs,
  contract,
  profile,
}: {
  files: readonly string[]
  cacheInputs: readonly string[]
  contract: ExportEnvironmentContract
  profile: EnvironmentProfile
}): string => {
  const ts = getTypeScript()
  const hash = createHash('sha256')
  hash.update(validatorVersion)
  hash.update('\n')
  hash.update(ts.version)
  hash.update('\n')
  hash.update(JSON.stringify(contract))
  hash.update('\n')
  hash.update(JSON.stringify(profile))
  for (const file of cacheInputs) {
    hash.update('\n')
    hash.update(file)
    hash.update('\n')
    hash.update(existsSync(file) === true ? sha256(readFileSync(file, 'utf8')) : '(missing)')
  }
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
  cacheInputs,
  contract,
  profile,
  packageName,
  exportPath,
}: {
  cwd: string
  entry: string
  files: readonly string[]
  cacheInputs: readonly string[]
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

  const key = proofCacheKey({ files, cacheInputs, contract, profile })
  if (hasCachedProof({ cwd, key }) === true) return { issues: [], cache: { hits: 1, misses: 0 } }

  const ts = getTypeScript()
  const program = ts.createProgram([entry], {
    lib: [...profile.typecheck.lib],
    types: [...profile.typecheck.types],
    strict: true,
    noEmit: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution:
      profile.typecheck.moduleResolution === 'bundler'
        ? ts.ModuleResolutionKind.Bundler
        : ts.ModuleResolutionKind.NodeNext,
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

    for (const [exportPath, contracts] of Object.entries(args.contracts)) {
      for (const contract of contracts) {
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

        const entries = resolveTargetEntries({
          cwd: args.cwd,
          location: args.location,
          target,
        })
        if (entries.length === 0) {
          issues.push(
            issue({
              packageName: args.packageName,
              dependency: exportPath,
              message: `Export "${exportPath}" target does not exist: ${path.relative(args.cwd, path.resolve(args.cwd, args.location, target))}`,
              rule: 'package-json-export-environment-target-exists',
            }),
          )
          continue
        }

        for (const entry of entries) {
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
            cacheInputs: [
              path.join(args.cwd, 'pnpm-lock.yaml'),
              path.join(args.cwd, 'package.json'),
              path.join(args.cwd, args.location, 'package.json'),
              path.join(args.cwd, args.location, 'tsconfig.json'),
            ],
            contract,
            profile,
            packageName: args.packageName,
            exportPath,
          })
          hits += typecheckResult.cache.hits
          misses += typecheckResult.cache.misses
          issues.push(...typecheckResult.issues)
        }
      }
    }

    return {
      issues,
      durationMs: performance.now() - start,
      cache: { hits, misses },
    }
  },
}
