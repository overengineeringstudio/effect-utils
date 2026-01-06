/**
 * jsdoc-require-exports oxlint rule.
 *
 * Requires JSDoc comments on type-level exports and named namespace re-exports.
 * Type exports and wildcard re-exports need documentation to explain what they expose,
 * since their contents are not immediately visible at the export site.
 *
 * Requires JSDoc on:
 * - Type definitions: `export interface ...` and `export type X = ...`
 * - Named namespace re-exports: `export * as name from '...'`
 *
 * Does NOT require JSDoc on:
 * - Plain wildcard re-exports: `export * from '...'`
 * - Type re-exports: `export type { X } from '...'`
 * - Typeof-derived types: `export type X = typeof Y.Type`
 * - Value exports: `export const`, `export function`, etc.
 *
 * NOTE: JS plugins are experimental. WASM plugins may become available for better performance.
 * See: https://github.com/oxc-project/oxc/discussions/10342
 */

import type { Rule, SourceCode } from 'eslint'

type ASTNode = Rule.Node

/** Check if a node has a JSDoc comment (block comment starting with *). */
const hasJsDocComment = (node: ASTNode, sourceCode: SourceCode) => {
  const comments = sourceCode.getCommentsBefore(node)
  for (const comment of comments) {
    if (comment.type === 'Block' && comment.value.startsWith('*')) {
      return true
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
 * Check if this is a type definition export (interface or type alias, NOT a re-export).
 * Excludes typeof-derived type aliases since they derive documentation from their source.
 */
const isTypeDefinitionExport = (node: ASTNode) => {
  if (node.type === 'ExportNamedDeclaration') {
    const n = node as any
    const decl = n.declaration

    // export type X = typeof Y - skip, derived types don't need JSDoc
    if (decl?.type === 'TSTypeAliasDeclaration' && isDerivedTypeofAlias(decl)) {
      return false
    }

    // export interface ... (definition)
    if (decl?.type === 'TSInterfaceDeclaration') return true

    // export type X = ... (definition, non-typeof-derived)
    if (decl?.type === 'TSTypeAliasDeclaration') return true

    // Note: export type { X } from '...' is a re-export, not a definition - skip it
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

    // Type declaration: export interface X or export type X
    if (decl?.type === 'TSInterfaceDeclaration') {
      return `interface ${decl.id.name}`
    }
    if (decl?.type === 'TSTypeAliasDeclaration') {
      return `type ${decl.id.name}`
    }
  }

  return 'export'
}

export const jsdocRequireExportsRule: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Require JSDoc comments on type-level exports and wildcard re-exports',
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
        // Only check type definition exports (not re-exports)
        if (!isTypeDefinitionExport(node)) return

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
