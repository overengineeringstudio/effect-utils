/**
 * jsdoc-require-exports oxlint rule.
 *
 * Requires JSDoc comments on exported declarations.
 *
 * Requires JSDoc on:
 * - Type definitions: `export interface X`, `export type X = ...`
 * - Value exports: `export const X`, `export function X`, `export class X`
 * - Named namespace exports: `export * as name from '...'`
 *
 * Does NOT require JSDoc on:
 * - Re-exports: `export * from '...'`, `export { X } from '...'`, `export type { X } from '...'`
 * - Typeof-derived types: `export type X = typeof Y.Type`
 *
 * NOTE: JS plugins are experimental. WASM plugins may become available for better performance.
 * See: https://github.com/oxc-project/oxc/discussions/10342
 */

import type { Rule, SourceCode } from 'eslint'

type ASTNode = Rule.Node

/**
 * Check if a node has an adjacent JSDoc comment (block comment starting with *).
 * Only considers comments that end on the line immediately before the node starts,
 * to avoid attributing module-level doc comments to the first export.
 */
// oxlint-disable-next-line overeng/named-args -- simple internal helper
const hasJsDocComment = (node: ASTNode, sourceCode: SourceCode) => {
  const comments = sourceCode.getCommentsBefore(node)
  const nodeStartLine = node.loc?.start.line
  if (nodeStartLine === undefined) return false

  for (const comment of comments) {
    if (comment.type === 'Block' && comment.value.startsWith('*')) {
      const commentEndLine = comment.loc?.end.line
      if (commentEndLine === undefined) continue

      /** Only count as JSDoc if it ends on the line immediately before the node */
      if (nodeStartLine - commentEndLine === 1) {
        return true
      }
    }
  }
  return false
}

/**
 * Check if a type alias is derived via typeof (e.g., `type User = typeof User.Type`).
 * These are excluded since the source should have documentation.
 */
const isDerivedTypeofAlias = (decl: any) => {
  if (decl?.type !== 'TSTypeAliasDeclaration') return false
  const typeAnnotation = decl.typeAnnotation
  // Check if the type annotation is a TSTypeQuery (typeof X)
  return typeAnnotation?.type === 'TSTypeQuery'
}

/**
 * Check if this is an export declaration that requires JSDoc.
 * Re-exports (export { X } from '...') are excluded - the source should have docs.
 * Typeof-derived type aliases are also excluded since they derive from documented sources.
 */
const isExportRequiringJsDoc = (node: ASTNode) => {
  if (node.type === 'ExportNamedDeclaration') {
    const n = node as any
    const decl = n.declaration

    /** No declaration means it's a re-export like `export { X } from '...'` */
    if (decl === undefined || decl === null) return false

    /** export type X = typeof Y - skip, derived types don't need JSDoc */
    if (decl.type === 'TSTypeAliasDeclaration' && isDerivedTypeofAlias(decl)) {
      return false
    }

    /** export interface ... */
    if (decl.type === 'TSInterfaceDeclaration') return true

    /** export type X = ... (non-typeof-derived) */
    if (decl.type === 'TSTypeAliasDeclaration') return true

    /** export const X = ... / export let X = ... */
    if (decl.type === 'VariableDeclaration') return true

    /** export function X() { ... } */
    if (decl.type === 'FunctionDeclaration') return true

    /** export class X { ... } */
    if (decl.type === 'ClassDeclaration') return true
  }
  return false
}

/** Get a description for the export for the error message. */
const getExportDescription = (node: ASTNode) => {
  if (node.type === 'ExportAllDeclaration') {
    return `* from '${(node as any).source.value}'`
  }

  if (node.type === 'ExportNamedDeclaration') {
    const n = node as any
    const decl = n.declaration

    if (decl?.type === 'TSInterfaceDeclaration') {
      return `interface ${decl.id.name}`
    }
    if (decl?.type === 'TSTypeAliasDeclaration') {
      return `type ${decl.id.name}`
    }
    if (decl?.type === 'VariableDeclaration') {
      const names = decl.declarations.map((d: any) => d.id?.name ?? 'unknown').join(', ')
      return `const ${names}`
    }
    if (decl?.type === 'FunctionDeclaration') {
      return `function ${decl.id?.name ?? 'unknown'}`
    }
    if (decl?.type === 'ClassDeclaration') {
      return `class ${decl.id?.name ?? 'unknown'}`
    }
  }

  return 'export'
}

export const jsdocRequireExportsRule: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Require JSDoc comments on exported declarations',
      recommended: false,
    },
    messages: {
      missingJsdoc: "Missing JSDoc comment for exported '{{name}}'.",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode()

    return {
      ExportAllDeclaration(node) {
        // Only require JSDoc for named namespace exports: export * as name from '...'
        // Plain re-exports (export * from '...') don't need JSDoc
        const n = node as any
        if (!n.exported) return

        if (!hasJsDocComment(node, sourceCode)) {
          context.report({
            node,
            messageId: 'missingJsdoc',
            data: { name: getExportDescription(node) },
          })
        }
      },

      ExportNamedDeclaration(node) {
        if (!isExportRequiringJsDoc(node)) return

        if (!hasJsDocComment(node, sourceCode)) {
          context.report({
            node,
            messageId: 'missingJsdoc',
            data: { name: getExportDescription(node) },
          })
        }
      },
    }
  },
}
