/**
 * Megarepo Store Service
 *
 * Manages the global repository cache at ~/.megarepo (or $MEGAREPO_STORE).
 * The store is organized by git host:
 *
 * ```
 * ~/.megarepo/
 * ├── github.com/
 * │   ├── owner/repo/
 * │   └── another/repo/
 * └── local/
 *     └── repo-name/
 * ```
 */

import { FileSystem, type Error as PlatformError } from '@effect/platform'
import { Context, Effect, Layer, Option } from 'effect'

import { EffectPath, type AbsoluteDirPath, type RelativeDirPath } from '@overeng/effect-path'

import { DEFAULT_STORE_PATH, ENV_VARS, getStorePath, type MemberSource } from './config.ts'

// =============================================================================
// Store Service
// =============================================================================

/** Store configuration */
export interface StoreConfig {
  readonly basePath: AbsoluteDirPath
}

/** Store service interface */
export interface MegarepoStore {
  /** Get the full path to a repo in the store */
  readonly getRepoPath: (source: MemberSource) => AbsoluteDirPath

  /** Check if a repo exists in the store */
  readonly hasRepo: (
    source: MemberSource,
  ) => Effect.Effect<boolean, PlatformError.PlatformError, FileSystem.FileSystem>

  /** List all repos in the store */
  readonly listRepos: () => Effect.Effect<
    ReadonlyArray<{ readonly relativePath: RelativeDirPath; readonly fullPath: AbsoluteDirPath }>,
    PlatformError.PlatformError,
    FileSystem.FileSystem
  >

  /** Get the store base path */
  readonly basePath: AbsoluteDirPath
}

/** Store service tag */
export class Store extends Context.Tag('megarepo/Store')<Store, MegarepoStore>() {}

// =============================================================================
// Store Implementation
// =============================================================================

const make = (config: StoreConfig): MegarepoStore => {
  const basePath = config.basePath

  return {
    basePath,

    getRepoPath: (source) => {
      const relativePath = getStorePath(source)
      return EffectPath.ops.join(basePath, relativePath)
    },

    hasRepo: (source) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const relativePath = getStorePath(source)
        const fullPath = EffectPath.ops.join(basePath, relativePath)
        return yield* fs.exists(fullPath)
      }),

    listRepos: () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem

        const exists = yield* fs.exists(basePath)
        if (!exists) {
          return []
        }

        const result: Array<{ relativePath: RelativeDirPath; fullPath: AbsoluteDirPath }> = []

        // Walk the store directory (2 levels deep for host/owner/repo structure)
        const hosts = yield* fs.readDirectory(basePath)
        for (const host of hosts) {
          const hostPath = EffectPath.ops.join(basePath, EffectPath.unsafe.relativeDir(`${host}/`))
          const hostStat = yield* fs.stat(hostPath)
          if (hostStat.type !== 'Directory') continue

          const owners = yield* fs.readDirectory(hostPath)
          for (const owner of owners) {
            const ownerPath = EffectPath.ops.join(
              hostPath,
              EffectPath.unsafe.relativeDir(`${owner}/`),
            )
            const ownerStat = yield* fs.stat(ownerPath)
            if (ownerStat.type !== 'Directory') continue

            const repos = yield* fs.readDirectory(ownerPath)
            for (const repo of repos) {
              const repoPath = EffectPath.ops.join(
                ownerPath,
                EffectPath.unsafe.relativeDir(`${repo}/`),
              )
              const repoStat = yield* fs.stat(repoPath)
              if (repoStat.type !== 'Directory') continue

              result.push({
                relativePath: EffectPath.unsafe.relativeDir(`${host}/${owner}/${repo}/`),
                fullPath: repoPath,
              })
            }
          }
        }

        return result
      }),
  }
}

// =============================================================================
// Store Layer
// =============================================================================

/**
 * Expand ~ to home directory and ensure trailing slash for directory path
 */
const expandStorePath = (path: string): AbsoluteDirPath => {
  const expanded = path.replace(/^~/, process.env.HOME ?? '~')
  const withTrailingSlash = expanded.endsWith('/') ? expanded : `${expanded}/`
  return EffectPath.unsafe.absoluteDir(withTrailingSlash)
}

/**
 * Create a Store layer with explicit configuration
 */
export const makeStoreLayer = (config: StoreConfig) => Layer.succeed(Store, make(config))

/**
 * Create a Store layer from environment (MEGAREPO_STORE) or default
 */
export const StoreLayer = Layer.effect(
  Store,
  Effect.gen(function* () {
    const storePathRaw = Option.fromNullable(process.env[ENV_VARS.STORE]).pipe(
      Option.getOrElse(() => DEFAULT_STORE_PATH),
    )
    const basePath = expandStorePath(storePathRaw)
    return make({ basePath })
  }),
)
