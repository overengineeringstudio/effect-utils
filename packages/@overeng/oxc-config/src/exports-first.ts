/**
<<<<<<<< HEAD:packages/@overeng/oxc-config/src/exports-first.ts
 * exports-first oxlint rule.
========
 * Oxlint JS plugin rule that enforces exported declarations appear before non-exported declarations.
>>>>>>>> a7200fc (Implement JSDoc requirements for type exports and refactor oxlint plugins):packages/@overeng/oxc-config/src/exports-first-plugin.ts
 *
 * Enforce exported declarations appear before non-exported declarations.
 * This helps with code readability by putting the public API at the top of files.
 * The rule is "control-flow aware": private declarations that are referenced by
 * subsequent exports are allowed to appear before those exports.
 *
<<<<<<<< HEAD:packages/@overeng/oxc-config/src/exports-first.ts
 * @example
 * // ✅ Good - exports first
 * export const publicApi = () => {}
 * export const anotherExport = 42
 * const helper = () => {}
 *
 * // ✅ Good - private dependency before export that uses it
 * const MAX_OPTIONS = 5
 * export const LiteralField = () => { return MAX_OPTIONS }
 *
 * // ❌ Bad - non-export before export (not referenced)
 * const unrelatedHelper = () => {}
 * export const publicApi = () => {}
 */

// NOTE: Using `any` types because oxlint JS plugin API doesn't have TypeScript definitions yet

