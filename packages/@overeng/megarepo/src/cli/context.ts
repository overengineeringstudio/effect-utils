/**
 * CLI Context and shared utilities
 *
 * Services and helpers used across all CLI commands.
 */

import { resolve } from 'node:path'

import * as Cli from '@effect/cli'
import { FileSystem } from '@effect/platform'
import { Context, Effect, Layer, Option } from 'effect'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import { CONFIG_FILE_NAME } from '../lib/config.ts'
import { InvalidCwdError } from './errors.ts'

// =============================================================================
// CLI Context Services
// =============================================================================

/**
 * Current working directory service.
 *
 * Uses $PWD environment variable when available to preserve the logical path
 * through symlinks. This is important for megarepo because members are symlinked
 * from the workspace into the store - when running commands from inside a member,
 * we need to find the workspace's megarepo.json, not walk up from the store path.
 *
 * - $PWD: logical path (preserves symlinks) - set by the shell
 * - process.cwd(): physical path (resolves symlinks)
 */
export class Cwd extends Context.Tag('megarepo/Cwd')<Cwd, AbsoluteDirPath>() {
  static live = Layer.effect(
    Cwd,
    Effect.sync(() => {
      // Prefer $PWD (logical path) over process.cwd() (physical path)
      // to support running commands from inside symlinked members
      const pwd = process.env.PWD
      const cwd = pwd !== undefined && pwd.length > 0 ? pwd : process.cwd()
      return EffectPath.unsafe.absoluteDir(cwd.endsWith('/') === true ? cwd : `${cwd}/`)
    }),
  )

  /** Create a Cwd layer from a specific path, validating it exists and is a directory */
  static fromPath = (path: string) =>
    Layer.effect(
      Cwd,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem

        // Use $PWD (logical path) as base for relative path resolution,
        // consistent with Cwd.live's symlink-aware behavior
        const base = process.env.PWD?.length !== undefined && process.env.PWD?.length > 0 ? process.env.PWD : process.cwd()
        const resolved = resolve(base, path)
        const resolvedDir = resolved.endsWith('/') === true ? resolved : `${resolved}/`

        // Validate the path exists
        const exists = yield* fs.exists(resolvedDir)
        if (exists === false) {
          return yield* new InvalidCwdError({
            path: resolvedDir,
            message: `--cwd directory does not exist: ${resolvedDir}`,
          })
        }

        // Validate it's a directory
        const info = yield* fs.stat(resolvedDir)
        if (info.type !== 'Directory') {
          return yield* new InvalidCwdError({
            path: resolvedDir,
            message: `--cwd path is not a directory: ${resolvedDir}`,
          })
        }

        return EffectPath.unsafe.absoluteDir(resolvedDir)
      }),
    )
}

// =============================================================================
// Common Options
// =============================================================================

/** Override the working directory */
export const cwdOption = Cli.Options.text('cwd').pipe(
  Cli.Options.withDescription('Override the working directory'),
  Cli.Options.optional,
)

/** JSON output format option */
export const jsonOption = Cli.Options.boolean('json').pipe(
  Cli.Options.withDescription('Output in JSON format'),
  Cli.Options.withDefault(false),
)

/** Stream JSON output as NDJSON (newline-delimited JSON) */
export const streamOption = Cli.Options.boolean('stream').pipe(
  Cli.Options.withDescription('Stream JSON output as NDJSON (requires --json)'),
  Cli.Options.withDefault(false),
)

/** Verbose output option */
export const verboseOption = Cli.Options.boolean('verbose').pipe(
  Cli.Options.withAlias('v'),
  Cli.Options.withDescription('Show detailed output'),
  Cli.Options.withDefault(false),
)

// =============================================================================
// TUI Output Mode (re-exports from tui-react)
// =============================================================================

export {
  outputOption,
  outputModeLayer,
  type OutputModeValue,
  resolveOutputMode,
} from '@overeng/tui-react/node'

// =============================================================================
// Filesystem Helpers
// =============================================================================

/**
 * Create a symlink, stripping trailing slashes from paths.
 * POSIX symlink fails with ENOENT if the link path ends with `/`.
 */
export const createSymlink = ({ target, link }: { target: string; link: string }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.symlink(target.replace(/\/$/, ''), link.replace(/\/$/, ''))
  })

// =============================================================================
// Megarepo Root Discovery
// =============================================================================

/**
 * Find megarepo root by searching up from current directory.
 * Returns the OUTERMOST megarepo found (closest to filesystem root).
 * This ensures "outer wins" behavior for nested megarepos.
 */
export const findMegarepoRoot = (startPath: AbsoluteDirPath) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    let current: AbsoluteDirPath | undefined = startPath
    const rootDir = EffectPath.unsafe.absoluteDir('/')
    let outermost: AbsoluteDirPath | undefined = undefined

    // Walk up the tree, collecting the outermost megarepo found
    while (current !== undefined && current !== rootDir) {
      const configPath = EffectPath.ops.join(
        current,
        EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
      )
      const exists = yield* fs.exists(configPath)
      if (exists === true) {
        outermost = current // Keep going up, this might not be the outermost
      }
      current = EffectPath.ops.parent(current)
    }

    // Check root as well
    const rootConfigPath = EffectPath.ops.join(
      rootDir,
      EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
    )
    const rootExists = yield* fs.exists(rootConfigPath)
    if (rootExists === true) {
      outermost = rootDir
    }

    return Option.fromNullable(outermost)
  })

/**
 * Find the nearest megarepo root by searching up from current directory.
 * Returns the closest megarepo found (nearest to start path).
 */
export const findNearestMegarepoRoot = (startPath: AbsoluteDirPath) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    let current: AbsoluteDirPath | undefined = startPath
    const rootDir = EffectPath.unsafe.absoluteDir('/')

    while (current !== undefined && current !== rootDir) {
      const configPath = EffectPath.ops.join(
        current,
        EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
      )
      const exists = yield* fs.exists(configPath)
      if (exists === true) {
        return Option.some(current)
      }
      current = EffectPath.ops.parent(current)
    }

    const rootConfigPath = EffectPath.ops.join(
      rootDir,
      EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
    )
    const rootExists = yield* fs.exists(rootConfigPath)
    return rootExists === true ? Option.some(rootDir) : Option.none()
  })
