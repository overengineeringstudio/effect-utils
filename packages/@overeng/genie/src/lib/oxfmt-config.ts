/**
 * Oxfmt configuration generator.
 *
 * Generates `.jsonc` configuration files for oxfmt (Oxc formatter).
 *
 * @see https://oxc.rs/docs/guide/usage/formatter
 * @see https://oxc.rs/docs/guide/usage/formatter/migrate-from-prettier
 */

/** Import sorting group types */
type ImportGroup = 'builtin' | 'external' | 'internal' | 'parent' | 'sibling' | 'index'

/** Import sorting configuration */
export type ImportSortConfig = {
  /** Import group ordering. Arrays create merged groups. */
  groups?: (ImportGroup | ImportGroup[])[]
  /** Patterns to treat as internal imports (e.g., ['@myorg/']) */
  internalPattern?: string[]
  /** Insert newlines between import groups */
  newlinesBetween?: boolean
}

/** Arguments for generating an oxfmt configuration file */
export type OxfmtConfigArgs = {
  /** Print semicolons at the end of statements (default: true) */
  semi?: boolean
  /** Use single quotes instead of double quotes (default: false) */
  singleQuote?: boolean
  /** Specify the line length for wrapping (default: 100 in oxfmt, 80 in prettier) */
  printWidth?: number
  /** Specify the number of spaces per indentation level (default: 2) */
  tabWidth?: number
  /** Indent lines with tabs instead of spaces (default: false) */
  useTabs?: boolean
  /** Print trailing commas wherever possible (default: 'all') */
  trailingComma?: 'all' | 'es5' | 'none'
  /** Print spaces between brackets in object literals (default: true) */
  bracketSpacing?: boolean
  /** Include parentheses around a sole arrow function parameter (default: 'always') */
  arrowParens?: 'always' | 'avoid'
  /** End of line character (default: 'lf') */
  endOfLine?: 'lf' | 'crlf' | 'cr' | 'auto'
  /** Experimental import sorting configuration */
  experimentalSortImports?: ImportSortConfig
  /** Experimental package.json sorting (default: false) */
  experimentalSortPackageJson?: boolean
  /** Glob patterns to ignore */
  ignorePatterns?: string[]
}

/** Options for customizing oxfmt config generation (reserved for future use) */
export type OxfmtConfigOptions = Record<string, never>

/**
 * Generate an oxfmt configuration file (.jsonc).
 *
 * @see https://oxc.rs/docs/guide/usage/formatter
 *
 * @example
 * ```ts
 * export default oxfmtConfig({
 *   semi: false,
 *   singleQuote: true,
 *   printWidth: 100,
 *   tabWidth: 2,
 *   experimentalSortImports: {
 *     groups: ['builtin', 'external', 'internal', ['parent', 'sibling', 'index']],
 *     internalPattern: ['@myorg/'],
 *     newlinesBetween: true,
 *   },
 *   experimentalSortPackageJson: true,
 * })
 * ```
 */
// oxlint-disable-next-line overeng/jsdoc-require-exports, overeng/named-args -- JSDoc above; DSL-style API
export const oxfmtConfig = (args: OxfmtConfigArgs, _options?: OxfmtConfigOptions): string => {
  const config: Record<string, unknown> = {
    $schema:
      'https://raw.githubusercontent.com/nicksrandall/oxfmt/refs/heads/main/configuration_schema.json',
  }

  if (args.semi !== undefined) {
    config.semi = args.semi
  }

  if (args.singleQuote !== undefined) {
    config.singleQuote = args.singleQuote
  }

  if (args.printWidth !== undefined) {
    config.printWidth = args.printWidth
  }

  if (args.tabWidth !== undefined) {
    config.tabWidth = args.tabWidth
  }

  if (args.useTabs !== undefined) {
    config.useTabs = args.useTabs
  }

  if (args.trailingComma !== undefined) {
    config.trailingComma = args.trailingComma
  }

  if (args.bracketSpacing !== undefined) {
    config.bracketSpacing = args.bracketSpacing
  }

  if (args.arrowParens !== undefined) {
    config.arrowParens = args.arrowParens
  }

  if (args.endOfLine !== undefined) {
    config.endOfLine = args.endOfLine
  }

  if (args.experimentalSortImports !== undefined) {
    config.experimentalSortImports = args.experimentalSortImports
  }

  if (args.experimentalSortPackageJson !== undefined) {
    config.experimentalSortPackageJson = args.experimentalSortPackageJson
  }

  if (args.ignorePatterns !== undefined) {
    config.ignorePatterns = args.ignorePatterns
  }

  return JSON.stringify(config, null, 2) + '\n'
}
