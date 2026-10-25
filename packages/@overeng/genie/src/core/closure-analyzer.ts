import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { homedir } from 'node:os'
import path from 'node:path'

import { version as compilerVersion } from 'typescript'
import * as ts from 'typescript/unstable/ast'
import type {
  BindingName,
  Node,
  SourceFile,
  StringLiteral,
  NoSubstitutionTemplateLiteral,
} from 'typescript/unstable/ast'

import { runTsFileAnalysis } from '../runtime/node/ts-api.ts'
import type { TsFileAnalysisSession } from '../runtime/node/ts-api.ts'
import reviewedDependencies from './closure-dependency-allowlist.json' with { type: 'json' }

/** Runtime import edges and fail-closed capability findings for one module. */
export type ClosureModuleAnalysis = {
  readonly imports: readonly { readonly path: string; readonly line: number | null }[]
  readonly reasons: readonly {
    readonly operation: string
    readonly detail: string
    readonly line: number | null
  }[]
}

/** Exact package identity and loaded source bytes required for review approval. */
export type DependencyIdentity = {
  readonly name: string
  readonly version: string
  readonly integrity: string
  /** Package-relative POSIX paths and SHA256 hex digests of the source bytes actually loaded. */
  readonly files: readonly { readonly path: string; readonly digest: string }[]
}
/** A reviewed dependency identity with its human-readable approval rationale. */
export type DependencyAllowlistEntry = DependencyIdentity & { readonly reason: string }

/** Code review approval never accounts for data read by the dependency. */
export const matchDependencyAllowlist = ({
  identity,
  entries = reviewedDependencies,
}: {
  identity: DependencyIdentity
  entries?: readonly DependencyAllowlistEntry[]
}): DependencyAllowlistEntry | undefined =>
  entries.find(
    (entry) =>
      entry.name === identity.name &&
      entry.version === identity.version &&
      entry.integrity === identity.integrity &&
      entry.reason.trim().length > 0 &&
      identity.files.length > 0 &&
      identity.files.every(
        (file) =>
          file.path.length > 0 &&
          !file.path.includes('\\') &&
          file.path.split('/').every((part) => part !== '' && part !== '.' && part !== '..') &&
          /^[a-f0-9]{64}$/.test(file.digest) &&
          entry.files.some(
            (approved) => approved.path === file.path && approved.digest === file.digest,
          ),
      ),
  )

/** Bump whenever classification or parsing changes. Cache entries contain no caller filenames. */
export const closureAnalyzerVersion = '1'

const memoryCache = new Map<string, ClosureModuleAnalysis>()
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, '')))
const safeBuiltins: Readonly<Record<string, true>> = {
  querystring: true,
  string_decoder: true,
  'util/types': true,
}
const pureGlobals: Readonly<Record<string, true>> = Object.fromEntries(
  [
    'undefined',
    'NaN',
    'Infinity',
    'Object',
    'Array',
    'String',
    'Number',
    'Boolean',
    'BigInt',
    'Symbol',
    'Map',
    'Set',
    'WeakMap',
    'WeakSet',
    'Promise',
    'RegExp',
    'Error',
    'TypeError',
    'RangeError',
    'SyntaxError',
    'ReferenceError',
    'URIError',
    'EvalError',
    'AggregateError',
    'JSON',
    'Math',
    'ArrayBuffer',
    'SharedArrayBuffer',
    'DataView',
    'Uint8Array',
    'Uint8ClampedArray',
    'Int8Array',
    'Uint16Array',
    'Int16Array',
    'Uint32Array',
    'Int32Array',
    'Float32Array',
    'Float64Array',
    'BigInt64Array',
    'BigUint64Array',
    'TextEncoder',
    'TextDecoder',
    'URL',
    'URLSearchParams',
    'parseInt',
    'parseFloat',
    'isNaN',
    'isFinite',
    'encodeURI',
    'encodeURIComponent',
    'decodeURI',
    'decodeURIComponent',
  ].map((name) => [name, true as const]),
)

