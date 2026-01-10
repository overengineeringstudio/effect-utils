/**
 * @overeng/oxc-config custom oxlint rules plugin.
 *
 * This plugin provides custom lint rules for the overeng monorepo:
 * - exports-first: Enforce exported declarations appear before non-exported declarations
 * - named-args: Enforce functions have at most one parameter (use options objects)
 * - jsdoc-require-exports: Require JSDoc comments on type/wildcard exports
 *
 * TODO: Remove this custom plugin once upstream support lands.
 * See: https://github.com/oxc-project/oxc/issues/17706
 *
 * NOTE: WASM plugins may become available in the future for better performance.
 * See: https://github.com/oxc-project/oxc/discussions/10342
 */

import { exportsFirstRule } from './exports-first.ts'
import { jsdocRequireExportsRule } from './jsdoc-require-exports.ts'
import { namedArgsRule } from './named-args.ts'

type Plugin = {
  readonly meta: {
    readonly name: string
    readonly version: string
  }
  readonly rules: {
    readonly 'exports-first': typeof exportsFirstRule
    readonly 'jsdoc-require-exports': typeof jsdocRequireExportsRule
    readonly 'named-args': typeof namedArgsRule
  }
}

const plugin: Plugin = {
  meta: {
    name: 'overeng',
    version: '0.1.0',
  },
  rules: {
    'exports-first': exportsFirstRule,
    'jsdoc-require-exports': jsdocRequireExportsRule,
    'named-args': namedArgsRule,
  },
}

export default plugin
