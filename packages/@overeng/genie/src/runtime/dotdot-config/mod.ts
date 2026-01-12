/**
 * Type-safe dotdot.json generator
 *
 * Generates configuration files for dotdot multi-repo workspace management.
 * Reference: https://github.com/overengineeringstudio/dotdot
 */

import type { GenieOutput, Strict } from '../mod.ts'

/** Default JSON Schema URL for dotdot.json files */
export const DOTDOT_SCHEMA_URL =
  'https://raw.githubusercontent.com/overengineeringstudio/dotdot/main/schema/dotdot.schema.json'

/** Configuration for a package within a repo */
export type DotdotPackageConfig = {
  /** Path within the repo to the package */
  path: string
  /** Command to run after repo install (e.g., "pnpm build") */
  install?: string
}

/** Configuration for a single repo */
export type DotdotRepoConfig = {
  /** Git clone URL */
  url: string
  /** Pinned commit SHA */
  rev?: string
  /** Command to run after cloning (e.g., "bun install") */
  install?: string
  /** Packages to expose as symlinks at workspace root */
  packages?: Record<string, DotdotPackageConfig>
}

/** Arguments for generating a dotdot.json file */
export type DotdotConfigArgs = {
  /** JSON Schema URL (defaults to DOTDOT_SCHEMA_URL, set to null to omit) */
  $schema?: string | null
  /** Declared repositories */
  repos: Record<string, DotdotRepoConfig>
}

/**
 * Creates a dotdot.json configuration.
 *
 * Returns a `GenieOutput` with the structured data accessible via `.data`
 * for composition with other genie files.
 *
 * @example
 * ```ts
 * export default dotdotConfig({
 *   repos: {
 *     'effect-utils': {
 *       url: 'git@github.com:overengineeringstudio/effect-utils.git',
 *       rev: 'abc123',
 *       packages: {
 *         '@overeng/genie': { path: 'packages/@overeng/genie' },
 *       },
 *     },
 *   },
 * })
 * ```
 */
export const dotdotConfig = <const T extends DotdotConfigArgs>(
  args: Strict<T, DotdotConfigArgs>,
): GenieOutput<T> => {
  const schemaUrl = args.$schema === null ? undefined : (args.$schema ?? DOTDOT_SCHEMA_URL)

  const output = {
    ...(schemaUrl !== undefined && { $schema: schemaUrl }),
    repos: args.repos,
  }

  return {
    data: args,
    stringify: (_ctx) => JSON.stringify(output, null, 2) + '\n',
  }
}
