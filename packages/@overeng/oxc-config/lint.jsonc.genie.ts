import { oxlintConfig } from '../genie/src/runtime/mod.ts'

export default oxlintConfig({
  plugins: ['import', 'typescript', 'unicorn', 'oxc'],
  jsPlugins: ['./src/mod.ts'],
  categories: {
    correctness: 'error',
    suspicious: 'warn',
    pedantic: 'off',
    perf: 'warn',
    style: 'off',
    restriction: 'off',
  },
  rules: {
    // Disallow dynamic import() and require() - helps with static analysis and bundling
    // https://oxc.rs/docs/guide/usage/linter/rules/import/no-dynamic-require
    'import/no-dynamic-require': ['warn', { esmodule: true }],

    // Disallow re-exports except in mod.ts entry points
    // https://oxc.rs/docs/guide/usage/linter/rules/oxc/no-barrel-file
    'oxc/no-barrel-file': ['warn', { threshold: 0 }],

    // Enforce named arguments (options objects) instead of positional parameters
    'overeng/named-args': 'warn',

    // Disallow CommonJS (require/module.exports) - enforce ESM
    'import/no-commonjs': 'error',

    // Detect circular dependencies
    'import/no-cycle': 'warn',

    // Prefer function expressions over declarations
    // https://oxc.rs/docs/guide/usage/linter/rules/eslint/func-style
    'func-style': ['warn', 'expression', { allowArrowFunctions: true }],

    // Enforce exported declarations come before non-exported declarations (custom plugin)
    'overeng/exports-first': 'warn',

    // Require JSDoc comments on type/wildcard exports (custom plugin)
    'overeng/jsdoc-require-exports': 'warn',
  },
  overrides: [
    // Allow re-exports in mod.ts entry point files
    {
      files: ['**/mod.ts'],
      rules: {
        'oxc/no-barrel-file': 'off',
      },
    },
    // react-inspector is a fork with its own style
    {
      files: ['**/react-inspector/**'],
      rules: {
        'func-style': 'off',
        'overeng/named-args': 'off',
        'unicorn/no-new-array': 'off',
        'unicorn/no-array-sort': 'off',
        'unicorn/consistent-function-scoping': 'off',
        'import/no-named-as-default': 'off',
        'overeng/exports-first': 'off',
        'overeng/jsdoc-require-exports': 'off',
      },
    },
    // Storybook files have a specific pattern (meta before stories)
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
      rules: {
        'overeng/jsdoc-require-exports': 'off',
      },
    },
    // Allow CSS side-effect imports in storybook previews
    {
      files: ['**/.storybook/**'],
      rules: {
        'import/no-unassigned-import': 'off',
      },
    },
    // Test files have more relaxed rules
    {
      files: [
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/*.spec.ts',
        '**/*.spec.tsx',
        '**/*.spec.jsx',
        '**/test/**',
      ],
      rules: {
        'overeng/named-args': 'off',
        'unicorn/no-array-sort': 'off',
        'unicorn/consistent-function-scoping': 'off',
        // Effect tests often use Effect.gen without yields for consistency
        'require-yield': 'off',
      },
    },
    // Generated files should not be linted for style/structure rules
    {
      files: ['**/*.gen.*', '**/.contentlayer/**', '**/next-env.d.ts'],
      rules: {
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
      },
    },
  ],
})