// Explicit syntax inventory: new compiler syntax remains unproven until reviewed here.
const supportedSyntax: Readonly<Record<string, true>> = Object.fromEntries(
  [
    'SourceFile',
    'EndOfFileToken',
    'Identifier',
    'PrivateIdentifier',
    'QualifiedName',
    'FirstNode',
    'FirstStatement',
    'VariableStatement',
    'VariableDeclarationList',
    'VariableDeclaration',
    'BindingElement',
    'ObjectBindingPattern',
    'ArrayBindingPattern',
    'FunctionDeclaration',
    'FunctionExpression',
    'ArrowFunction',
    'Parameter',
    'Block',
    'ReturnStatement',
    'ThrowStatement',
    'TryStatement',
    'CatchClause',
    'IfStatement',
    'WhileStatement',
    'DoStatement',
    'ForStatement',
    'ForInStatement',
    'ForOfStatement',
    'BreakStatement',
    'ContinueStatement',
    'SwitchStatement',
    'CaseBlock',
    'CaseClause',
    'DefaultClause',
    'ExpressionStatement',
    'EmptyStatement',
    'LabeledStatement',
    'ClassDeclaration',
    'ClassExpression',
    'Constructor',
    'MethodDeclaration',
    'PropertyDeclaration',
    'GetAccessor',
    'SetAccessor',
    'ClassStaticBlockDeclaration',
    'HeritageClause',
    'ExpressionWithTypeArguments',
    'CallExpression',
    'NewExpression',
    'PropertyAccessExpression',
    'ElementAccessExpression',
    'BinaryExpression',
    'PrefixUnaryExpression',
    'PostfixUnaryExpression',
    'ConditionalExpression',
    'ParenthesizedExpression',
    'ArrayLiteralExpression',
    'ObjectLiteralExpression',
    'PropertyAssignment',
    'ShorthandPropertyAssignment',
    'SpreadAssignment',
    'SpreadElement',
    'ComputedPropertyName',
    'TemplateExpression',
    'TemplateSpan',
    'TaggedTemplateExpression',
    'AwaitExpression',
    'YieldExpression',
    'DeleteExpression',
    'TypeOfExpression',
    'VoidExpression',
    'NonNullExpression',
    'AsExpression',
    'TypeAssertionExpression',
    'SatisfiesExpression',
    'ThisKeyword',
    'SuperKeyword',
    'MetaProperty',
    'ImportDeclaration',
    'ImportClause',
    'NamedImports',
    'NamespaceImport',
    'ImportSpecifier',
    'ExportDeclaration',
    'NamedExports',
    'NamespaceExport',
    'ExportSpecifier',
    'ExportAssignment',
    'ImportEqualsDeclaration',
    'ExternalModuleReference',
    'ImportAttributes',
    'ImportAttribute',
    'EnumDeclaration',
    'EnumMember',
    'ModuleDeclaration',
    'ModuleBlock',
    'InterfaceDeclaration',
    'TypeAliasDeclaration',
    'NotEmittedStatement',
    'PartiallyEmittedExpression',
  ].map((name) => [name, true as const]),
)

const isScopeBoundary = (node: Node): boolean =>
  ts.isSourceFile(node) ||
  ts.isBlock(node) ||
  ts.isModuleBlock(node) ||
  ts.isCaseBlock(node) ||
  ts.isCatchClause(node) ||
  ts.isFunctionLikeDeclaration(node) ||
  ts.isForStatement(node) ||
  ts.isForOfStatement(node) ||
  ts.isForInStatement(node)

const addBindings = ({ target, name }: { target: Set<string>; name: BindingName }): void => {
  if (ts.isIdentifier(name) === true) target.add(name.text)
  else
    for (const element of name.elements) {
      if (ts.isBindingElement(element) === true && element.name !== undefined)
        addBindings({ target: target, name: element.name })
    }
}

