/**
 * Oxlint configuration generator.
 *
 * Generates `.jsonc` configuration files for oxlint.
 *
 * @see https://oxc.rs/docs/guide/usage/linter/configuration
 * @see https://raw.githubusercontent.com/oxc-project/oxc/main/npm/oxlint/configuration_schema.json
 */

import type { GenieOutput, Strict } from '../mod.ts'

/** Rule severity levels */
type RuleSeverity = 'off' | 'warn' | 'error' | 'allow' | 'deny' | 0 | 1 | 2

/** Rule configuration - either severity alone or [severity, options] */
type RuleConfig = RuleSeverity | [RuleSeverity, Record<string, unknown>]

/** Built-in oxlint plugins */
type OxlintPlugin =
  | 'eslint'
  | 'react'
  | 'unicorn'
  | 'typescript'
  | 'oxc'
  | 'import'
  | 'jsdoc'
  | 'jest'
  | 'vitest'
  | 'jsx-a11y'
  | 'nextjs'
  | 'react-perf'
  | 'promise'
  | 'node'
  | 'vue'

/** Rule category severity levels */
type CategorySeverity = 'off' | 'warn' | 'error'

/** Rule categories for bulk configuration */
type RuleCategories = {
  correctness?: CategorySeverity
  suspicious?: CategorySeverity
  pedantic?: CategorySeverity
  perf?: CategorySeverity
  style?: CategorySeverity
  restriction?: CategorySeverity
  nursery?: CategorySeverity
}

/** File-specific rule overrides */
export type OxlintOverride = {
  files: string[]
  rules?: Record<string, RuleConfig>
  plugins?: OxlintPlugin[]
  settings?: Record<string, unknown>
}

/** Arguments for generating an oxlint configuration file */
export type OxlintConfigArgs = {
  /** Built-in plugins to enable */
  plugins?: OxlintPlugin[]
  /** Custom JS plugin paths (experimental) */
  jsPlugins?: string[]
  /** Rule category severity levels */
  categories?: RuleCategories
  /** Individual rule configurations */
  rules?: Record<string, RuleConfig>
  /** File-specific overrides */
  overrides?: OxlintOverride[]
  /** Environment globals */
  env?: Record<string, boolean>
  /** Custom global variables */
  globals?: Record<string, 'readonly' | 'writable' | 'off'>
  /** Paths to extend from */
  extends?: string[]
  /** Glob patterns to ignore */
  ignorePatterns?: string[]
  /** Plugin-specific settings */
  settings?: {
    react?: Record<string, unknown>
    typescript?: Record<string, unknown>
    'jsx-a11y'?: Record<string, unknown>
    next?: Record<string, unknown>
    jsdoc?: Record<string, unknown>
    vitest?: Record<string, unknown>
  }
}

/**
 * Creates an oxlint configuration file (.jsonc).
 *
 * Returns a `GenieOutput` with the structured data accessible via `.data`
 * for composition with other genie files.
 */
export const oxlintConfig = <const T extends OxlintConfigArgs>(
  args: Strict<T, OxlintConfigArgs>,
): GenieOutput<T> => {
  const buildConfig = (): Record<string, unknown> => {
    const config: Record<string, unknown> = {
      $schema:
        'https://raw.githubusercontent.com/oxc-project/oxc/main/npm/oxlint/configuration_schema.json',
    }

    if (args.plugins !== undefined) config.plugins = args.plugins
    if (args.jsPlugins !== undefined) config.jsPlugins = args.jsPlugins
    if (args.env !== undefined) config.env = args.env
    if (args.globals !== undefined) config.globals = args.globals
    if (args.extends !== undefined) config.extends = args.extends
    if (args.ignorePatterns !== undefined) config.ignorePatterns = args.ignorePatterns
    if (args.settings !== undefined) config.settings = args.settings
    if (args.categories !== undefined) config.categories = args.categories
    if (args.rules !== undefined) config.rules = args.rules
    if (args.overrides !== undefined) config.overrides = args.overrides

    return config
  }

  return {
    data: args,
    stringify: (_ctx) => JSON.stringify(buildConfig(), null, 2) + '\n',
  }
}
