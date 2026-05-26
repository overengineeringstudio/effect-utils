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
}: {
  workspaceRoot: AbsoluteDirPath
  store: MegarepoStore
}): Effect.Effect<Set<string>, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const targets = new Set<string>()
    const membersRoot = getMembersRoot(workspaceRoot)
    const membersRootExists = yield* fs
      .exists(membersRoot)
      .pipe(Effect.catchAll(() => Effect.succeed(false)))
    if (membersRootExists === false) return targets

    const entries = yield* fs
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
      },
    }),
  )

/** Collects store worktree paths used by one workspace from symlinks plus its lock file. */
export const collectWorkspaceLivePaths = ({
  workspaceRoot,
  store,
}: {
  workspaceRoot: AbsoluteDirPath
  store: MegarepoStore
}): Effect.Effect<
  Set<string>,
  ConfigNotFoundError | PlatformError.PlatformError | ParseResult.ParseError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const paths = yield* collectWorkspaceSymlinkTargets({ workspaceRoot, store })

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

/** Refreshes the store-local liveness registry entry for one workspace. */
export const refreshWorkspaceRegistry = ({
  workspaceRoot,
  store,
}: {
  workspaceRoot: AbsoluteDirPath
  store: MegarepoStore
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
      updatedAt: new Date().toISOString(),
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

const readRegistryRecords = ({
  store,
  pruneStale,
}: {
  store: MegarepoStore
  pruneStale: boolean
}): Effect.Effect<
  ReadonlyArray<StoreWorkspaceRecord>,
  PlatformError.PlatformError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const registryDir = workspaceRegistryDir(store)
    const exists = yield* fs.exists(registryDir).pipe(Effect.catchAll(() => Effect.succeed(false)))
    if (exists === false) return []

    const entries = yield* fs
      .readDirectory(registryDir)
      .pipe(Effect.catchAll(() => Effect.succeed([] as string[])))
    const records: StoreWorkspaceRecord[] = []

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

      const workspaceExists = yield* fs
        .exists(parsed.workspaceRoot)
        .pipe(Effect.catchAll(() => Effect.succeed(false)))
      if (workspaceExists === true) {
        records.push(parsed)
      } else if (pruneStale === true) {
        yield* fs.remove(recordPath).pipe(Effect.catchAll(() => Effect.void))
      }
    }

    return records
  }).pipe(
    Effect.withSpan('megarepo/store/liveness/read-registry', {
      attributes: { 'span.label': 'registry' },
    }),
  )

/** Collects the store-wide protected path set from the workspace registry. */
export const collectStoreLiveSet = ({
  store,
  currentWorkspaceRoot,
  refreshCurrentWorkspace = true,
  pruneStaleRegistry = true,
}: {
  store: MegarepoStore
  currentWorkspaceRoot?: AbsoluteDirPath | undefined
  refreshCurrentWorkspace?: boolean | undefined
  pruneStaleRegistry?: boolean | undefined
}): Effect.Effect<
  StoreLiveSet,
  ConfigNotFoundError | PlatformError.PlatformError | ParseResult.ParseError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const currentWorkspacePaths =
      currentWorkspaceRoot !== undefined && refreshCurrentWorkspace === false
        ? yield* collectWorkspaceLivePaths({ workspaceRoot: currentWorkspaceRoot, store })
        : undefined

    if (currentWorkspaceRoot !== undefined && refreshCurrentWorkspace === true) {
      yield* refreshWorkspaceRegistry({ workspaceRoot: currentWorkspaceRoot, store })
    }

    const records = yield* readRegistryRecords({ store, pruneStale: pruneStaleRegistry })
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
    } satisfies StoreLiveSet
  }).pipe(
    Effect.withSpan('megarepo/store/liveness/collect-store', {
      attributes: {
        'span.label': 'store',
        hasCurrentWorkspace: currentWorkspaceRoot !== undefined,
        pruneStaleRegistry,
        refreshCurrentWorkspace,
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
