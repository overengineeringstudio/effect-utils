/**
 * Store liveness registry.
 *
 * The store is shared by independent megarepo workspaces, so a single
 * workspace lock file is not sufficient proof that another worktree is unused.
 * This module records and reads observed workspace consumers without scanning
 * arbitrary filesystem roots.
 */

import { createHash } from 'node:crypto'

import { FileSystem, type Error as PlatformError } from '@effect/platform'
import { Effect, Option, Schema, type ParseResult } from 'effect'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import {
  type ConfigNotFoundError,
  getMembersRoot,
  isRemoteSource,
  parseSourceString,
  readMegarepoConfig,
} from './config.ts'
import { LOCK_FILE_NAME, readLockFile } from './lock.ts'
import type { MegarepoStore } from './store.ts'

const REGISTRY_VERSION = 1

const StoreWorkspaceRecord = Schema.Struct({
  version: Schema.Literal(REGISTRY_VERSION),
  workspaceRoot: Schema.String,
  updatedAt: Schema.String,
  livePaths: Schema.Array(Schema.String),
})

type StoreWorkspaceRecord = Schema.Schema.Type<typeof StoreWorkspaceRecord>

/** Store worktree paths that are currently known to be used by registered workspaces. */
export interface StoreLiveSet {
  readonly paths: ReadonlySet<string>
  readonly workspaceCount: number
  /**
   * Store paths belonging to a workspace that was present but failed a strict
   * reconcile this run (only populated by `reconcileAllWorkspaces`). These paths
   * stay protected (their last-known live set is kept), but gc must NOT advance
   * absence grace for them — their freshness is unconfirmed (B2/decision 0010).
   */
  readonly uncleanReconcilePaths: ReadonlySet<string>
}

const normalizePath = (path: string): string => path.replace(/\/+$/, '')

const hashPath = (path: string): string => createHash('sha256').update(path).digest('hex')

const workspaceLabel = (workspaceRoot: AbsoluteDirPath): string =>
  workspaceRoot.split('/').findLast((part) => part.length > 0) ?? 'workspace'

const workspaceRegistryDir = (store: MegarepoStore): AbsoluteDirPath =>
  EffectPath.ops.join(store.basePath, EffectPath.unsafe.relativeDir('.state/workspaces/'))

const workspaceRecordPath = ({
  store,
  workspaceRoot,
}: {
  store: MegarepoStore
  workspaceRoot: AbsoluteDirPath
}) =>
  EffectPath.ops.join(
    workspaceRegistryDir(store),
    EffectPath.unsafe.relativeFile(`${hashPath(normalizePath(workspaceRoot))}.json`),
  )

const isStorePath = ({ store, path }: { store: MegarepoStore; path: string }): boolean =>
  normalizePath(path).startsWith(normalizePath(store.basePath) + '/')

const collectWorkspaceSymlinkTargets = ({
  workspaceRoot,
  store,
  strict = false,
}: {
  workspaceRoot: AbsoluteDirPath
  store: MegarepoStore
  /**
   * When true, surface read errors (missing dir, unreadable entries) instead of
   * swallowing them into an empty/partial set. A present-but-unreadable workspace
   * must fail safe (keep its last-known live paths), which is only possible if the
   * error is propagated to the caller rather than masked as "no live paths".
   */
  strict?: boolean
}): Effect.Effect<Set<string>, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const targets = new Set<string>()
    const membersRoot = getMembersRoot(workspaceRoot)
    const membersRootExists = strict
      ? yield* fs.exists(membersRoot)
      : yield* fs.exists(membersRoot).pipe(Effect.catchAll(() => Effect.succeed(false)))
    if (membersRootExists === false) return targets

    // Workspace-level read failures (unreadable members dir) surface in strict
    // mode so a present-but-unreadable workspace fails safe upstream. A
    // per-entry `readLink` failure is always tolerated: a non-symlink directory
    // entry (e.g. a local repo) legitimately has no store target.
    const entries = strict
      ? yield* fs.readDirectory(membersRoot)
      : yield* fs
          .readDirectory(membersRoot)
          .pipe(Effect.catchAll(() => Effect.succeed([] as string[])))
    for (const entry of entries) {
      if (entry.startsWith('.') === true) continue
      const memberPath = EffectPath.ops.join(membersRoot, EffectPath.unsafe.relativeFile(entry))
      const target = yield* fs
        .readLink(memberPath)
        .pipe(Effect.catchAll(() => Effect.succeed(null)))
      if (target !== null && isStorePath({ store, path: target }) === true) {
        targets.add(normalizePath(target))
      }
    }

    return targets
  }).pipe(
    Effect.withSpan('megarepo/store/liveness/scan-symlinks', {
      attributes: {
        'span.label': workspaceLabel(workspaceRoot),
        workspaceRoot,
        strict,
      },
    }),
  )

