/**
 * Shared oxfmt configuration base.
 *
 * Provides common formatting options that can be extended by repo-specific configs.
 */

import type { OxfmtConfigArgs } from '../packages/@overeng/genie/src/runtime/mod.ts'

/** Standard formatting options shared across all repos */
export const baseOxfmtOptions = {
  semi: false,
  singleQuote: true,
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  trailingComma: 'all',
  experimentalSortImports: {
    groups: ['builtin', 'external', 'internal', ['parent', 'sibling', 'index']],
    internalPattern: ['@overeng/', '@local/'],
    newlinesBetween: true,
  },
  experimentalSortPackageJson: true,
} as const satisfies Omit<OxfmtConfigArgs, 'ignorePatterns'>

/** Standard ignore patterns for generated files */
export const baseOxfmtIgnorePatterns = [
  '**/*.gen.ts',
  '**/*.gen.tsx',
  '**/*.generated.ts',
  '**/*.generated.tsx',
] as const
