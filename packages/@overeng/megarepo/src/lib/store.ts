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
import { classifyRef, refTypeToPathSegment, type RefType } from './ref.ts'
import { makeStoreLockLayer, StoreLock } from './store-lock.ts'

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

  /** List all worktrees for a repo (includes broken worktrees with missing .git) */
  readonly listWorktrees: (source: MemberSource) => Effect.Effect<
    ReadonlyArray<{
      readonly ref: string
      readonly refType: RefType
      readonly path: AbsoluteDirPath
      readonly broken: boolean
    }>,
    PlatformError.PlatformError
  >

  // === Legacy compatibility (deprecated) ===

  /** @deprecated Use getRepoBasePath instead */
  readonly getRepoPath: (source: MemberSource) => AbsoluteDirPath

  /** @deprecated Use hasBareRepo instead */
  readonly hasRepo: (source: MemberSource) => Effect.Effect<boolean, PlatformError.PlatformError>
}

/** Store service tag */
export class Store extends Context.Tag('megarepo/Store')<Store, MegarepoStore>() {}

// =============================================================================
// Store Implementation
// =============================================================================

const make = ({
  config,
  fs,
}: {
  config: StoreConfig
  fs: FileSystem.FileSystem
}): MegarepoStore => {
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
    return EffectPath.ops.join(
      repoBase,
      EffectPath.unsafe.relativeDir(`refs/${pathSegment}/${ref}/`),
    )
  }

  const collectNestedWorktrees = ({
    refTypePath,
    currentPath,
    refType,
  }: {
    refTypePath: AbsoluteDirPath
    currentPath: AbsoluteDirPath
    refType: RefType
  }): Effect.Effect<
    Array<{
      ref: string
      refType: RefType
      path: AbsoluteDirPath
      broken: boolean
    }>,
    PlatformError.PlatformError
  > =>
    Effect.gen(function* () {
      const gitPath = EffectPath.ops.join(currentPath, EffectPath.unsafe.relativeFile('.git'))
      const isWorktree = yield* fs.exists(gitPath)
      if (isWorktree === true) {
        const ref = currentPath.slice(refTypePath.length).replace(/\/$/, '')
        return [{ ref, refType, path: currentPath, broken: false }]
      }

      const entries = yield* fs.readDirectory(currentPath)
      const nestedResults: Array<{
        ref: string
        refType: RefType
        path: AbsoluteDirPath
        broken: boolean
      }> = []

      for (const entry of entries) {
        if (entry.startsWith('.') === true) continue

        const entryPath = EffectPath.ops.join(
          currentPath,
          EffectPath.unsafe.relativeDir(`${entry}/`),
        )
        const entryStat = yield* fs
          .stat(entryPath)
          .pipe(Effect.catchAll(() => Effect.succeed(null)))
        if (entryStat?.type !== 'Directory') continue

        nestedResults.push(
          ...(yield* collectNestedWorktrees({
            refTypePath,
            currentPath: entryPath,
            refType,
          })),
        )
      }

      /** If no worktrees found and this isn't the refType root, it's a broken worktree */
      if (nestedResults.length === 0 && currentPath !== refTypePath) {
        const ref = currentPath.slice(refTypePath.length).replace(/\/$/, '')
        return [{ ref, refType, path: currentPath, broken: true }]
      }

      return nestedResults
    })

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
        if (exists === false) {
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
          if (host.startsWith('.') === true) continue

          const hostPath = EffectPath.ops.join(basePath, EffectPath.unsafe.relativeDir(`${host}/`))
          const hostStat = yield* fs
            .stat(hostPath)
            .pipe(Effect.catchAll(() => Effect.succeed(null)))
          if (hostStat?.type !== 'Directory') continue

          const owners = yield* fs.readDirectory(hostPath)
          for (const owner of owners) {
            // Skip hidden files/directories
            if (owner.startsWith('.') === true) continue

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
              if (repo.startsWith('.') === true) continue

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
              if (hasBare === false) continue

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
        if (exists === false) {
          return []
        }

        const result: Array<{
          ref: string
          refType: RefType
          path: AbsoluteDirPath
          broken: boolean
        }> = []

        // Walk refs/{heads,tags,commits}/** and treat any directory with a .git file as a worktree.
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

          result.push(
            ...(yield* collectNestedWorktrees({
              refTypePath,
              currentPath: refTypePath,
              refType,
            })),
          )
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
  const withTrailingSlash = expanded.endsWith('/') === true ? expanded : `${expanded}/`
  return EffectPath.unsafe.absoluteDir(withTrailingSlash)
}

/**
 * Create a Store + StoreLock layer with explicit configuration.
 * StoreLock uses file-system backing at {basePath}.locks/.
 */
export const makeStoreLayer = (config: StoreConfig) =>
  Layer.merge(
    Layer.effect(
      Store,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        return make({ config, fs })
      }),
    ),
    makeStoreLockLayer(config.basePath),
  )

/**
 * Store + StoreLock layer from environment (MEGAREPO_STORE) or default path.
 * Reads the env var lazily at provision time so tests can override it.
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
).pipe((storeOnly) => {
  /* Derive basePath at provision time for the lock layer.
   * We read the env var again (same as storeOnly) so both use the same path. */
  const lockLayer = Layer.effect(
    StoreLock,
    Effect.gen(function* () {
      const store = yield* Store
      return yield* Layer.build(makeStoreLockLayer(store.basePath)).pipe(
        Effect.map((ctx) => ctx.pipe(Context.get(StoreLock))),
      )
    }),
  )
  return Layer.provideMerge(lockLayer, storeOnly)
})
