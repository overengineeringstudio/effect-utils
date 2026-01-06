/**
 * @overeng/oxc-config custom oxlint rules plugin.
 *
 * This plugin provides custom lint rules for the overeng monorepo:
 * - exports-first: Enforce exported declarations appear before non-exported declarations
 * - named-args: Enforce functions have at most one parameter (use options objects)
 *
 * TODO: Remove this custom plugin once upstream support lands.
 * See: https://github.com/oxc-project/oxc/issues/17706
 *
 * NOTE: WASM plugins may become available in the future for better performance.
 * See: https://github.com/oxc-project/oxc/discussions/10342
 */

import { exportsFirstRule } from './exports-first.ts'
import { namedArgsRule } from './named-args.ts'

const plugin = {
  meta: {
    name: 'overeng',
    version: '0.1.0',
  },
  rules: {
    'exports-first': exportsFirstRule,
    'named-args': namedArgsRule,
  },
}

export default plugin