/** Collects store worktree paths used by one workspace from symlinks plus its lock file. */
export const collectWorkspaceLivePaths = ({
  workspaceRoot,
  store,
  strict = false,
}: {
  workspaceRoot: AbsoluteDirPath
  store: MegarepoStore
  /** When true, surface read errors instead of degrading to a partial/empty set. */
  strict?: boolean
}): Effect.Effect<
  Set<string>,
  ConfigNotFoundError | PlatformError.PlatformError | ParseResult.ParseError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const paths = yield* collectWorkspaceSymlinkTargets({ workspaceRoot, store, strict })

    const lockPath = EffectPath.ops.join(
      workspaceRoot,
      EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
    )
    const lockFileOpt = yield* readLockFile(lockPath)
    const lockFile = Option.getOrUndefined(lockFileOpt)

    if (lockFile !== undefined) {
      const { config } = yield* readMegarepoConfig(workspaceRoot)

      for (const [name, sourceString] of Object.entries(config.members)) {
        const source = parseSourceString(sourceString)
        if (source === undefined || isRemoteSource(source) === false) continue

        const lockedMember = lockFile.members[name]
        if (lockedMember === undefined) continue

        paths.add(
          normalizePath(
            store.getWorktreePath({
              source,
              ref: lockedMember.ref,
            }),
          ),
        )
        paths.add(
          normalizePath(
            store.getWorktreePath({
              source,
              ref: lockedMember.commit,
              refType: 'commit',
            }),
          ),
        )
      }
    }

    return paths
  }).pipe(
    Effect.withSpan('megarepo/store/liveness/collect-workspace', {
      attributes: {
        'span.label': workspaceLabel(workspaceRoot),
        workspaceRoot,
      },
    }),
  )

/**
 * Like {@link collectWorkspaceLivePaths} but SURFACES read errors instead of
 * degrading an unreadable workspace to an empty set. Used by reconcile-all so a
 * present-but-unreadable workspace fails safe (keeps its last-known live paths)
 * rather than silently losing protection.
 */
export const collectWorkspaceLivePathsStrict = ({
  workspaceRoot,
  store,
}: {
  workspaceRoot: AbsoluteDirPath
  store: MegarepoStore
}): Effect.Effect<
  Set<string>,
  ConfigNotFoundError | PlatformError.PlatformError | ParseResult.ParseError,
  FileSystem.FileSystem
> => collectWorkspaceLivePaths({ workspaceRoot, store, strict: true })

/**
 * Refreshes the store-local liveness registry entry for one workspace.
 *
 * `now` (epoch ms) is the explicit clock seam for the record's `updatedAt`; the
 * CLI edge reads the wall clock, never this decision/persistence path.
 */
export const refreshWorkspaceRegistry = ({
  workspaceRoot,
  store,
  now,
}: {
  workspaceRoot: AbsoluteDirPath
  store: MegarepoStore
  now: number
}): Effect.Effect<
  StoreWorkspaceRecord,
  ConfigNotFoundError | PlatformError.PlatformError | ParseResult.ParseError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const livePaths = yield* collectWorkspaceLivePaths({ workspaceRoot, store })
    const record: StoreWorkspaceRecord = {
      version: REGISTRY_VERSION,
      workspaceRoot: normalizePath(workspaceRoot),
      updatedAt: new Date(now).toISOString(),
      livePaths: [...livePaths].toSorted(),
    }

    const registryDir = workspaceRegistryDir(store)
    yield* fs.makeDirectory(registryDir, { recursive: true })
    const content = yield* Schema.encode(Schema.parseJson(StoreWorkspaceRecord, { space: 2 }))(
      record,
    )
    yield* fs.writeFileString(workspaceRecordPath({ store, workspaceRoot }), content + '\n')
    return record
  }).pipe(
    Effect.withSpan('megarepo/store/liveness/refresh-workspace', {
      attributes: {
        'span.label': workspaceLabel(workspaceRoot),
        workspaceRoot,
      },
    }),
  )