/** Hoisting is collected per lexical scope, never across sibling blocks or functions. */
const scopeDeclarations = (node: Node): ReadonlySet<string> => {
  const declarations = new Set<string>()
  if (ts.isFunctionLikeDeclaration(node) === true) {
    for (const parameter of node.parameters)
      addBindings({ target: declarations, name: parameter.name })
    if (ts.isArrowFunction(node) === false) declarations.add('arguments')
  }
  if (
    (ts.isFunctionExpression(node) === true || ts.isClassExpression(node) === true) &&
    node.name !== undefined
  )
    declarations.add(node.name.text)
  if (ts.isCatchClause(node) === true && node.variableDeclaration !== undefined)
    addBindings({ target: declarations, name: node.variableDeclaration.name })
  const collect = (child: Node): void => {
    if (
      (ts.isFunctionDeclaration(child) === true ||
        ts.isClassDeclaration(child) === true ||
        ts.isEnumDeclaration(child) === true ||
        ts.isModuleDeclaration(child) === true) &&
      child.name !== undefined &&
      ts.isIdentifier(child.name) === true
    )
      declarations.add(child.name.text)
    if (isScopeBoundary(child) === true) return
    if (
      ts.isImportSpecifier(child) === true ||
      ts.isNamespaceImport(child) === true ||
      ts.isImportEqualsDeclaration(child) === true
    )
      declarations.add(child.name.text)
    if (ts.isImportClause(child) === true && child.name !== undefined)
      declarations.add(child.name.text)
    if (ts.isVariableDeclaration(child) === true)
      addBindings({ target: declarations, name: child.name })
    child.forEachChild((nested) => {
      collect(nested)
      return undefined
    })
  }
  node.forEachChild((child) => {
    collect(child)
    return undefined
  })
  return declarations
}

const literal = (node: Node | undefined): node is StringLiteral | NoSubstitutionTemplateLiteral =>
  node !== undefined &&
  (ts.isStringLiteral(node) === true || ts.isNoSubstitutionTemplateLiteral(node) === true)

