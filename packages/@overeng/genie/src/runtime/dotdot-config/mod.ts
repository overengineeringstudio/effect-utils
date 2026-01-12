/**
 * Type-safe dotdot.json generator
 *
 * Generates member configuration files for dotdot multi-repo workspace management.
 * Reference: https://github.com/overengineeringstudio/dotdot
 */

import type { GenieOutput, Strict } from '../mod.ts'

/** Default JSON Schema URL for dotdot.json files */
export const DOTDOT_SCHEMA_URL =
  'https://raw.githubusercontent.com/overengineeringstudio/dotdot/main/schema/dotdot.schema.json'

/** Configuration for a package exposure (what this repo provides) */
export type PackageExposeConfig = {
  /** Path within the repo to the package */
  path: string
  /** Command to run after repo install (e.g., "pnpm build") */
  install?: string
}

/** Configuration for a dependency repo (what this repo depends on) */
export type DepConfig = {
  /** Git clone URL */
  url: string
  /** Pinned commit SHA */
  rev?: string
  /** Command to run after cloning (e.g., "bun install") */
  install?: string
}

/** Arguments for generating a dotdot.json member config file */
export type DotdotConfigArgs = {
  /** JSON Schema URL (defaults to DOTDOT_SCHEMA_URL, set to null to omit) */
  $schema?: string | null
  /** Packages this repo exposes to the workspace */
  exposes?: Record<string, PackageExposeConfig>
  /** Other repos this repo depends on */
  deps?: Record<string, DepConfig>
}

/**
 * Creates a dotdot.json member configuration.
 *
 * Returns a `GenieOutput` with the structured data accessible via `.data`
 * for composition with other genie files.
 *
 * @example
 * ```ts
 * export default dotdotConfig({
 *   exposes: {
 *     '@overeng/genie': { path: 'packages/@overeng/genie' },
 *   },
 *   deps: {
 *     effect: {
 *       url: 'git@github.com:effect-ts/effect.git',
 *       rev: 'abc123',
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
    ...(args.exposes && Object.keys(args.exposes).length > 0 && { exposes: args.exposes }),
    ...(args.deps && Object.keys(args.deps).length > 0 && { deps: args.deps }),
  }

  return {
    data: args,
    stringify: (_ctx) => JSON.stringify(output, null, 2) + '\n',
  }
}
