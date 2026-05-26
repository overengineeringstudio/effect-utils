import {
  baseOxlintCategories,
  baseOxlintIgnorePatterns,
  baseOxlintOverrides,
  baseOxlintPlugins,
  baseOxlintRules,
} from './genie/oxlint-base.ts'
import { oxlintConfig, type OxlintConfigArgs } from './packages/@overeng/genie/src/runtime/mod.ts'

/** Path to custom oxlint rules plugin */
const OXC_PLUGIN_PATH = './packages/@overeng/oxc-config/src/mod.ts'

export default oxlintConfig({
  plugins: baseOxlintPlugins,
  jsPlugins: [OXC_PLUGIN_PATH],
  categories: baseOxlintCategories,
  rules: baseOxlintRules,
  ignorePatterns: baseOxlintIgnorePatterns,
  overrides: [
    ...baseOxlintOverrides,
    // Genie runtime must be dependency-free (issue #138)
    {
      files: ['**/genie/src/runtime/**'],
      rules: { 'overeng/no-external-imports': 'error' },
    },
    {
      files: ['**/genie/src/runtime/**/*.test.ts'],
      rules: { 'overeng/no-external-imports': 'off' },
    },
    // effect-utils specific: react-inspector is a fork with its own style
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
    // notion-react: incubation lint waiver (tracked in #599; remove before GA)
    {
      files: ['**/notion-react/**'],
      rules: {
        'overeng/jsdoc-require-exports': 'off',
        'overeng/explicit-boolean-compare': 'off',
        'overeng/named-args': 'off',
        'overeng/exports-first': 'off',
        'overeng/storybook/csf-component': 'off',
        'no-await-in-loop': 'off',
      },
    },
    // KDL parser uses control chars in regexes (KDL spec whitespace/newline matching),
    // generator functions (can't be arrow), and has a structural document<->node cycle
    // KDL packages: ported from @bgotink/kdl — relaxed rules for the port
    {
      files: ['**/kdl/src/**', '**/kdl-effect/src/**'],
      rules: {
        'no-control-regex': 'off',
        'func-style': 'off',
        'import/no-cycle': 'off',
        'overeng/jsdoc-require-exports': 'off',
        'overeng/explicit-boolean-compare': 'off',
        'overeng/exports-first': 'off',
        'overeng/named-args': 'off',
      },
    },
  ],
} satisfies OxlintConfigArgs)