/** Analyze an already-decoded native compiler AST without I/O or compiler RPCs. */
export const analyzeClosureAst = ({
  source,
  sourceFile: file,
}: {
  source: string
  sourceFile: SourceFile
}): ClosureModuleAnalysis => {
  const imports: Array<{ path: string; line: number | null }> = []
  const reasons: Array<{ operation: string; detail: string; line: number | null }> = []
  const lineStarts = [0]
  for (let index = 0; index < source.length; index++)
    if (source.charCodeAt(index) === 10) lineStarts.push(index + 1)
  const sourceLine = (node: Node): number => {
    const start = node.getStart(file)
    let low = 0
    let high = lineStarts.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (lineStarts[middle]! <= start) low = middle + 1
      else high = middle
    }
    return low
  }
  const reason = ({
    node,
    operation,
    detail,
  }: {
    node: Node
    operation: string
    detail: string
  }) => {
    reasons.push({ operation, detail, line: sourceLine(node) })
  }
  const edge = ({ node, specifier }: { node: Node; specifier: string }) => {
    imports.push({ path: specifier, line: sourceLine(node) })
    const name = specifier.replace(/^node:/, '')
    if (
      (builtins.has(name) === true && safeBuiltins[name] !== true) ||
      (specifier.startsWith('node:') === true && builtins.has(name) === false) ||
      specifier === 'bun' ||
      specifier.startsWith('bun:') === true ||
      specifier.startsWith('deno:') === true
    ) {
      reason({
        node: node,
        operation: 'capability-import',
        detail: `Capability module ${specifier} is not accounted for.`,
      })
    }
    if (/\.(?:node|wasm)(?:[?#]|$)/i.test(specifier) === true)
      reason({
        node: node,
        operation: 'native-loading',
        detail: 'WASM or native addon loading is not accounted for.',
      })
  }
  const reflectiveProperties: Readonly<Record<string, boolean>> = {
    constructor: true,
    ['__proto__']: true,
    caller: true,
    callee: true,
    arguments: true,
  }
  const ambientProperties: Readonly<Record<string, boolean>> = {
    localeCompare: true,
    toLocaleString: true,
    toLocaleLowerCase: true,
    toLocaleUpperCase: true,
    createObjectURL: true,
    revokeObjectURL: true,
    captureStackTrace: true,
    prepareStackTrace: true,
    stackTraceLimit: true,
    stack: true,
  }
  const classifyProperty = ({
    node,
    property,
  }: {
    node: Node
    property: string | undefined
  }): void => {
    if (reflectiveProperties[property ?? ''] === true)
      reason({
        node: node,
        operation: 'reflection',
        detail: 'Reflective constructor/prototype access cannot be accounted for.',
      })
    if (ambientProperties[property ?? ''] === true)
      reason({
        node: node,
        operation: 'ambient-state',
        detail: 'Locale, stack, or runtime registry access is not accounted for.',
      })
  }
  // Use source syntax, never project configuration or filename, to classify strictness.
  let strict = false
  for (const statement of file.statements) {
    if (
      ts.isImportDeclaration(statement) === true ||
      ts.isExportDeclaration(statement) === true ||
      ts.isExportAssignment(statement) === true
    )
      strict = true
    statement.forEachChild((child) => {
      if (child.kind === ts.SyntaxKind.ExportKeyword) strict = true
      return undefined
    })
  }
  for (const statement of file.statements) {
    if (
      ts.isExpressionStatement(statement) === false ||
      ts.isStringLiteral(statement.expression) === false
    )
      break
    if (statement.expression.text === 'use strict') strict = true
  }
  const visit = ({
    node,
    scopes,
  }: {
    node: Node
    scopes: readonly ReadonlySet<string>[]
  }): void => {
    if ((node.flags & ts.NodeFlags.ThisNodeHasError) !== 0)
      reason({
        node: node,
        operation: 'syntax',
        detail: 'The compiler could not parse this construct completely.',
      })
    if (node.kind >= ts.SyntaxKind.FirstTypeNode && node.kind <= ts.SyntaxKind.LastTypeNode) return
    if (
      ts.isTypeParameterDeclaration(node) === true ||
      ts.isInterfaceDeclaration(node) === true ||
      ts.isTypeAliasDeclaration(node) === true
    )
      return
    const nextScopes =
      isScopeBoundary(node) === true ? [...scopes, scopeDeclarations(node)] : scopes
    if (node.kind === ts.SyntaxKind.DeclareKeyword) {
      reason({
        node: node,
        operation: 'ambient-declaration',
        detail: 'Declared runtime bindings do not have an accounted implementation.',
      })
    }
    if (node.kind > ts.SyntaxKind.LastToken && supportedSyntax[ts.SyntaxKind[node.kind]] !== true) {
      reason({
        node: node,
        operation: 'unknown-syntax',
        detail: `Unclassified syntax ${ts.SyntaxKind[node.kind]}.`,
      })
    }
    if (node.kind === ts.SyntaxKind.ThisKeyword && strict === false) {
      let ancestor = node.parent
      while (
        ancestor !== undefined &&
        ts.isClassDeclaration(ancestor) === false &&
        ts.isClassExpression(ancestor) === false
      )
        ancestor = ancestor.parent
      if (ancestor === undefined)
        reason({
          node: node,
          operation: 'ambient-this',
          detail: 'Non-strict this may expose the ambient global object.',
        })
    }
    if (ts.isBindingElement(node) === true && node.name === undefined)
      reason({
        node: node,
        operation: 'unknown-binding',
        detail: 'A runtime binding has no classified name.',
      })
    if (ts.isBindingElement(node) === true && ts.isObjectBindingPattern(node.parent) === true) {
      const key = node.propertyName ?? node.name
      if (key !== undefined && ts.isComputedPropertyName(key) === true) {
        if (literal(key.expression) === true)
          classifyProperty({ node, property: key.expression.text })
        else if (ts.isNumericLiteral(key.expression) === false)
          reason({
            node: node,
            operation: 'computed-access',
            detail: 'Computed destructuring cannot be classified statically.',
          })
      } else if (key !== undefined && (ts.isIdentifier(key) === true || literal(key) === true))
        classifyProperty({ node: node, property: key.text })
    }
    if (ts.isImportDeclaration(node) === true) {
      const clause = node.importClause
      if (clause?.phaseModifier === ts.SyntaxKind.TypeKeyword) return
      if (
        clause?.namedBindings !== undefined &&
        ts.isNamedImports(clause.namedBindings) === true &&
        clause.name === undefined &&
        clause.namedBindings.elements.length > 0 &&
        clause.namedBindings.elements.every((item) => item.isTypeOnly) === true
      )
        return
      if (literal(node.moduleSpecifier) === true)
        edge({ node, specifier: node.moduleSpecifier.text })
      else
        reason({
          node: node,
          operation: 'unknown-import',
          detail: 'Import module specifier is not a literal.',
        })
    }
    if (ts.isExportDeclaration(node) === true) {
      if (node.isTypeOnly === true) return
      if (
        node.exportClause !== undefined &&
        ts.isNamedExports(node.exportClause) === true &&
        node.exportClause.elements.length > 0 &&
        node.exportClause.elements.every((item) => item.isTypeOnly) === true
      )
        return
      if (node.moduleSpecifier !== undefined) {
        if (literal(node.moduleSpecifier) === true)
          edge({ node, specifier: node.moduleSpecifier.text })
        else
          reason({
            node: node,
            operation: 'unknown-import',
            detail: 'Export module specifier is not a literal.',
          })
      }
    }
    if (ts.isImportEqualsDeclaration(node) === true) {
      if (node.isTypeOnly === true) return
      if (
        ts.isExternalModuleReference(node.moduleReference) === true &&
        literal(node.moduleReference.expression) === true
      )
        edge({ node: node, specifier: node.moduleReference.expression.text })
      else
        reason({
          node: node,
          operation: 'unknown-import',
          detail: 'Import alias cannot be classified.',
        })
    }
    if (ts.isWithStatement(node) === true)
      reason({ node: node, operation: 'with', detail: 'Dynamic scope cannot be accounted for.' })
    if (
      ts.isCallExpression(node) === true &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) === true && node.expression.text === 'require'))
    ) {
      if (literal(node.arguments[0]) === true) edge({ node, specifier: node.arguments[0].text })
      else
        reason({
          node: node,
          operation:
            node.expression.kind === ts.SyntaxKind.ImportKeyword
              ? 'dynamic-import'
              : 'dynamic-require',
          detail: 'Non-literal module loading cannot be accounted for.',
        })
    }
    if (
      ts.isPropertyAccessExpression(node) === true ||
      ts.isElementAccessExpression(node) === true
    ) {
      const root = node.expression
      const property =
        ts.isPropertyAccessExpression(node) === true
          ? node.name.text
          : literal(node.argumentExpression) === true
            ? node.argumentExpression.text
            : undefined
      if (
        ts.isElementAccessExpression(node) === true &&
        ((literal(node.argumentExpression) === false &&
          ts.isNumericLiteral(node.argumentExpression) === false) ||
          (ts.isIdentifier(root) === true && pureGlobals[root.text] === true))
      ) {
        reason({
          node: node,
          operation: 'computed-access',
          detail: 'Computed runtime member access cannot be classified statically.',
        })
      }
      if (
        ts.isIdentifier(root) === true &&
        ['globalThis', 'process', 'Bun', 'Deno'].includes(root.text) === true
      ) {
        reason({
          node: node,
          operation:
            ts.isElementAccessExpression(node) === true
              ? 'computed-ambient-access'
              : 'ambient-access',
          detail: `${root.text}${property === undefined ? ' computed access' : `.${property}`} is not accounted for.`,
        })
      }
      classifyProperty({ node: node, property: property })
      if (
        ts.isIdentifier(root) === true &&
        ((root.text === 'Math' && property === 'random') ||
          root.text === 'Date' ||
          (root.text === 'Symbol' && property === 'for') ||
          (root.text === 'Object' &&
            [
              'getPrototypeOf',
              'setPrototypeOf',
              'getOwnPropertyDescriptor',
              'getOwnPropertyDescriptors',
            ].includes(property ?? '') === true))
      ) {
        reason({
          node: node,
          operation: 'ambient-state',
          detail: 'Ambient state or reflective access is not accounted for.',
        })
      }
      if (root.kind === ts.SyntaxKind.MetaProperty) {
        if (property !== 'resolve')
          reason({
            node: node,
            operation: 'import-meta',
            detail: 'Module-location-dependent import metadata is not accounted for.',
          })
        else {
          const call = node.parent
          if (ts.isCallExpression(call) === false || literal(call.arguments[0]) === false)
            reason({
              node: node,
              operation: 'import-meta-resolve',
              detail: 'Non-literal import.meta.resolve is not accounted for.',
            })
          else edge({ node: node, specifier: call.arguments[0].text })
        }
      }
    }
    if (ts.isIdentifier(node) === true) {
      const name = node.text
      const parent = node.parent
      const propertyName =
        parent !== undefined &&
        (('name' in parent && parent.name === node && !ts.isShorthandPropertyAssignment(parent)) ||
          ('propertyName' in parent && parent.propertyName === node) ||
          ts.isImportSpecifier(parent) ||
          ts.isExportSpecifier(parent) ||
          ts.isMetaProperty(parent) ||
          ((ts.isBreakStatement(parent) ||
            ts.isContinueStatement(parent) ||
            ts.isLabeledStatement(parent)) &&
            parent.label === node))
      if (propertyName === false) {
        if (['eval', 'Function', 'createRequire', 'WebAssembly'].includes(name) === true)
          reason({
            node: node,
            operation: name,
            detail: `${name} capability is not accounted for.`,
          })
        else if (['globalThis', 'process', 'Bun', 'Deno'].includes(name) === true) {
          if (
            parent === undefined ||
            !(
              ts.isPropertyAccessExpression(parent) === true ||
              ts.isElementAccessExpression(parent) === true
            )
          )
            reason({
              node: node,
              operation: 'ambient-reference',
              detail: `${name} may expose ambient capabilities.`,
            })
        } else if (
          ['Math', 'Object', 'Symbol'].includes(name) === true &&
          (parent === undefined ||
            !(ts.isPropertyAccessExpression(parent) === true && parent.expression === node))
        ) {
          reason({
            node: node,
            operation: 'ambient-reference',
            detail: `${name} aliases may expose ambient state or reflection.`,
          })
        } else if (
          name !== 'require' &&
          pureGlobals[name] !== true &&
          nextScopes.some((scope) => scope.has(name)) === false
        ) {
          reason({
            node: node,
            operation: 'unknown-global',
            detail: `Unresolved runtime identifier ${name}.`,
          })
        } else if (
          name === 'require' &&
          (parent === undefined ||
            !(ts.isCallExpression(parent) === true && parent.expression === node))
        ) {
          reason({
            node: node,
            operation: 'require-reference',
            detail: 'Aliased module loading cannot be accounted for.',
          })
        }
      }
    }
    node.forEachChild((child) => {
      // Type annotations and generic arguments are erased; class `extends` expressions are not.
      if ('type' in node && child === node.type) return undefined
      if (
        'typeParameters' in node &&
        Array.isArray(node.typeParameters) === true &&
        node.typeParameters.includes(child) === true
      )
        return undefined
      if (
        'typeArguments' in node &&
        Array.isArray(node.typeArguments) === true &&
        node.typeArguments.includes(child) === true
      )
        return undefined
      if (ts.isHeritageClause(child) === true && child.token === ts.SyntaxKind.ImplementsKeyword)
        return undefined
      visit({ node: child, scopes: nextScopes })
      return undefined
    })
  }
  visit({ node: file, scopes: [] })
  return { imports, reasons }
}

