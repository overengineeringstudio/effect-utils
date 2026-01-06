/**
 * Oxlint JS plugin that enforces exported declarations appear before non-exported declarations.
 *
 * This helps with code readability by putting the public API at the top of files.
 *
 * The rule is "control-flow aware": private declarations that are referenced by
 * subsequent exports are allowed to appear before those exports.
 *
 * TODO: Remove this custom plugin once upstream support lands.
 * See: https://github.com/oxc-project/oxc/issues/17706
 *
 * NOTE: WASM plugins may become available in the future for better performance.
 * See: https://github.com/oxc-project/oxc/discussions/10342
 *
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

/**
 * Check if a node is a declaration that should be tracked.
 * Excludes import statements and type-only declarations (interfaces, type aliases).
 * Type-only declarations are compile-time only and don't affect runtime code organization.
 */
const isTrackableDeclaration = (node) => {
  const type = node.type
  return (
    type === 'VariableDeclaration' ||
    type === 'FunctionDeclaration' ||
    type === 'ClassDeclaration' ||
    type === 'TSEnumDeclaration'
    // Note: TSInterfaceDeclaration and TSTypeAliasDeclaration are excluded
    // because they are type-only and don't affect runtime code
  )
}

/** Check if a node is an export declaration (named or default). */
const isExportDeclaration = (node) =>
  node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration'

/** Check if an export is a re-export (no declaration, just re-exporting from another module). */
const isReExport = (node) => node.type === 'ExportNamedDeclaration' && node.source !== null

/** Check if this is a type-only export (should be ignored). */
const isTypeOnlyExport = (node) => {
  if (node.type === 'ExportNamedDeclaration') {
    return node.exportKind === 'type'
  }
  return false
}

/** Get declared names from a declaration node. */
const getDeclaredNames = (node) => {
  const names = new Set()

  if (node.type === 'VariableDeclaration') {
    for (const decl of node.declarations) {
      if (decl.id.type === 'Identifier') {
        names.add(decl.id.name)
      } else if (decl.id.type === 'ObjectPattern') {
        // Handle destructuring: const { a, b } = ...
        for (const prop of decl.id.properties) {
          if (prop.type === 'Property' && prop.value.type === 'Identifier') {
            names.add(prop.value.name)
          } else if (prop.type === 'RestElement' && prop.argument.type === 'Identifier') {
            names.add(prop.argument.name)
          }
        }
      } else if (decl.id.type === 'ArrayPattern') {
        // Handle array destructuring: const [a, b] = ...
        for (const elem of decl.id.elements) {
          if (elem?.type === 'Identifier') {
            names.add(elem.name)
          }
        }
      }
    }
  } else if (
    node.type === 'FunctionDeclaration' ||
    node.type === 'ClassDeclaration' ||
    node.type === 'TSEnumDeclaration'
  ) {
    if (node.id?.name) {
      names.add(node.id.name)
    }
  }

  return names
}

/** Collect all identifier references in a node (recursively). */
const collectReferences = (node, refs = new Set()) => {
  if (!node || typeof node !== 'object') return refs

  if (node.type === 'Identifier') {
    refs.add(node.name)
    return refs
  }

  // Recursively traverse all properties
  for (const key of Object.keys(node)) {
    if (key === 'parent' || key === 'loc' || key === 'range') continue

    const value = node[key]
    if (Array.isArray(value)) {
      for (const item of value) {
        collectReferences(item, refs)
      }
    } else if (value && typeof value === 'object') {
      collectReferences(value, refs)
    }
  }

  return refs
}

/** Get the declaration part of an export node. */
const getExportDeclaration = (node) => {
  if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration') {
    return node.declaration
  }
  return null
}

const exportsFirstRule = {
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
  create(context) {
    return {
      Program(programNode) {
        /**
         * Fast-path:
         * - If there are no exports, nothing to report.
         * - If there are no trackable non-exports, nothing to report.
         * - If every export appears before the first trackable non-export, nothing to report.
         *
         * This avoids the heavier reference collection for the common "already ordered" case.
         */
        let hasExport = false
        let hasTrackableNonExport = false
        let exportAfterNonExport = false

        for (const node of programNode.body) {
          // Skip import statements
          if (node.type === 'ImportDeclaration') {
            continue
          }

          // Skip re-exports
          if (isReExport(node)) {
            continue
          }

          // Skip type-only exports
          if (isTypeOnlyExport(node)) {
            continue
          }

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

        // First pass: collect all non-exported declarations and their positions
        const nonExportedDecls = [] // { names: Set, node, index }
        const exports = [] // { node, index, refs: Set }

        for (let i = 0; i < programNode.body.length; i++) {
          const node = programNode.body[i]

          // Skip import statements
          if (node.type === 'ImportDeclaration') {
            continue
          }

          // Skip re-exports
          if (isReExport(node)) {
            continue
          }

          // Skip type-only exports
          if (isTypeOnlyExport(node)) {
            continue
          }

          if (isExportDeclaration(node)) {
            const decl = getExportDeclaration(node)
            const refs = decl ? collectReferences(decl) : new Set()
            exports.push({ node, index: i, refs })
          } else if (isTrackableDeclaration(node)) {
            const names = getDeclaredNames(node)
            nonExportedDecls.push({ names, node, index: i })
          }
        }

        // Collect all names referenced by ANY export
        const referencedByAnyExport = new Set()
        for (const exp of exports) {
          for (const ref of exp.refs) {
            referencedByAnyExport.add(ref)
          }
        }

        // Also include transitive references: if a non-export references another non-export
        // that is used by an export, the first non-export is also considered "needed"
        let changed = true
        while (changed) {
          changed = false
          for (const decl of nonExportedDecls) {
            // Check if this declaration is referenced by exports
            let isNeeded = false
            for (const name of decl.names) {
              if (referencedByAnyExport.has(name)) {
                isNeeded = true
                break
              }
            }

            // If this declaration is needed, add all its references to the needed set
            if (isNeeded) {
              // Get references from the declaration's initializer
              const declRefs = collectReferences(decl.node)
              for (const ref of declRefs) {
                if (!referencedByAnyExport.has(ref)) {
                  referencedByAnyExport.add(ref)
                  changed = true
                }
              }
            }
          }
        }

        // Second pass: for each export, check if there are non-exported declarations
        // before it that are NOT referenced by any export (directly or transitively)
        for (const exp of exports) {
          for (const decl of nonExportedDecls) {
            if (decl.index < exp.index) {
              // Check if any of the declared names are referenced
              let isReferenced = false
              for (const name of decl.names) {
                if (referencedByAnyExport.has(name)) {
                  isReferenced = true
                  break
                }
              }

              if (!isReferenced) {
                // Found a non-exported declaration before this export that isn't referenced
                context.report({
                  node: exp.node,
                  messageId: 'exportAfterNonExport',
                })
                break // Only report once per export
              }
            }
          }
        }
      },
    }
  },
}

const plugin = {
  meta: {
    name: 'overeng',
    version: '0.1.0',
  },
  rules: {
    'exports-first': exportsFirstRule,
  },
}

export default plugin
