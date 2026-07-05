/**
 * Node-only bootstrap-safe import-closure check for genie generator sources.
 *
 * A `.genie.ts` file (and every helper it transitively imports at RUNTIME) must be importable from a
 * fresh checkout BEFORE package-manager install state exists. A generator that transitively reaches a
 * runtime-only package — e.g. through a wide barrel that `export *`s a module importing `effect` — pulls
 * that package into the generator's bootstrap import closure and breaks `genie:run` on a fresh clone.
 *
 * This walker reuses TypeScript's own parser (`ts.createSourceFile`) and resolver (`ts.resolveModuleName`)
 * — the bug-prone parts — and injects genie's OWN `#`/`#mr` resolution ({@link resolveImportMapSpecifierForImporterSync})
 * so lock-pinned megarepo-member imports resolve exactly as genie resolves them at bootstrap. It owns only
 * the transitive walk and the bootstrap policy. It never descends into `node_modules`: a bare (non-relative,
 * non-`#`, non-`node:`-builtin) specifier is a closure boundary — the reported violation — not an edge to
 * follow, so the check has no dependency on install state and never parses a `.d.ts` closure.
 *
 * Type-only edges (`import type`, `export type`, and per-specifier `{ type X }`) are erased at runtime and
 * are excluded from the closure.
 */

import { readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import path from 'node:path'

import ts from 'typescript'

import { resolveImportMapSpecifierForImporterSync } from '../../core/import-map/mod.ts'

/** A transitive edge from a `.genie.ts` source to a runtime-only package, with the importer chain. */
export type BootstrapClosureViolation = {
  /** The offending `.genie.ts` source (absolute path). */
  source: string
  /** The runtime-only specifier reached (e.g. `effect`, `@effect/platform`, `typescript`). */
  specifier: string
  /** The importer chain `[source, ...intermediates, terminalFile]` — absolute paths, ending at the file that imports `specifier`. */
  chain: readonly string[]
}

/** The result of {@link checkBootstrapClosure}: the violations found plus every source that was walked. */
export type BootstrapClosureResult = {
  /** One violation per `.genie.ts` source that transitively reaches a runtime-only package (shortest chain). */
  violations: readonly BootstrapClosureViolation[]
  /** Every `.genie.ts` source that was walked. */
  checkedSources: readonly string[]
}

const RESOLUTION_OPTIONS: ts.CompilerOptions = {
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
  resolveJsonModule: true,
}

const isRelativeSpecifier = (specifier: string): boolean =>
  specifier.startsWith('./') === true || specifier.startsWith('../') === true

const isImportMapSpecifier = (specifier: string): boolean => specifier.startsWith('#') === true

/** A node builtin is always importable pre-install, so it is bootstrap-safe with or without the `node:` prefix. */
const isNodeBuiltin = (specifier: string): boolean =>
  specifier.startsWith('node:') === true || isBuiltin(specifier) === true

/**
 * A specifier is a bootstrap violation iff it is a bare package name — i.e. not relative, not a `#`/`#mr`
 * import-map specifier (which genie resolves to on-disk source), and not a node builtin. First-party source
 * reached via relative / `#` / `#mr` paths is allowed; anything landing on a bare package name is forbidden.
 */
const isViolationSpecifier = (specifier: string): boolean =>
  isRelativeSpecifier(specifier) === false &&
  isImportMapSpecifier(specifier) === false &&
  isNodeBuiltin(specifier) === false

/** True when every named binding carries an inline `type` keyword (`import { type A, type B }`), making the whole edge type-only. */
const allNamedBindingsAreTypeOnly = (
  bindings: ts.NamedImportBindings | ts.NamedExportBindings | undefined,
): boolean => {
  if (bindings === undefined) return false
  if (ts.isNamedImports(bindings) === true) {
    const elements = (bindings as ts.NamedImports).elements
    return elements.length > 0 && elements.every((element) => element.isTypeOnly === true)
  }
  if (ts.isNamedExports(bindings) === true) {
    const elements = (bindings as ts.NamedExports).elements
    return elements.length > 0 && elements.every((element) => element.isTypeOnly === true)
  }
  return false
}

/** Extract the RUNTIME (value, non-type-only) module specifiers a source file imports/re-exports/dynamically-imports. */
const runtimeSpecifiersOf = ({
  fileName,
  sourceText,
}: {
  fileName: string
  sourceText: string
}): readonly string[] => {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ESNext, true)
  const specifiers: string[] = []

  const visit = (node: ts.Node): void => {
    // import ... from 'x'
    if (
      ts.isImportDeclaration(node) === true &&
      ts.isStringLiteral(node.moduleSpecifier) === true
    ) {
      const clause = node.importClause
      // `import type ...` (phaseModifier === TypeKeyword) is fully type-only; `import defer ...`
      // (DeferKeyword) is a runtime edge. `ImportClause.isTypeOnly` is deprecated in favor of `phaseModifier`.
      // A value default binding (`import helper, { type X }`) or a namespace import (`import * as x`) is a
      // runtime edge even when every named binding is inline-`type`, so those must NOT be skipped.
      const hasValueDefault = clause?.name !== undefined
      const isNamespaceImport =
        clause?.namedBindings !== undefined && ts.isNamespaceImport(clause.namedBindings) === true
      const typeOnly =
        clause?.phaseModifier === ts.SyntaxKind.TypeKeyword ||
        (hasValueDefault === false &&
          isNamespaceImport === false &&
          allNamedBindingsAreTypeOnly(clause?.namedBindings) === true)
      if (typeOnly === false) specifiers.push((node.moduleSpecifier as ts.StringLiteral).text)
    }

    // export ... from 'x'  (covers `export * from` and `export { ... } from`)
    if (
      ts.isExportDeclaration(node) === true &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) === true
    ) {
      const typeOnly = node.isTypeOnly === true || allNamedBindingsAreTypeOnly(node.exportClause)
      if (typeOnly === false) specifiers.push((node.moduleSpecifier as ts.StringLiteral).text)
    }

    // dynamic import('x') with a string-literal argument
    if (
      ts.isCallExpression(node) === true &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0]!) === true
    ) {
      specifiers.push((node.arguments[0] as ts.StringLiteral).text)
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return specifiers
}