/** Result of reading (and optionally reconciling) the workspace registry. */
interface RegistryReadResult {
  readonly records: ReadonlyArray<StoreWorkspaceRecord>
  /**
   * Store paths belonging to workspaces that were present but failed a strict
   * reconcile this run (B2/decision 0010). Their last-known live paths are kept,
   * but the caller must NOT treat them as freshly-confirmed (e.g. grace advance).
   */
  readonly uncleanReconcilePaths: ReadonlySet<string>
}

const readRegistryRecords = ({
  store,
  pruneStale,
  reconcile,
}: {
  store: MegarepoStore
  pruneStale: boolean
  /**
   * When provided, re-derive each present workspace's live paths fresh from disk
   * (decision 0010). On success the on-disk record is rewritten with `now` as
   * `updatedAt`; on read error the existing record is KEPT unchanged (fail safe —
   * never overwrite a non-empty record with empty) and flagged unclean.
   */
  reconcile?: { now: number } | undefined
}): Effect.Effect<
  RegistryReadResult,
  ConfigNotFoundError | PlatformError.PlatformError | ParseResult.ParseError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const registryDir = workspaceRegistryDir(store)
    const exists = yield* fs.exists(registryDir).pipe(Effect.catchAll(() => Effect.succeed(false)))
    if (exists === false) return { records: [], uncleanReconcilePaths: new Set<string>() }

    const entries = yield* fs
      .readDirectory(registryDir)
      .pipe(Effect.catchAll(() => Effect.succeed([] as string[])))
    const records: StoreWorkspaceRecord[] = []
    const uncleanReconcilePaths = new Set<string>()

    for (const entry of entries) {
      if (entry.endsWith('.json') === false) continue
      const recordPath = EffectPath.ops.join(registryDir, EffectPath.unsafe.relativeFile(entry))
      const parsed = yield* fs.readFileString(recordPath).pipe(
        Effect.flatMap((content) =>
          Schema.decodeUnknown(Schema.parseJson(StoreWorkspaceRecord))(content),
        ),
        Effect.catchAll(() => Effect.succeed(null)),
      )
      if (parsed === null) continue

      const workspaceRoot = EffectPath.unsafe.absoluteDir(`${parsed.workspaceRoot}/`)
      const workspaceExists = yield* fs
        .exists(parsed.workspaceRoot)
        .pipe(Effect.catchAll(() => Effect.succeed(false)))

      // Prune only when the workspace dir is GONE (decision 0010); a
      // present-but-unreadable workspace must never be pruned.
      if (workspaceExists === false) {
        if (pruneStale === true) {
          yield* fs.remove(recordPath).pipe(Effect.catchAll(() => Effect.void))
        }
        continue
      }

      if (reconcile === undefined) {
        records.push(parsed)
        continue
      }

      // Reconcile-all: re-derive from disk. Success ⇒ rewrite the record fresh.
      // Read error ⇒ keep the existing record verbatim and flag it unclean.
      const reconciled = yield* collectWorkspaceLivePathsStrict({ workspaceRoot, store }).pipe(
        Effect.map((paths) => ({ _tag: 'ok' as const, paths })),
        Effect.catchAll(() => Effect.succeed({ _tag: 'error' as const })),
      )

      if (reconciled._tag === 'ok') {
        const record: StoreWorkspaceRecord = {
          version: REGISTRY_VERSION,
          workspaceRoot: normalizePath(parsed.workspaceRoot),
          updatedAt: new Date(reconcile.now).toISOString(),
          livePaths: [...reconciled.paths].toSorted(),
        }
        const content = yield* Schema.encode(Schema.parseJson(StoreWorkspaceRecord, { space: 2 }))(
          record,
        )
        yield* fs.writeFileString(recordPath, content + '\n')
        records.push(record)
      } else {
        records.push(parsed)
        for (const livePath of parsed.livePaths) {
          if (isStorePath({ store, path: livePath }) === true) {
            uncleanReconcilePaths.add(normalizePath(livePath))
          }
        }
      }
    }

    return { records, uncleanReconcilePaths }
  }).pipe(
    Effect.withSpan('megarepo/store/liveness/read-registry', {
      attributes: { 'span.label': 'registry', reconcileAll: reconcile !== undefined },
    }),
  )

