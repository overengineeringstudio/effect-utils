/**
 * Shared oxlint configuration base.
 *
 * Provides common rules, categories, and overrides that can be extended by repo-specific configs.
 */

import type {
  OxlintConfigArgs,
  OxlintOverride,
} from '../packages/@overeng/genie/src/runtime/mod.ts'

/** Standard ignore patterns for oxlint across all repos */
export const baseOxlintIgnorePatterns = [
  '**/node_modules/**',
  '**/.pnpm/**',
  '**/.pnpm-store/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/.wrangler/**',
  '**/.vercel/**',
  '**/.netlify/**',
  '**/.astro/**',
  '**/.nitro/**',
  '**/.tanstack/**',
  '**/.direnv/**',
  '**/tmp/**',
  '**/playwright-report/**',
  '**/test-results/**',
  '**/nix/**',
  '**/wip/**',
  '**/.vite/**',
  '**/patches/**',
  '**/.cache/**',
  '**/.turbo/**',
] as const

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

  // Disallow usage of deprecated APIs (requires --type-aware)
  'typescript/no-deprecated': 'error',

  // =============================================================================
  // Type-aware rules - temporarily disabled
  // These rules require --type-aware mode. Re-enable incrementally after cleanup.
  // =============================================================================

  // TODO: Re-enable - warns about unsafe type assertions (325 occurrences)
  'typescript/no-unsafe-type-assertion': 'off',

  // TODO: Re-enable - detects unnecessary type arguments (54 occurrences)
  'typescript/no-unnecessary-type-arguments': 'off',

  // TODO: Re-enable - detects unnecessary type assertions (48 occurrences)
  'typescript/no-unnecessary-type-assertion': 'off',

  // TODO: Re-enable - detects unnecessary boolean literal comparisons (46 occurrences)
  'typescript/no-unnecessary-boolean-literal-compare': 'off',

  // TODO: Re-enable - detects misused spread operators (18 occurrences)
  'typescript/no-misused-spread': 'off',

  // TODO: Re-enable - detects redundant type constituents (12 occurrences)
  'typescript/no-redundant-type-constituents': 'off',

  // TODO: Re-enable - detects floating promises (9 occurrences)
  'typescript/no-floating-promises': 'off',

  // TODO: Re-enable - detects improper toString usage (6 occurrences)
  'typescript/no-base-to-string': 'off',

  // TODO: Re-enable - detects unsafe enum comparisons (5 occurrences)
  'typescript/no-unsafe-enum-comparison': 'off',

  // TODO: Re-enable - detects unbound methods (4 occurrences)
  'typescript/unbound-method': 'off',

  // TODO: Re-enable - restricts template expression types (3 occurrences)
  'typescript/restrict-template-expressions': 'off',

  // TODO: Re-enable - detects duplicate type constituents (3 occurrences)
  'typescript/no-duplicate-type-constituents': 'off',

  // TODO: Re-enable - detects unsafe unary minus (1 occurrence)
  'typescript/no-unsafe-unary-minus': 'off',

  // TODO: Re-enable - detects unnecessary template expressions (1 occurrence)
  'typescript/no-unnecessary-template-expression': 'off',
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
  // Storybook story files (*.stories.*)
  {
    files: ['**/*.stories.tsx', '**/*.stories.ts', '**/*.stories.jsx'],
    rules: {
      // Relaxed rules for story files
      'overeng/exports-first': 'off',
      'overeng/jsdoc-require-exports': 'off',
      // Storybook best practices (re-exported from eslint-plugin-storybook)
      'overeng/storybook/meta-satisfies-type': 'error',
      'overeng/storybook/default-exports': 'error',
      'overeng/storybook/story-exports': 'warn',
      'overeng/storybook/csf-component': 'warn',
      'overeng/storybook/hierarchy-separator': 'warn',
      'overeng/storybook/no-redundant-story-name': 'warn',
      'overeng/storybook/prefer-pascal-case': 'warn',
    },
  },
  // Storybook config files (.storybook/*) - not story files
  {
    files: ['**/.storybook/**'],
    rules: {
      'overeng/exports-first': 'off',
      'overeng/jsdoc-require-exports': 'off',
      'import/no-unassigned-import': 'off',
    },
  },
  // Config files don't need JSDoc
  {
    files: ['**/vitest.config.ts', '**/vite.config.ts', '**/playwright.config.ts'],
    rules: { 'overeng/jsdoc-require-exports': 'off' },
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
