/**
 * no-external-imports oxlint rule.
 *
 * Disallow value imports from npm packages (non-relative, non-builtin specifiers).
 * Type-only imports (`import type`) are allowed since they're erased at compile time.
 *
 * Use this rule via overrides to enforce dependency-free modules, e.g. genie runtime
 * modules that are imported as TypeScript source by consumers via megarepo symlinks.
 *
 * @example
 * // ✅ Good - relative imports
 * import { foo } from './foo.ts'
 * import { bar } from '../bar/mod.ts'
 *
 * // ✅ Good - Node.js builtins
 * import { readFile } from 'node:fs'
 * import path from 'node:path'
 *
 * // ✅ Good - type-only imports (erased at compile time)
 * import type { Effect } from 'effect'
 * import type { FileSystem } from '@effect/platform'
 *
 * // ❌ Bad - value imports from npm packages
 * import { Effect } from 'effect'
 * import { FileSystem } from '@effect/platform'
 *
 * See: https://github.com/overengineeringstudio/effect-utils/issues/138
 */

const isExternalSpecifier = (source: string): boolean =>
  !source.startsWith('.') && !source.startsWith('node:')

/** ESLint rule disallowing value imports from npm packages */
export const noExternalImportsRule = {
  meta: {
    type: 'problem' as const,
    docs: {
      description: 'Disallow value imports from npm packages (type-only imports are allowed)',
      recommended: false,
    },
    messages: {
      noExternalImport:
        'Value import from "{{source}}" is not allowed. This module must be dependency-free. Use `import type` for type-only imports, or move the code to a module that allows dependencies.',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context: any) {
    return {
      ImportDeclaration(node: any) {
        // Allow type-only imports: import type { X } from 'y'
        if (node.importKind === 'type') return

        const source = node.source?.value
        if (typeof source !== 'string') return

        if (isExternalSpecifier(source)) {
          context.report({
            node,
            messageId: 'noExternalImport',
            data: { source },
          })
        }
      },
    }
  },
}
