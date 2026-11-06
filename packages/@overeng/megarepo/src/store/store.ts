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

import { Context, Effect, Layer, Option } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { type PlatformError } from 'effect/PlatformError'

import { EffectPath, type AbsoluteDirPath, type RelativeDirPath } from '@overeng/effect-path'

import {
  DEFAULT_STORE_PATH,
  ENV_VARS,
  getStorePath,
  RESERVED_STORE_TOOL_ROOTS,
  type MemberSource,
} from '../core/config.ts'
import * as Observability from '../core/observability.ts'
import { classifyRef, refTypeToPathSegment, type RefType } from '../core/ref.ts'
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
  readonly hasBareRepo: (source: MemberSource) => Effect.Effect<boolean, PlatformError>

  /** Check if a worktree exists for a specific ref.
   * If refType is not provided, uses heuristic-based classification.
   */
  readonly hasWorktree: (args: {
    source: MemberSource
    ref: string
    refType?: RefType
  }) => Effect.Effect<boolean, PlatformError>

  /** List all repos in the store */
  readonly listRepos: Effect.Effect<
    ReadonlyArray<{
      readonly relativePath: RelativeDirPath
      readonly fullPath: AbsoluteDirPath
    }>,
    PlatformError
  >

  /** List all worktrees for a repo (includes broken worktrees with missing .git) */
  readonly listWorktrees: (source: MemberSource) => Effect.Effect<
    ReadonlyArray<{
      readonly ref: string
      readonly refType: RefType
      readonly path: AbsoluteDirPath
      readonly broken: boolean
    }>,
    PlatformError
  >
}

/** Store service tag */
export class Store extends Context.Service<Store, MegarepoStore>()('megarepo/Store') {}

// =============================================================================
// Store Implementation
// =============================================================================

/** Stat the entry itself before using a directory-shaped path (which ends in `/`).
 * Keep FileSystem.stat's existing symlink semantics; never mutate foreign entries.
 */
export const isStoreDirectory = ({ fs, path }: { fs: FileSystem.FileSystem; path: string }) =>
  fs.stat(path.replace(/\/+$/, '')).pipe(Effect.map((stat) => stat.type === 'Directory'))

/** One diagnostic per walk; samples never grow with the number of entries. */
export const withStoreEnumeration =
  (name: string) =>
  <A, E, R>(
    run: (
      telemetry: StoreEnumerationTelemetry,
    ) => Generator<Effect.Effect<unknown, E, R>, A, never>,
  ) =>
    Effect.suspend(() => {
      const counts = { nonDirectory: 0, foreignNamespace: 0, depthLimited: 0 }
      const samples: Record<keyof typeof counts, Array<string>> = {
        nonDirectory: [],
        foreignNamespace: [],
        depthLimited: [],
      }
      const record = ({ kind, path }: { kind: keyof typeof counts; path: string }) => {
        counts[kind]++
        if (samples[kind].length < 10) samples[kind].push(path)
      }
      const telemetry: StoreEnumerationTelemetry = {
        isDirectory: (args) =>
          isStoreDirectory(args).pipe(
            Effect.map((directory) => {
              if (directory === false)
                record({ kind: 'nonDirectory', path: args.path.replace(/\/+$/, '') })
              return directory
            }),
          ),
        foreignNamespace: (path) => record({ kind: 'foreignNamespace', path }),
        depthLimited: (path) => record({ kind: 'depthLimited', path }),
      }
      const report = Effect.gen(function* () {
        const attributes = {
          'megarepo.store.enumeration.non_directory.count': counts.nonDirectory,
          'megarepo.store.enumeration.non_directory.samples': samples.nonDirectory,
          'megarepo.store.enumeration.foreign_namespace.count': counts.foreignNamespace,
          'megarepo.store.enumeration.foreign_namespace.samples': samples.foreignNamespace,
          'megarepo.store.enumeration.depth_limited.count': counts.depthLimited,
          'megarepo.store.enumeration.depth_limited.samples': samples.depthLimited,
        }
        yield* Observability.annotateStoreEnumeration(attributes)
        if (Object.values(counts).some((count) => count > 0) === true) {
          yield* Effect.logWarning(
            `store enumeration: skipped entries (non-directory=${counts.nonDirectory}, foreign-namespace=${counts.foreignNamespace}, depth-limited=${counts.depthLimited})`,
          ).pipe(Effect.annotateLogs(attributes))
        }
      })
      return Effect.gen(() => run(telemetry)).pipe(
        Effect.onExit(() => report),
        Observability.withLabelSpan({ name, labelValue: name.slice(name.lastIndexOf('/') + 1) }),
      )
    })

