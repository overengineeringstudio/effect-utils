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

import { FileSystem, Path, type Error as PlatformError } from '@effect/platform'
import { Context, Effect, Layer, Option } from 'effect'
import { DEFAULT_STORE_PATH, ENV_VARS, getStorePath, type MemberSource } from './config.ts'

// =============================================================================
// Store Service
// =============================================================================

/** Store configuration */
export interface StoreConfig {
  readonly basePath: string
}

/** Store service interface */
export interface MegarepoStore {
  /** Get the full path to a repo in the store */
  readonly getRepoPath: (source: MemberSource) => Effect.Effect<string, never, Path.Path>

  /** Check if a repo exists in the store */
  readonly hasRepo: (
    source: MemberSource,
  ) => Effect.Effect<boolean, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path>

  /** List all repos in the store */
  readonly listRepos: () => Effect.Effect<
    ReadonlyArray<{ readonly relativePath: string; readonly fullPath: string }>,
    PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path
  >

  /** Get the store base path */
  readonly basePath: string
}

/** Store service tag */
export class Store extends Context.Tag('megarepo/Store')<Store, MegarepoStore>() {}

// =============================================================================
// Store Implementation
// =============================================================================

const make = (config: StoreConfig): MegarepoStore => {
  const basePath = config.basePath.replace(/^~/, process.env.HOME ?? '~')

  return {
    basePath,

    getRepoPath: (source) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const relativePath = getStorePath(source)
        return path.join(basePath, relativePath)
      }),

    hasRepo: (source) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const relativePath = getStorePath(source)
        const fullPath = path.join(basePath, relativePath)
        return yield* fs.exists(fullPath)
      }),

    listRepos: () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path

        const exists = yield* fs.exists(basePath)
        if (!exists) {
          return []
        }

        const result: Array<{ relativePath: string; fullPath: string }> = []

        // Walk the store directory (2 levels deep for host/owner/repo structure)
        const hosts = yield* fs.readDirectory(basePath)
        for (const host of hosts) {
          const hostPath = path.join(basePath, host)
          const hostStat = yield* fs.stat(hostPath)
          if (hostStat.type !== 'Directory') continue

          const owners = yield* fs.readDirectory(hostPath)
          for (const owner of owners) {
            const ownerPath = path.join(hostPath, owner)
            const ownerStat = yield* fs.stat(ownerPath)
            if (ownerStat.type !== 'Directory') continue

            const repos = yield* fs.readDirectory(ownerPath)
            for (const repo of repos) {
              const repoPath = path.join(ownerPath, repo)
              const repoStat = yield* fs.stat(repoPath)
              if (repoStat.type !== 'Directory') continue

              result.push({
                relativePath: `${host}/${owner}/${repo}`,
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
 * Create a Store layer with explicit configuration
 */
export const makeStoreLayer = (config: StoreConfig) => Layer.succeed(Store, make(config))

/**
 * Create a Store layer from environment (MEGAREPO_STORE) or default
 */
export const StoreLayer = Layer.effect(
  Store,
  Effect.gen(function* () {
    const storePath = Option.fromNullable(process.env[ENV_VARS.STORE]).pipe(
      Option.getOrElse(() => DEFAULT_STORE_PATH),
    )
    return make({ basePath: storePath })
  }),
)