/**
 * Resolve a bootstrap-safe specifier (relative or `#`/`#mr`) to an absolute file path, using genie's own
 * resolver for `#`/`#mr` and TypeScript's resolver for relative paths. Bare specifiers are never resolved
 * (they are violations, not edges to follow) so this never touches `node_modules`.
 */
const resolveFollowableSpecifier = ({
  specifier,
  importerFile,
  moduleResolutionHost,
  moduleResolutionCache,
}: {
  specifier: string
  importerFile: string
  moduleResolutionHost: ts.ModuleResolutionHost
  moduleResolutionCache: ts.ModuleResolutionCache
}): string | undefined => {
  if (isImportMapSpecifier(specifier) === true) {
    return resolveImportMapSpecifierForImporterSync({ specifier, importerPath: importerFile })
  }
  const resolved = ts.resolveModuleName(
    specifier,
    importerFile,
    RESOLUTION_OPTIONS,
    moduleResolutionHost,
    moduleResolutionCache,
  )
  return resolved.resolvedModule?.resolvedFileName
}

/**
 * Walk the transitive runtime import closure of each `.genie.ts` source and report those that reach a
 * runtime-only package, with the shortest importer chain to the offending edge.
 */
export const checkBootstrapClosure = ({
  genieFiles,
}: {
  /** Absolute paths of the `.genie.ts` sources to check. */
  genieFiles: readonly string[]
}): BootstrapClosureResult => {
  const moduleResolutionHost: ts.ModuleResolutionHost = ts.sys
  const moduleResolutionCache = ts.createModuleResolutionCache(
    ts.sys.getCurrentDirectory(),
    (fileName) => fileName,
    RESOLUTION_OPTIONS,
  )

  /** Per-file analysis, memoized globally — the runtime import graph is identical across all roots. */
  type FileEdges = {
    /** Bare runtime-only specifiers directly imported by this file (closure boundaries). */
    readonly violationSpecifiers: readonly string[]
    /** Absolute paths of first-party files this file imports at runtime (edges to follow). */
    readonly followTargets: readonly string[]
  }
  const edgesCache = new Map<string, FileEdges>()
  const edgesOf = (file: string): FileEdges => {
    const cached = edgesCache.get(file)
    if (cached !== undefined) return cached
    const violationSpecifiers: string[] = []
    const followTargets: string[] = []
    if (moduleResolutionHost.fileExists(file) === true) {
      for (const specifier of runtimeSpecifiersOf({
        fileName: file,
        sourceText: readFileSync(file, 'utf8'),
      })) {
        if (isViolationSpecifier(specifier) === true) {
          violationSpecifiers.push(specifier)
        } else if (
          isRelativeSpecifier(specifier) === true ||
          isImportMapSpecifier(specifier) === true
        ) {
          const resolved = resolveFollowableSpecifier({
            specifier,
            importerFile: file,
            moduleResolutionHost,
            moduleResolutionCache,
          })
          if (resolved !== undefined) followTargets.push(resolved)
        }
      }
    }
    const edges: FileEdges = { violationSpecifiers, followTargets }
    edgesCache.set(file, edges)
    return edges
  }

  /** BFS from a root; returns the shortest chain to the first runtime-only specifier, or undefined. */
  const findViolation = (root: string): BootstrapClosureViolation | undefined => {
    const seen = new Set<string>()
    const queue: (readonly string[])[] = [[root]]
    while (queue.length > 0) {
      const chain = queue.shift()!
      const current = chain[chain.length - 1]!
      if (seen.has(current) === true) continue
      seen.add(current)

      const { violationSpecifiers, followTargets } = edgesOf(current)
      if (violationSpecifiers.length > 0) {
        return { source: root, specifier: violationSpecifiers[0]!, chain }
      }
      for (const target of followTargets) {
        if (seen.has(target) === false) queue.push([...chain, target])
      }
    }
    return undefined
  }

  const violations: BootstrapClosureViolation[] = []
  for (const root of [...genieFiles].toSorted()) {
    const violation = findViolation(root)
    if (violation !== undefined) violations.push(violation)
  }

  return { violations, checkedSources: [...genieFiles].toSorted() }
}

/** Format a violation's importer chain as a repo-relative `source -> barrel -> runtime -> pkg` diagnostic. */
export const formatViolationChain = ({
  violation,
  repoRoot,
}: {
  violation: BootstrapClosureViolation
  repoRoot: string
}): string => {
  const rel = (absolutePath: string): string => path.relative(repoRoot, absolutePath)
  const links = [...violation.chain.map(rel), violation.specifier]
  return links.join('\n    -> ')
}
