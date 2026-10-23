/**
 * `@stylexjs` oxlint JS-plugin entry point.
 *
 * A second `jsPlugins` entry alongside `./mod.ts`, exposing the upstream
 * `@stylexjs/eslint-plugin` rules under their documented `@stylexjs/*` names.
 * The upstream plugin loads through oxlint's JS-plugin seam and its rules fire —
 * verified against the real binary — so we adopt its general style validation
 * rather than reimplementing it.
 *
 * Why this file exists rather than naming the package directly in `jsPlugins`:
 * upstream ships no `meta.name`, so oxlint would derive the namespace from the
 * bare specifier `@stylexjs/eslint-plugin`, and a bare specifier only resolves
 * from the *root* `node_modules`. This repo's root `package.json` is a pure
 * workspace aggregate and cannot carry a dependency, so the plugin is a runtime
 * dependency of this package: consumer worktrees load this shim through their
 * StyleX `jsPlugins` entry and need its upstream import installed. This module
 * supplies the namespace explicitly, and `jsPlugins` references a path inside
 * the workspace, exactly like `./mod.ts` does.
 *
 * Which rules are enabled, and the two measured configuration constraints, live
 * in `genie/oxlint-base.ts` (`stylexOxlintRules`).
 *
 * See stylex spec "Enforcement" and decision 0005 Amendment 2.
 */

import { rules } from '@stylexjs/eslint-plugin'

/** The upstream StyleX rules, namespaced `@stylexjs` for oxlint. */
const plugin = {
  meta: {
    name: '@stylexjs',
    version: '0.19.0',
  },
  rules,
}

export default plugin
