/**
 * @overeng/oxc-config custom oxlint rules plugin.
 *
 * This plugin provides custom lint rules for the overeng monorepo:
 * - exports-first: Enforce exported declarations appear before non-exported declarations
 * - named-args: Enforce functions have at most one parameter (use options objects)
 * - jsdoc-require-exports: Require JSDoc comments on type/wildcard exports
 *
 * It also re-exports selected rules from eslint-plugin-storybook under the
 * `overeng/storybook/*` namespace for enforcing Storybook best practices.
 *
 * TODO: Remove this custom plugin once upstream support lands.
 * See: https://github.com/oxc-project/oxc/issues/17706
 *
 * NOTE: WASM plugins may become available in the future for better performance.
 * See: https://github.com/oxc-project/oxc/discussions/10342
 */

import storybookPlugin from 'eslint-plugin-storybook'

import { exportsFirstRule } from './exports-first.ts'
import { jsdocRequireExportsRule } from './jsdoc-require-exports.ts'
import { namedArgsRule } from './named-args.ts'

const storybookRules = storybookPlugin.rules

type Rules = {
  'exports-first': typeof exportsFirstRule
  'jsdoc-require-exports': typeof jsdocRequireExportsRule
  'named-args': typeof namedArgsRule
  'storybook/meta-satisfies-type': (typeof storybookRules)['meta-satisfies-type']
  'storybook/default-exports': (typeof storybookRules)['default-exports']
  'storybook/story-exports': (typeof storybookRules)['story-exports']
  'storybook/csf-component': (typeof storybookRules)['csf-component']
  'storybook/hierarchy-separator': (typeof storybookRules)['hierarchy-separator']
  'storybook/no-redundant-story-name': (typeof storybookRules)['no-redundant-story-name']
  'storybook/prefer-pascal-case': (typeof storybookRules)['prefer-pascal-case']
}

const rules: Rules = {
  // Custom overeng rules
  'exports-first': exportsFirstRule,
  'jsdoc-require-exports': jsdocRequireExportsRule,
  'named-args': namedArgsRule,

  // Re-exported storybook rules (use as overeng/storybook/*)
  'storybook/meta-satisfies-type': storybookRules['meta-satisfies-type'],
  'storybook/default-exports': storybookRules['default-exports'],
  'storybook/story-exports': storybookRules['story-exports'],
  'storybook/csf-component': storybookRules['csf-component'],
  'storybook/hierarchy-separator': storybookRules['hierarchy-separator'],
  'storybook/no-redundant-story-name': storybookRules['no-redundant-story-name'],
  'storybook/prefer-pascal-case': storybookRules['prefer-pascal-case'],
}

type Plugin = {
  readonly meta: {
    readonly name: string
    readonly version: string
  }
  readonly rules: Rules
}

const plugin: Plugin = {
  meta: {
    name: 'overeng',
    version: '0.1.0',
  },
  rules,
}

export default plugin
