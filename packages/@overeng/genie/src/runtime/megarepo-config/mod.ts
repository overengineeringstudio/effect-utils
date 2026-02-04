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

/**
 * VSCode workspace generator configuration
 *
 * Design: Typed shortcuts + settings escape hatch
 *
 * Tradeoffs:
 * - `color`: Convenient typed shorthand for the common "branded workspace" pattern.
 *   Auto-generates titleBar, activityBar, and statusBar colors with sensible foregrounds.
 * - `settings`: Raw passthrough for any VSCode workspace settings. No type-safety,
 *   but provides an escape hatch for edge cases and new VSCode features we haven't typed yet.
 */
export type VscodeGeneratorConfig = {
  /** Enable/disable the generator (default: false) */
  enabled?: boolean
  /** Members to exclude from workspace */
  exclude?: string[]
  /**
   * Primary accent color for the workspace (hex format, e.g. "#372d8e").
   * Auto-generates titleBar, activityBar, and statusBar background colors
   * with white foreground for contrast.
   *
   * Note: Prefer using `colorEnvVar` to keep megarepo.json stable across worktrees.
   */
  color?: string
  /**
   * Environment variable name to read the workspace color from at generation time.
   * This allows per-worktree colors without changing megarepo.json.
   *
   * Example: Set `colorEnvVar: "MEGAREPO_COLOR"` in config, then in .envrc.local:
   *   export MEGAREPO_COLOR="#372d8e"
   *
   * Takes precedence over the `color` field if both are set.
   */
  colorEnvVar?: string
  /**
   * Raw VSCode workspace settings passthrough.
   * Merged with (and overrides) auto-generated settings.
   * Use this for any settings not covered by typed shortcuts above.
   *
   * @example { "editor.formatOnSave": true }
   */
  settings?: Record<string, unknown>
}

/** All generator configurations */
export type GeneratorsConfig = {
  vscode?: VscodeGeneratorConfig
}

// =============================================================================
// Lock Sync Configuration
// =============================================================================

/**
 * Configuration for syncing flake.lock and devenv.lock files
 *
 * When enabled, megarepo will update the `rev` fields in member repos'
 * flake.lock and devenv.lock files to match the commits in megarepo.lock.
 * This keeps all lock files in sync with megarepo as the source of truth.
 *
 * Lock sync is **auto-detected** by default: if `devenv.lock` or `flake.lock`
 * exists in the megarepo root, syncing is enabled automatically.
 * Set `enabled: false` to opt-out.
 */
export type LockSyncConfig = {
  /**
   * Enable/disable lock sync.
   * Default: auto-detected (enabled if devenv.lock or flake.lock exists in megarepo root)
   * Set to false to opt-out of automatic lock file synchronization
   */
  enabled?: boolean
  /**
   * Members to exclude from lock sync
   * These members' lock files will not be modified
   */
  exclude?: string[]
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
  /**
   * Lock sync configuration for flake.lock and devenv.lock files.
   * Auto-detected by default: enabled if devenv.lock or flake.lock exists in megarepo root.
   */
  lockSync?: LockSyncConfig
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
  args: MegarepoConfigArgs & Strict<T, MegarepoConfigArgs>,
): GenieOutput<T> => {
  return {
    data: args as T,
    stringify: (_ctx) => JSON.stringify(args, null, 2) + '\n',
  }
}
