/**
 * Megarepo Store Service
 *
 * Manages the global repository cache at ~/.megarepo (or $MEGAREPO_STORE).
 * The store uses bare repos with worktrees per ref:
 *
 * ```
 * ~/.megarepo/
 * └── github.com/
 *     └── owner/
 *         └── repo/
 *             ├── .bare/                    # bare repository
 *             └── refs/
 *                 ├── heads/
 *                 │   └── main/             # worktree for 'main' branch
 *                 ├── tags/
 *                 │   └── v1.0.0/           # worktree for tag
 *                 └── commits/
 *                     └── abc123.../        # worktree for commit
 * ```
 */

import { FileSystem, type Error as PlatformError } from '@effect/platform'
import { Context, Effect, Layer, Option } from 'effect'

import { EffectPath, type AbsoluteDirPath, type RelativeDirPath } from '@overeng/effect-path'

import { DEFAULT_STORE_PATH, ENV_VARS, getStorePath, type MemberSource } from './config.ts'
import { classifyRef, encodeRef, refTypeToPathSegment, type RefType } from './ref.ts'

// =============================================================================
// Store Service
// =============================================================================

/** Store configuration */
export interface StoreConfig {
  readonly basePath: AbsoluteDirPath
}

/** Store service interface */
export interface MegarepoStore {
  /** Get the store base path */
  readonly basePath: AbsoluteDirPath

  /** Get the base path for a repo in the store (without .bare or refs) */
  readonly getRepoBasePath: (source: MemberSource) => AbsoluteDirPath

  /** Get the path to the bare repo (.bare directory) */
  readonly getBareRepoPath: (source: MemberSource) => AbsoluteDirPath

  /** Get the path to a specific worktree for a ref.
   * If refType is not provided, uses heuristic-based classification.
   * For accurate classification, provide the refType from remote/local query.
   */
  readonly getWorktreePath: (args: {
    source: MemberSource
    ref: string
    refType?: RefType
  }) => AbsoluteDirPath

  /** Check if a bare repo exists in the store */
  readonly hasBareRepo: (
    source: MemberSource,
  ) => Effect.Effect<boolean, PlatformError.PlatformError>

  /** Check if a worktree exists for a specific ref.
   * If refType is not provided, uses heuristic-based classification.
   */
  readonly hasWorktree: (args: {
    source: MemberSource
    ref: string
    refType?: RefType
  }) => Effect.Effect<boolean, PlatformError.PlatformError>

  /** List all repos in the store */
  readonly listRepos: () => Effect.Effect<
    ReadonlyArray<{
      readonly relativePath: RelativeDirPath
      readonly fullPath: AbsoluteDirPath
    }>,
    PlatformError.PlatformError
  >

  /** List all worktrees for a repo */
  readonly listWorktrees: (source: MemberSource) => Effect.Effect<
    ReadonlyArray<{
      readonly ref: string
      readonly refType: RefType
      readonly path: AbsoluteDirPath
    }>,
    PlatformError.PlatformError
  >

  // === Legacy compatibility (deprecated) ===

  /** @deprecated Use getRepoBasePath instead */
  readonly getRepoPath: (source: MemberSource) => AbsoluteDirPath

  /** @deprecated Use hasBareRepo instead */
  readonly hasRepo: (
    source: MemberSource,
  ) => Effect.Effect<boolean, PlatformError.PlatformError>
}

/** Store service tag */
export class Store extends Context.Tag('megarepo/Store')<Store, MegarepoStore>() {}

// =============================================================================
// Store Implementation
// =============================================================================