const validLine = (line: unknown): boolean =>
  line === null || (typeof line === 'number' && Number.isInteger(line) === true && line > 0)

const validAnalysis = (value: unknown): value is ClosureModuleAnalysis => {
  if (typeof value !== 'object' || value === null || !('imports' in value) || !('reasons' in value))
    return false
  return (
    Array.isArray(value.imports) &&
    value.imports.every(
      (item: unknown) =>
        typeof item === 'object' &&
        item !== null &&
        'path' in item &&
        typeof item.path === 'string' &&
        'line' in item &&
        validLine(item.line),
    ) &&
    Array.isArray(value.reasons) &&
    value.reasons.every(
      (item: unknown) =>
        typeof item === 'object' &&
        item !== null &&
        'operation' in item &&
        typeof item.operation === 'string' &&
        'detail' in item &&
        typeof item.detail === 'string' &&
        'line' in item &&
        validLine(item.line),
    )
  )
}

/** Compiler-session and cache configuration for a read-set analysis invocation. */
export type ClosureAnalyzerOptions = {
  readonly cwd?: string
  readonly cacheDirectory?: string | false
  readonly analyzerVersion?: string
  /** Session seam for deterministic failed/dead-server tests. */
  readonly runAnalysis?: typeof runTsFileAnalysis
}

