/**
 * Shared oxlint configuration base.
 *
 * Provides common rules, categories, and overrides that can be extended by repo-specific configs.
 */

import type { OxlintConfigArgs, OxlintOverride } from '../packages/@overeng/genie/src/runtime/mod.ts'

/** Standard plugins enabled across all repos */
export const baseOxlintPlugins = ['import', 'typescript', 'unicorn', 'oxc'] as const

/** Standard category severity levels */
export const baseOxlintCategories = {
  correctness: 'error',
  suspicious: 'warn',
  pedantic: 'off',
  perf: 'warn',
  style: 'off',
  restriction: 'off',
} as const satisfies OxlintConfigArgs['categories']

/** Standard rules shared across all repos */
export const baseOxlintRules = {
  // Disallow dynamic import() and require() - helps with static analysis and bundling
  'import/no-dynamic-require': ['warn', { esmodule: true }],

  // Disallow re-exports except in mod.ts entry points
  'oxc/no-barrel-file': ['warn', { threshold: 0 }],

  // Enforce named arguments (options objects) instead of positional parameters
  'overeng/named-args': 'warn',

  // Disallow CommonJS (require/module.exports) - enforce ESM
  'import/no-commonjs': 'error',

  // Detect circular dependencies
  'import/no-cycle': 'warn',

  // Prefer function expressions over declarations
  'func-style': ['warn', 'expression', { allowArrowFunctions: true }],

  // Enforce exported declarations come before non-exported declarations
  'overeng/exports-first': 'warn',

  // Require JSDoc comments on type/wildcard exports
  'overeng/jsdoc-require-exports': 'warn',

  // Enforce proper type imports
  'typescript/consistent-type-imports': 'warn',

  // Don't enforce type vs interface
  'typescript/consistent-type-definitions': 'off',

  // Disallow usage of deprecated APIs
  'typescript/no-deprecated': 'error',
} as const satisfies OxlintConfigArgs['rules']

/** Rules to disable for generated files */
export const generatedFilesRules = {
  'func-style': 'off',
  'import/no-commonjs': 'off',
  'import/no-named-as-default': 'off',
  'import/no-unassigned-import': 'off',
  'oxc/no-barrel-file': 'off',
  'oxc/no-map-spread': 'off',
  'overeng/exports-first': 'off',
  'overeng/jsdoc-require-exports': 'off',
  'overeng/named-args': 'off',
  'unicorn/consistent-function-scoping': 'off',
} as const satisfies OxlintOverride['rules']

/** Standard overrides shared across all repos */
export const baseOxlintOverrides = [
  // Allow re-exports in mod.ts entry point files
  {
    files: ['**/mod.ts'],
    rules: { 'oxc/no-barrel-file': 'off' },
  },
  // Storybook files have a specific pattern
  {
    files: ['**/*.stories.tsx', '**/*.stories.ts', '**/*.stories.jsx', '**/.storybook/**'],
    rules: {
      'overeng/exports-first': 'off',
      'overeng/jsdoc-require-exports': 'off',
    },
  },
  // Config files don't need JSDoc
  {
    files: ['**/vitest.config.ts', '**/vite.config.ts', '**/playwright.config.ts'],
    rules: { 'overeng/jsdoc-require-exports': 'off' },
  },
  // Allow CSS side-effect imports in storybook previews
  {
    files: ['**/.storybook/**'],
    rules: { 'import/no-unassigned-import': 'off' },
  },
  // Test files have more relaxed rules
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx', '**/test/**'],
    rules: {
      'overeng/named-args': 'off',
      'unicorn/no-array-sort': 'off',
      'unicorn/consistent-function-scoping': 'off',
      'require-yield': 'off',
    },
  },
  // Declaration files can use inline import() type annotations
  {
    files: ['**/*.d.ts'],
    rules: { 'typescript/consistent-type-imports': 'off' },
  },
  // Generated files (*.gen.*)
  {
    files: ['**/*.gen.*'],
    rules: generatedFilesRules,
  },
] as const satisfies OxlintConfigArgs['overrides']