/** Check if a node is a declaration that should be tracked. */
const isTrackableDeclaration = (node: any): boolean => {
  const type = node.type
========
 * TODO: Remove this custom rule once upstream support lands.
 * See: https://github.com/oxc-project/oxc/issues/17706
 *
 * NOTE: WASM plugins may become available in the future for better performance.
 * See: https://github.com/oxc-project/oxc/discussions/10342
 */

import type { Rule } from 'eslint'

type ASTNode = Rule.Node

/**
 * Check if a node is a declaration that should be tracked.
 * Excludes import statements and type-only declarations (interfaces, type aliases).
 * Type-only declarations are compile-time only and don't affect runtime code organization.
 */
const isTrackableDeclaration = (node: ASTNode) => {
  const type = node.type as string
>>>>>>>> a7200fc (Implement JSDoc requirements for type exports and refactor oxlint plugins):packages/@overeng/oxc-config/src/exports-first-plugin.ts
  return (
    type === 'VariableDeclaration' ||
    type === 'FunctionDeclaration' ||
    type === 'ClassDeclaration' ||
    type === 'TSEnumDeclaration'
  )
}

/** Check if a node is an export declaration (named or default). */
<<<<<<<< HEAD:packages/@overeng/oxc-config/src/exports-first.ts
const isExportDeclaration = (node: any): boolean =>
  node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration'

/** Check if an export is a re-export (no declaration, just re-exporting from another module). */
const isReExport = (node: any): boolean =>
  node.type === 'ExportNamedDeclaration' && node.source !== null

/** Check if this is a type-only export (should be ignored). */
const isTypeOnlyExport = (node: any): boolean => {
========
const isExportDeclaration = (node: ASTNode) =>
  node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration'

/** Check if an export is a re-export (no declaration, just re-exporting from another module). */
const isReExport = (node: ASTNode) =>
  node.type === 'ExportNamedDeclaration' && (node as any).source !== null

/** Check if this is a type-only export (should be ignored). */
const isTypeOnlyExport = (node: ASTNode) => {
>>>>>>>> a7200fc (Implement JSDoc requirements for type exports and refactor oxlint plugins):packages/@overeng/oxc-config/src/exports-first-plugin.ts
  if (node.type === 'ExportNamedDeclaration') {
    return (node as any).exportKind === 'type'
  }
  return false
}

/** Get declared names from a declaration node. */
<<<<<<<< HEAD:packages/@overeng/oxc-config/src/exports-first.ts
const getDeclaredNames = (node: any): Set<string> => {
========
const getDeclaredNames = (node: ASTNode) => {
>>>>>>>> a7200fc (Implement JSDoc requirements for type exports and refactor oxlint plugins):packages/@overeng/oxc-config/src/exports-first-plugin.ts
  const names = new Set<string>()

  if (node.type === 'VariableDeclaration') {
    for (const decl of node.declarations) {
      if (decl.id.type === 'Identifier') {
        names.add(decl.id.name)
      } else if (decl.id.type === 'ObjectPattern') {
        for (const prop of decl.id.properties) {
          if (prop.type === 'Property' && prop.value.type === 'Identifier') {
            names.add(prop.value.name)
          } else if (prop.type === 'RestElement' && prop.argument.type === 'Identifier') {
            names.add(prop.argument.name)
          }
        }
      } else if (decl.id.type === 'ArrayPattern') {
        for (const elem of decl.id.elements) {
          if (elem?.type === 'Identifier') {
            names.add(elem.name)
          }
        }
      }
    }
  } else if (
    (node.type as string) === 'FunctionDeclaration' ||
    (node.type as string) === 'ClassDeclaration' ||
    (node.type as string) === 'TSEnumDeclaration'
  ) {
    const id = (node as any).id
    if (id?.name) {
      names.add(id.name)
    }
  }

  return names
}

/** Collect all identifier references in a node (recursively). */
<<<<<<<< HEAD:packages/@overeng/oxc-config/src/exports-first.ts
const collectReferences = (opts: { node: any; refs?: Set<string> }): Set<string> => {
  const { node } = opts
  const refs = opts.refs ?? new Set()
========
const collectReferences = (node: unknown, refs = new Set<string>()): Set<string> => {
>>>>>>>> a7200fc (Implement JSDoc requirements for type exports and refactor oxlint plugins):packages/@overeng/oxc-config/src/exports-first-plugin.ts
  if (!node || typeof node !== 'object') return refs

  const n = node as Record<string, unknown>
  if (n.type === 'Identifier' && typeof n.name === 'string') {
    refs.add(n.name)
    return refs
  }

<<<<<<<< HEAD:packages/@overeng/oxc-config/src/exports-first.ts
  for (const key of Object.keys(node)) {
========
  for (const key of Object.keys(n)) {
>>>>>>>> a7200fc (Implement JSDoc requirements for type exports and refactor oxlint plugins):packages/@overeng/oxc-config/src/exports-first-plugin.ts
    if (key === 'parent' || key === 'loc' || key === 'range') continue

    const value = n[key]
    if (Array.isArray(value)) {
      for (const item of value) {
        collectReferences({ node: item, refs })
      }
    } else if (value && typeof value === 'object') {
      collectReferences({ node: value, refs })
    }
  }

  return refs
}

/** Get the declaration part of an export node. */
<<<<<<<< HEAD:packages/@overeng/oxc-config/src/exports-first.ts
const getExportDeclaration = (node: any): any => {
========
const getExportDeclaration = (node: ASTNode) => {
>>>>>>>> a7200fc (Implement JSDoc requirements for type exports and refactor oxlint plugins):packages/@overeng/oxc-config/src/exports-first-plugin.ts
  if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration') {
    return (node as any).declaration
  }
  return null
}

<<<<<<<< HEAD:packages/@overeng/oxc-config/src/exports-first.ts
export const exportsFirstRule = {
========
export const exportsFirstRule: Rule.RuleModule = {
>>>>>>>> a7200fc (Implement JSDoc requirements for type exports and refactor oxlint plugins):packages/@overeng/oxc-config/src/exports-first-plugin.ts
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Enforce exported declarations come before non-exported declarations',
      recommended: false,
    },
    messages: {
      exportAfterNonExport:
        'Exported declaration should come before non-exported declarations. Move this export above non-exported code.',
    },
  },
  create(context: any) {
    return {
<<<<<<<< HEAD:packages/@overeng/oxc-config/src/exports-first.ts
      Program(programNode: any) {
        /**
         * Fast-path:
         * - If there are no exports, nothing to report.
         * - If there are no trackable non-exports, nothing to report.
         * - If every export appears before the first trackable non-export, nothing to report.
         *
         * This avoids the heavier reference collection for the common "already ordered" case.
         */
========
      Program(programNode) {
        // Fast-path optimization:
        // - If there are no exports, nothing to report.
        // - If there are no trackable non-exports, nothing to report.
        // - If every export appears before the first trackable non-export, nothing to report.
        // This avoids the heavier reference collection for the common "already ordered" case.
>>>>>>>> a7200fc (Implement JSDoc requirements for type exports and refactor oxlint plugins):packages/@overeng/oxc-config/src/exports-first-plugin.ts
        let hasExport = false
        let hasTrackableNonExport = false
        let exportAfterNonExport = false

        for (const node of programNode.body) {
          if (node.type === 'ImportDeclaration') continue
          if (isReExport(node)) continue
          if (isTypeOnlyExport(node)) continue

          if (isExportDeclaration(node)) {
            hasExport = true
            if (hasTrackableNonExport) {
              exportAfterNonExport = true
              break
            }
            continue
          }

          if (isTrackableDeclaration(node)) {
            hasTrackableNonExport = true
          }
        }

        if (!hasExport || !hasTrackableNonExport || !exportAfterNonExport) {
          return
        }

<<<<<<<< HEAD:packages/@overeng/oxc-config/src/exports-first.ts
        // First pass: collect all non-exported declarations and their positions
        const nonExportedDecls: Array<{ names: Set<string>; node: any; index: number }> = []
        const exports: Array<{ node: any; index: number; refs: Set<string> }> = []
========
        const nonExportedDecls: Array<{ names: Set<string>; node: ASTNode; index: number }> = []
        const exports: Array<{ node: ASTNode; index: number; refs: Set<string> }> = []
>>>>>>>> a7200fc (Implement JSDoc requirements for type exports and refactor oxlint plugins):packages/@overeng/oxc-config/src/exports-first-plugin.ts

        for (let i = 0; i < programNode.body.length; i++) {
          const node = programNode.body[i] as ASTNode

          if (node.type === 'ImportDeclaration') continue
          if (isReExport(node)) continue
          if (isTypeOnlyExport(node)) continue

          if (isExportDeclaration(node)) {
            const decl = getExportDeclaration(node)
<<<<<<<< HEAD:packages/@overeng/oxc-config/src/exports-first.ts
            const refs = decl ? collectReferences({ node: decl }) : new Set<string>()
========
            const refs = decl ? collectReferences(decl) : new Set<string>()
>>>>>>>> a7200fc (Implement JSDoc requirements for type exports and refactor oxlint plugins):packages/@overeng/oxc-config/src/exports-first-plugin.ts
            exports.push({ node, index: i, refs })
          } else if (isTrackableDeclaration(node)) {
            const names = getDeclaredNames(node)
            nonExportedDecls.push({ names, node, index: i })
          }
        }

        const referencedByAnyExport = new Set<string>()
        for (const exp of exports) {
          for (const ref of exp.refs) {
            referencedByAnyExport.add(ref)
          }
        }

        let changed = true
        while (changed) {
          changed = false
          for (const decl of nonExportedDecls) {
            let isNeeded = false
            for (const name of decl.names) {
              if (referencedByAnyExport.has(name)) {
                isNeeded = true
                break
              }
            }

            if (isNeeded) {
<<<<<<<< HEAD:packages/@overeng/oxc-config/src/exports-first.ts
              const declRefs = collectReferences({ node: decl.node })
========
              const declRefs = collectReferences(decl.node)
>>>>>>>> a7200fc (Implement JSDoc requirements for type exports and refactor oxlint plugins):packages/@overeng/oxc-config/src/exports-first-plugin.ts
              for (const ref of declRefs) {
                if (!referencedByAnyExport.has(ref)) {
                  referencedByAnyExport.add(ref)
                  changed = true
                }
              }
            }
          }
        }

        for (const exp of exports) {
          for (const decl of nonExportedDecls) {
            if (decl.index < exp.index) {
              let isReferenced = false
              for (const name of decl.names) {
                if (referencedByAnyExport.has(name)) {
                  isReferenced = true
                  break
                }
              }

              if (!isReferenced) {
                context.report({
                  node: exp.node,
                  messageId: 'exportAfterNonExport',
                })
                break
              }
            }
          }
        }
      },
    }
  },
}
<<<<<<<< HEAD:packages/@overeng/oxc-config/src/exports-first.ts
========

const plugin = {
  meta: {
    name: 'overeng-exports',
    version: '0.1.0',
  },
  rules: {
    first: exportsFirstRule,
  },
}

export default plugin
>>>>>>>> a7200fc (Implement JSDoc requirements for type exports and refactor oxlint plugins):packages/@overeng/oxc-config/src/exports-first-plugin.ts