/** Shared lazy compiler lifetime used to analyze a module closure. */
export type ClosureAnalyzer = {
  readonly analyze: (module: { source: string; filename: string }) => Promise<ClosureModuleAnalysis>
  readonly close: () => Promise<void>
}

/** Read-set only. The native compiler is acquired on the first cache miss and shared until close. */
export const createClosureAnalyzer = ({
  cwd = process.cwd(),
  cacheDirectory,
  analyzerVersion = closureAnalyzerVersion,
  runAnalysis = runTsFileAnalysis,
}: ClosureAnalyzerOptions = {}): ClosureAnalyzer => {
  let session: Promise<TsFileAnalysisSession> | undefined
  let lifetime: Promise<void> | undefined
  let release: (() => void) | undefined
  let closed = false
  const acquire = (): Promise<TsFileAnalysisSession> => {
    if (session !== undefined) return session
    const ready = Promise.withResolvers<TsFileAnalysisSession>()
    const done = Promise.withResolvers<void>()
    release = () => done.resolve()
    session = ready.promise
    lifetime = runAnalysis({
      cwd,
      use: async (value) => {
        ready.resolve(value)
        await done.promise
      },
    }).then(
      () => undefined,
      (error: unknown) => {
        ready.reject(error)
      },
    )
    return session
  }
  return {
    analyze: async ({ source, filename }) => {
      if (closed === true)
        return {
          imports: [],
          reasons: [
            {
              operation: 'analysis-unavailable',
              detail: 'Closure analysis session is closed.',
              line: null,
            },
          ],
        }
      const grammar = /\.(?:jsx|tsx)$/i.test(filename) === true ? 'tsx' : 'ts'
      const version = `${analyzerVersion}:typescript-${compilerVersion}:${grammar}`
      const digest = createHash('sha256').update(version).update('\0').update(source).digest('hex')
      const directory =
        cacheDirectory === false
          ? undefined
          : (cacheDirectory ??
            path.join(
              process.env.XDG_CACHE_HOME ?? path.join(homedir(), '.cache'),
              'genie',
              'closure-analysis',
            ))
      const key = `${directory ?? 'memory'}:${digest}`
      const existing = memoryCache.get(key)
      if (existing !== undefined) return existing
      const cacheFile = directory === undefined ? undefined : path.join(directory, `${digest}.json`)
      if (cacheFile !== undefined) {
        try {
          const stored: unknown = JSON.parse(readFileSync(cacheFile, 'utf8'))
          if (
            typeof stored === 'object' &&
            stored !== null &&
            'digest' in stored &&
            stored.digest === digest &&
            'version' in stored &&
            stored.version === version &&
            'analysis' in stored &&
            validAnalysis(stored.analysis) === true
          ) {
            memoryCache.set(key, stored.analysis)
            return stored.analysis
          }
        } catch {
          /* Missing or corrupt caches are recomputed, never treated as accounting. */
        }
      }
      let analysis: ClosureModuleAnalysis
      try {
        const outcome = await (await acquire()).analyze(path.resolve(cwd, filename))
        if (outcome.kind !== 'analyzed') {
          return {
            imports: [],
            reasons: [
              {
                operation: 'analysis-unavailable',
                detail: 'The compiler could not supply a source AST.',
                line: null,
              },
            ],
          }
        }
        if (outcome.analysis.sourceFile.text !== source) {
          return {
            imports: [],
            reasons: [
              {
                operation: 'analysis-unavailable',
                detail: 'Compiler source bytes do not match the recorded module bytes.',
                line: null,
              },
            ],
          }
        }
        analysis = analyzeClosureAst({ source, sourceFile: outcome.analysis.sourceFile })
      } catch {
        // Never persist an unavailable server as a byte-level property of the module.
        return {
          imports: [],
          reasons: [
            {
              operation: 'analysis-unavailable',
              detail: 'The compiler session could not analyze this module.',
              line: null,
            },
          ],
        }
      }
      memoryCache.set(key, analysis)
      if (cacheFile !== undefined && directory !== undefined) {
        const temporary = `${cacheFile}.${randomUUID()}.tmp`
        try {
          mkdirSync(directory, { recursive: true, mode: 0o700 })
          writeFileSync(temporary, JSON.stringify({ digest, version, analysis }), {
            flag: 'wx',
            mode: 0o600,
          })
          renameSync(temporary, cacheFile)
        } catch {
          /* Cache availability never changes the analysis result. */
        } finally {
          try {
            unlinkSync(temporary)
          } catch {
            /* Publication removed the temporary file. */
          }
        }
      }
      return analysis
    },
    close: async () => {
      closed = true
      release?.()
      await lifetime
    },
  }
}

/** One-off convenience. Graph walks use createClosureAnalyzer to share the compiler lifetime. */
export const analyzeClosureModule = async ({
  module,
  options = {},
}: {
  module: { source: string; filename: string }
  options?: ClosureAnalyzerOptions
}): Promise<ClosureModuleAnalysis> => {
  const analyzer = createClosureAnalyzer(options)
  try {
    return await analyzer.analyze(module)
  } finally {
    await analyzer.close()
  }
}