const make = ({ config, fs }: { config: StoreConfig; fs: FileSystem.FileSystem }): MegarepoStore => {
  const basePath = config.basePath

  const getRepoBasePath = (source: MemberSource): AbsoluteDirPath => {
    const relativePath = getStorePath(source)
    return EffectPath.ops.join(basePath, relativePath)
  }

  const getBareRepoPath = (source: MemberSource): AbsoluteDirPath => {
    const repoBase = getRepoBasePath(source)
    return EffectPath.ops.join(repoBase, EffectPath.unsafe.relativeDir('.bare/'))
  }

  const getWorktreePath = ({
    source,
    ref,
    refType,
  }: {
    source: MemberSource
    ref: string
    refType?: RefType
  }): AbsoluteDirPath => {
    const repoBase = getRepoBasePath(source)
    // Use provided refType or fall back to heuristic classification
    const effectiveRefType = refType ?? classifyRef(ref)
    const pathSegment = refTypeToPathSegment(effectiveRefType)
    const encodedRef = encodeRef(ref)
    return EffectPath.ops.join(
      repoBase,
      EffectPath.unsafe.relativeDir(`refs/${pathSegment}/${encodedRef}/`),
    )
  }

  return {
    basePath,
    getRepoBasePath,
    getBareRepoPath,
    getWorktreePath,

    // Legacy compatibility
    getRepoPath: getRepoBasePath,

    hasBareRepo: (source) => fs.exists(getBareRepoPath(source)),

    hasWorktree: (args) => fs.exists(getWorktreePath(args)),

    // Legacy compatibility
    hasRepo: (source) => fs.exists(getBareRepoPath(source)),

    listRepos: () =>
      Effect.gen(function* () {
        const exists = yield* fs.exists(basePath)
        if (!exists) {
          return []
        }

        const result: Array<{
          relativePath: RelativeDirPath
          fullPath: AbsoluteDirPath
        }> = []

        // Walk the store directory (2 levels deep for host/owner/repo structure)
        const hosts = yield* fs.readDirectory(basePath)
        for (const host of hosts) {
          // Skip hidden files/directories (like .DS_Store)
          if (host.startsWith('.')) continue

          const hostPath = EffectPath.ops.join(basePath, EffectPath.unsafe.relativeDir(`${host}/`))
          const hostStat = yield* fs
            .stat(hostPath)
            .pipe(Effect.catchAll(() => Effect.succeed(null)))
          if (hostStat?.type !== 'Directory') continue

          const owners = yield* fs.readDirectory(hostPath)
          for (const owner of owners) {
            // Skip hidden files/directories
            if (owner.startsWith('.')) continue

            const ownerPath = EffectPath.ops.join(
              hostPath,
              EffectPath.unsafe.relativeDir(`${owner}/`),
            )
            const ownerStat = yield* fs
              .stat(ownerPath)
              .pipe(Effect.catchAll(() => Effect.succeed(null)))
            if (ownerStat?.type !== 'Directory') continue

            const repos = yield* fs.readDirectory(ownerPath)
            for (const repo of repos) {
              // Skip hidden files/directories
              if (repo.startsWith('.')) continue

              const repoPath = EffectPath.ops.join(
                ownerPath,
                EffectPath.unsafe.relativeDir(`${repo}/`),
              )
              const repoStat = yield* fs
                .stat(repoPath)
                .pipe(Effect.catchAll(() => Effect.succeed(null)))
              if (repoStat?.type !== 'Directory') continue

              // Only include repos that have a .bare directory
              const barePath = EffectPath.ops.join(
                repoPath,
                EffectPath.unsafe.relativeDir('.bare/'),
              )
              const hasBare = yield* fs.exists(barePath)
              if (!hasBare) continue

              result.push({
                relativePath: EffectPath.unsafe.relativeDir(`${host}/${owner}/${repo}/`),
                fullPath: repoPath,
              })
            }
          }
        }

        return result
      }),

    listWorktrees: (source) =>
      Effect.gen(function* () {
        const repoBase = getRepoBasePath(source)
        const refsDir = EffectPath.ops.join(repoBase, EffectPath.unsafe.relativeDir('refs/'))

        const exists = yield* fs.exists(refsDir)
        if (!exists) {
          return []
        }

        const result: Array<{
          ref: string
          refType: RefType
          path: AbsoluteDirPath
        }> = []

        // Walk refs/{heads,tags,commits}/{encoded-ref}/
        const refTypes = yield* fs.readDirectory(refsDir)
        for (const refTypeDir of refTypes) {
          const refType = pathSegmentToRefType(refTypeDir)
          if (refType === undefined) continue

          const refTypePath = EffectPath.ops.join(
            refsDir,
            EffectPath.unsafe.relativeDir(`${refTypeDir}/`),
          )
          const refTypeStat = yield* fs.stat(refTypePath)
          if (refTypeStat.type !== 'Directory') continue

          const encodedRefs = yield* fs.readDirectory(refTypePath)
          for (const encodedRef of encodedRefs) {
            const worktreePath = EffectPath.ops.join(
              refTypePath,
              EffectPath.unsafe.relativeDir(`${encodedRef}/`),
            )
            const worktreeStat = yield* fs.stat(worktreePath)
            if (worktreeStat.type !== 'Directory') continue

            // Decode the ref name
            const ref = decodeURIComponent(encodedRef)

            result.push({
              ref,
              refType,
              path: worktreePath,
            })
          }
        }

        return result
      }),
  }
}

/**
 * Map path segment back to ref type
 */
const pathSegmentToRefType = (segment: string): RefType | undefined => {
  switch (segment) {
    case 'heads':
      return 'branch'
    case 'tags':
      return 'tag'
    case 'commits':
      return 'commit'
    default:
      return undefined
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
export const makeStoreLayer = (config: StoreConfig) =>
  Layer.effect(
    Store,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      return make({ config, fs })
    }),
  )

/**
 * Create a Store layer from environment (MEGAREPO_STORE) or default
 */
export const StoreLayer = Layer.effect(
  Store,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const storePathRaw = Option.fromNullable(process.env[ENV_VARS.STORE]).pipe(
      Option.getOrElse(() => DEFAULT_STORE_PATH),
    )
    const basePath = expandStorePath(storePathRaw)
    return make({ config: { basePath }, fs })
  }),
)