/** Mutable diagnostics owned by exactly one enumeration run. */
export interface StoreEnumerationTelemetry {
  readonly isDirectory: typeof isStoreDirectory
  readonly foreignNamespace: (path: string) => void
  readonly depthLimited: (path: string) => void
}

const shouldSkipStoreRootEntry = (entry: string): boolean =>
  // The store root holds member namespaces (`<host>/<owner>/<repo>/`) AND
  // non-member co-tenant dirs. This is the PRIMARY membership boundary that
  // separates them, not a temporary backstop:
  //   - Dot-dirs are store-internal (`.state`, `.locks`, …).
  //   - `_`-prefixed dirs are co-tenant scratch namespaces — e.g. `_iso/`, where
  //     external tooling continuously checks out isolated worktrees that share
  //     the store root. They are NOT members of this store, so the walk must
  //     never enumerate them (and never descend into their working trees). No
  //     real host or owner segment starts with `_`, so this never excludes a
  //     legitimate member.
  //   - `tmp` is a conventional scratch dir.
  // The `_`-prefix convention is a stable contract for co-tenants, owned here; a
  // co-tenant writer that emits `_`-prefixed roots is well-behaved by design.
  entry.startsWith('.') === true ||
  entry.startsWith('_') === true ||
  entry === 'tmp' ||
  RESERVED_STORE_TOOL_ROOTS.has(entry)

