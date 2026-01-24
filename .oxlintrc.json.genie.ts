import {
  baseOxlintCategories,
  baseOxlintOverrides,
  baseOxlintPlugins,
  baseOxlintRules,
} from './genie/oxlint-base.ts'
import { oxlintConfig } from './packages/@overeng/genie/src/runtime/mod.ts'

/** Path to custom oxlint rules plugin */
const OXC_PLUGIN_PATH = './packages/@overeng/oxc-config/src/mod.ts'

export default oxlintConfig({
  plugins: baseOxlintPlugins,
  jsPlugins: [OXC_PLUGIN_PATH],
  categories: baseOxlintCategories,
  rules: baseOxlintRules,
  overrides: [
    ...baseOxlintOverrides,
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
  ],
})