/**
 * Collects the store-wide protected path set from the workspace registry.
 *
 * `reconcileAllWorkspaces` (decision 0010) re-derives EVERY present workspace's
 * live paths fresh from disk before computing the set, so a repin that ran no
 * refreshing command is still caught. Any path-writing mode (`reconcileAll...` or
 * `refreshCurrentWorkspace`) requires an explicit `now` (epoch ms) — the wall
 * clock is never read on this persistence path.
 */
export const collectStoreLiveSet = ({
  store,
  currentWorkspaceRoot,
  refreshCurrentWorkspace = true,
  pruneStaleRegistry = true,
  reconcileAllWorkspaces = false,
  now,
}: {
  store: MegarepoStore
  currentWorkspaceRoot?: AbsoluteDirPath | undefined
  refreshCurrentWorkspace?: boolean | undefined
  pruneStaleRegistry?: boolean | undefined
  reconcileAllWorkspaces?: boolean | undefined
  /** Required whenever a write happens (refresh or reconcile-all). */
  now?: number | undefined
}): Effect.Effect<
  StoreLiveSet,
  ConfigNotFoundError | PlatformError.PlatformError | ParseResult.ParseError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const writesRecord =
      reconcileAllWorkspaces === true ||
      (currentWorkspaceRoot !== undefined && refreshCurrentWorkspace === true)
    if (writesRecord === true && now === undefined) {
      // Guard the clock seam: a record-writing collect MUST receive an explicit
      // `now` rather than silently reading the ambient wall clock.
      return yield* Effect.die(
        new Error('collectStoreLiveSet: `now` is required when writing a registry record'),
      )
    }

    const currentWorkspacePaths =
      currentWorkspaceRoot !== undefined && refreshCurrentWorkspace === false
        ? yield* collectWorkspaceLivePaths({ workspaceRoot: currentWorkspaceRoot, store })
        : undefined

    if (currentWorkspaceRoot !== undefined && refreshCurrentWorkspace === true) {
      yield* refreshWorkspaceRegistry({ workspaceRoot: currentWorkspaceRoot, store, now: now! })
    }

    const { records, uncleanReconcilePaths } = yield* readRegistryRecords({
      store,
      pruneStale: pruneStaleRegistry,
      ...(reconcileAllWorkspaces === true ? { reconcile: { now: now! } } : {}),
    })
    const paths = new Set<string>()
    for (const record of records) {
      for (const livePath of record.livePaths) {
        if (isStorePath({ store, path: livePath }) === true) {
          paths.add(normalizePath(livePath))
        }
      }
    }
    for (const livePath of currentWorkspacePaths ?? []) {
      paths.add(normalizePath(livePath))
    }

    return {
      paths,
      workspaceCount: records.length,
      uncleanReconcilePaths,
    } satisfies StoreLiveSet
  }).pipe(
    Effect.withSpan('megarepo/store/liveness/collect-store', {
      attributes: {
        'span.label': 'store',
        hasCurrentWorkspace: currentWorkspaceRoot !== undefined,
        pruneStaleRegistry,
        refreshCurrentWorkspace,
        reconcileAllWorkspaces,
      },
    }),
  )

/** Checks whether a worktree path is protected by the collected live set. */
export const isPathProtected = ({
  liveSet,
  path,
}: {
  liveSet: StoreLiveSet
  path: string
}): boolean => liveSet.paths.has(normalizePath(path))