// Backstop depth for the store filesystem walks. For the `listRepos` layout walk
// the documented layout is `<host>/<owner>/<repo>/.bare` (repos at depth ~2–3
// from the store root); this generous bound supports nested URL namespaces
// (e.g. GitLab subgroups). Repository markers and worktree markers stop descent
// into payloads; unknown over-depth namespaces receive one diagnostic.
// `collectNestedWorktrees` reuses it as a ref-NAME-nesting bound under
// `refs/heads/<a>/<b>/…`; real branch names nest only a few segments, so the same
// value (8) comfortably clears any legitimate worktree while still capping a
// pathological worktree-less subtree. Hitting it is logged, never silent.
const STORE_REPO_WALK_MAX_DEPTH = 8

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
    depth,
    telemetry,
  }: {
    refTypePath: AbsoluteDirPath
    currentPath: AbsoluteDirPath
    refType: RefType
    depth: number
    telemetry: StoreEnumerationTelemetry
  }): Effect.Effect<
    Array<{
      ref: string
      refType: RefType
      path: AbsoluteDirPath
      broken: boolean
    }>,
    PlatformError
  > =>
    Effect.gen(function* () {
      const gitPath = EffectPath.ops.join(currentPath, EffectPath.unsafe.relativeFile('.git'))
      const isWorktree = yield* fs.exists(gitPath)
      if (isWorktree === true) {
        const ref = currentPath.slice(refTypePath.length).replace(/\/$/, '')
        return [{ ref, refType, path: currentPath, broken: false }]
      }

      // Backstop: a worktree-less subtree (a stray dir, or a broken worktree whose
      // working tree — `node_modules`, build output — survived a dropped `.git`)
      // would otherwise recurse to the filesystem's depth. The `.git` check above
      // runs first, so a real worktree sitting exactly at the cap is still found;
      // we only refuse to descend PAST it. `depth` is measured in ref-name
      // segments under `refTypePath` (`refs/heads/<a>/<b>/…`), and real branch
      // names nest only a handful of levels, so reusing the layout walk's bound (8)
      // can never truncate a legitimate worktree.
      if (depth >= STORE_REPO_WALK_MAX_DEPTH) {
        telemetry.depthLimited(currentPath)
        return []
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
        if (
          (yield* telemetry
            .isDirectory({ fs, path: entryPath })
            .pipe(Effect.orElseSucceed(() => false))) === false
        )
          continue

        nestedResults.push(
          ...(yield* collectNestedWorktrees({
            refTypePath,
            currentPath: entryPath,
            refType,
            depth: depth + 1,
            telemetry,
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

    hasBareRepo: (source) => fs.exists(getBareRepoPath(source)),

    hasWorktree: (args) => {
      const worktreePath = getWorktreePath(args)
      const gitFilePath = `${worktreePath}.git`.replace(/\/\.git$/, '/.git')
      return fs.exists(gitFilePath)
    },

    // Admission is a bounded breadth-first marker search, never a full census.
    // Exhausting admission limits means foreign; admitted census stays fail-closed.
    listRepos: withStoreEnumeration('megarepo/store/list-repos')(function* (telemetry) {
      const exists = yield* fs.exists(basePath)
      if (exists === false) {
        return []
      }

      const result: Array<{
        relativePath: RelativeDirPath
        fullPath: AbsoluteDirPath
      }> = []

      const walk = ({
        dir,
        depth,
        census,
      }: {
        dir: AbsoluteDirPath
        depth: number
        census: { overflow: AbsoluteDirPath | undefined }
      }): Effect.Effect<void, PlatformError> =>
        Effect.gen(function* () {
          yield* Effect.yieldNow
          const barePath = EffectPath.ops.join(dir, EffectPath.unsafe.relativeDir('.bare/'))
          const hasBare = yield* fs.exists(barePath)
          if (hasBare === true) {
            const relativePath = `${dir.slice(basePath.length).replace(/^\/+/, '').replace(/\/?$/, '/')}`
            result.push({
              relativePath: EffectPath.unsafe.relativeDir(relativePath),
              fullPath: dir,
            })
            return
          }

          // Membership-contract stops (a member is `<host>/<owner>/<repo>/.bare`).
          // Without these the walk descends into directories that are NOT part of
          // this store and enumerates their entire contents — exhausting memory on
          // a real store and mis-claiming non-members:
          //  - `.git` present  → a checked-out worktree, never a namespace dir;
          //    its working tree (node_modules, …) must never be walked.
          //  - `.state`/`.locks` below the host namespace → a NESTED megarepo
          //    store, whose repos belong to it, not here. Host namespaces may
          //    carry `.state` metadata of their own.
          const hasGit = yield* fs.exists(
            EffectPath.ops.join(dir, EffectPath.unsafe.relativeFile('.git')),
          )
          if (hasGit === true) return
          const [hasNestedState, hasNestedLocks] = yield* Effect.all([
            fs.exists(EffectPath.ops.join(dir, EffectPath.unsafe.relativeDir('.state/'))),
            fs.exists(EffectPath.ops.join(dir, EffectPath.unsafe.relativeDir('.locks/'))),
          ])
          const isHostNamespace = depth === 1 && dir.slice(basePath.length).includes('.')
          const isNestedStore =
            isHostNamespace === false && (hasNestedState === true || hasNestedLocks === true)
          if (isNestedStore === true) return

          // Admission already established ownership; incomplete census of a
          // member namespace must fail closed even if no repo was reached yet.
          if (depth >= STORE_REPO_WALK_MAX_DEPTH) {
            census.overflow ??= dir
            telemetry.depthLimited(dir)
            return
          }

          const entries = yield* fs.readDirectory(dir)
          yield* Effect.forEach(
            entries,
            (entry) =>
              Effect.gen(function* () {
                if (entry.startsWith('.') === true) {
                  return
                }

                const entryPath = EffectPath.ops.join(
                  dir,
                  EffectPath.unsafe.relativeDir(`${entry}/`),
                )
                if ((yield* telemetry.isDirectory({ fs, path: entryPath })) === false) return

                yield* walk({ dir: entryPath, depth: depth + 1, census })
              }),
            { concurrency: 32 },
          )
        })

      const namespaces = yield* fs.readDirectory(basePath)
      yield* Effect.forEach(
        namespaces,
        (entry) =>
          Effect.gen(function* () {
            if (shouldSkipStoreRootEntry(entry) === true) {
              if (RESERVED_STORE_TOOL_ROOTS.has(entry) === true)
                telemetry.foreignNamespace(`${basePath}${entry}/`)
              return
            }

            const entryPath = EffectPath.ops.join(
              basePath,
              EffectPath.unsafe.relativeDir(`${entry}/`),
            )
            if ((yield* telemetry.isDirectory({ fs, path: entryPath })) === false) return

            const pending: Array<{ path: string; depth: number }> = [{ path: entryPath, depth: 1 }]
            let reads = 0
            let entriesChecked = 0
            let memberNamespace = false
            for (let index = 0; index < pending.length; index++) {
              const current = pending[index]!
              if (current.depth >= 3 && (yield* fs.exists(`${current.path}/.bare`)) === true) {
                if ((yield* isStoreDirectory({ fs, path: `${current.path}/.bare` })) === true) {
                  memberNamespace = true
                  break
                }
              }
              if (current.depth >= STORE_REPO_WALK_MAX_DEPTH) continue
              if ((yield* fs.exists(`${current.path}/.git`)) === true) continue
              if (
                current.depth > 1 &&
                ((yield* fs.exists(`${current.path}/.state`)) === true ||
                  (yield* fs.exists(`${current.path}/.locks`)) === true)
              )
                continue
              // Per root: at most 128 directory reads and 4096 candidate entries,
              // bounding both IO and the BFS queue even for very broad caches.
              if (reads >= 128) break
              reads++
              for (const child of yield* fs.readDirectory(current.path)) {
                if (entriesChecked >= 4096) break
                entriesChecked++
                if (child.startsWith('.') === true) continue
                const path = `${current.path.replace(/\/$/, '')}/${child}`
                if ((yield* isStoreDirectory({ fs, path })) === true)
                  pending.push({ path, depth: current.depth + 1 })
              }
            }
            if (memberNamespace === false) {
              telemetry.foreignNamespace(entryPath)
              return
            }

            const census = { overflow: undefined as AbsoluteDirPath | undefined }
            yield* walk({ dir: entryPath, depth: 1, census })
            if (census.overflow !== undefined) {
              return yield* Effect.die(
                new Error(
                  `store listRepos census exceeded the supported depth at ${census.overflow}`,
                ),
              )
            }
          }),
        { concurrency: 32 },
      )

      return result.toSorted((a, b) => a.relativePath.localeCompare(b.relativePath))
    }),

    listWorktrees: (source) =>
      withStoreEnumeration('megarepo/store/list-worktrees')(function* (telemetry) {
        const repoBase = getRepoBasePath(source)
        const refsDir = EffectPath.ops.join(repoBase, EffectPath.unsafe.relativeDir('refs/'))

        const exists = yield* fs.exists(refsDir.replace(/\/+$/, ''))
        if (exists === false) {
          return []
        }
        if ((yield* telemetry.isDirectory({ fs, path: refsDir })) === false) return []

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
          if ((yield* telemetry.isDirectory({ fs, path: refTypePath })) === false) continue

          result.push(
            ...(yield* collectNestedWorktrees({
              refTypePath,
              currentPath: refTypePath,
              refType,
              depth: 0,
              telemetry,
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
 * Resolve a symlinked store root to its real path. Git registers worktrees
 * under real paths while downstream identity checks compare paths lexically,
 * so a symlinked default store (e.g. `~/.megarepo -> /mnt/bulk/megarepo`)
 * would otherwise reject every branch member with GitIdentityConflict
 * ("registered outside canonical P or P/repos/<owned>").
 */
const canonicalizeStorePath = ({
  fs,
  path,
}: {
  fs: FileSystem.FileSystem
  path: AbsoluteDirPath
}) =>
  fs.exists(path).pipe(
    Effect.flatMap((exists) =>
      exists === true
        ? fs.realPath(path).pipe(
            Effect.map((real) => {
              const withTrailingSlash = real.endsWith('/') === true ? real : `${real}/`
              return EffectPath.unsafe.absoluteDir(withTrailingSlash)
            }),
          )
        : Effect.succeed(path),
    ),
    Effect.orElseSucceed(() => path),
  )

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
    const storePathRaw = Option.fromUndefinedOr(process.env[ENV_VARS.STORE]).pipe(
      Option.getOrElse(() => DEFAULT_STORE_PATH),
    )
    const basePath = yield* canonicalizeStorePath({ fs, path: expandStorePath(storePathRaw) })
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
