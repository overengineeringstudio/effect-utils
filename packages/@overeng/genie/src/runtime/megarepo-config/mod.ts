/**
 * Type-safe megarepo.json generator
 *
 * Generates megarepo configuration files with proper typing for members and generators.
 *
 * @example
 * ```ts
 * // megarepo.json.genie.ts
 * import { megarepoJson } from '@overeng/genie/runtime'
 *
 * export default megarepoJson({
 *   members: {
 *     effect: 'effect-ts/effect',
 *     'effect-next': 'effect-ts/effect#next',
 *   },
 *   generators: {
 *     vscode: { enabled: true },
 *   },
 * })
 * ```
 */

import type { GenieOutput, Strict } from '../mod.ts'

// =============================================================================
// Generator Configuration Types
// =============================================================================

/** VSCode workspace generator configuration */
export type VscodeGeneratorConfig = {
  /** Enable/disable the generator (default: false) */
  enabled?: boolean
  /** Members to exclude from workspace */
  exclude?: string[]
}

/** Nix generator configuration */
export type NixGeneratorConfig = {
  /** Enable/disable the generator (default: false) */
  enabled?: boolean
  /** Workspace directory (relative to megarepo root) */
  workspaceDir?: string
}

/** All generator configurations */
export type GeneratorsConfig = {
  nix?: NixGeneratorConfig
  vscode?: VscodeGeneratorConfig
}

// =============================================================================
// Member Source Types
// =============================================================================

/**
 * Member source string format.
 *
 * Supported formats:
 * - GitHub shorthand: "owner/repo" or "owner/repo#ref"
 * - HTTPS URL: "https://github.com/owner/repo" or "https://github.com/owner/repo#ref"
 * - SSH URL: "git@github.com:owner/repo" or "git@github.com:owner/repo#ref"
 * - Local path: "./path", "../path", "/absolute/path"
 */
export type MemberSource = string

// =============================================================================
// Main Configuration Type
// =============================================================================

/** Arguments for generating a megarepo.json file */
export type MegarepoConfigArgs = {
  /** JSON Schema reference (optional, for editor support) */
  $schema?: string
  /** Members: repos to include in this megarepo (name -> source string) */
  members: Record<string, MemberSource>
  /** Generators: optional config file generation */
  generators?: GeneratorsConfig
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Creates a megarepo.json configuration.
 *
 * Returns a `GenieOutput` with the structured data accessible via `.data`
 * for composition with other genie files.
 *
 * @example
 * ```ts
 * // Basic usage
 * export default megarepoJson({
 *   members: {
 *     effect: 'effect-ts/effect',
 *     'effect-next': 'effect-ts/effect#next',
 *   },
 * })
 *
 * // With generators
 * export default megarepoJson({
 *   members: {
 *     effect: 'effect-ts/effect',
 *     'my-lib': '../my-lib',
 *   },
 *   generators: {
 *     nix: { enabled: true },
 *     vscode: { enabled: true, exclude: ['large-repo'] },
 *   },
 * })
 *
 * // Programmatic member generation
 * const repos = ['effect', 'schema', 'platform'] as const
 * export default megarepoJson({
 *   members: Object.fromEntries(
 *     repos.map((name) => [name, `effect-ts/${name}`])
 *   ),
 * })
 * ```
 */
export const megarepoJson = <const T extends MegarepoConfigArgs>(
  args: Strict<T, MegarepoConfigArgs>,
): GenieOutput<T> => {
  return {
    data: args,
    stringify: (_ctx) => JSON.stringify(args, null, 2) + '\n',
  }
}
