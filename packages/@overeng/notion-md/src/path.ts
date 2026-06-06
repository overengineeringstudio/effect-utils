import { basename } from 'node:path'

import type { Path } from '@effect/platform'
import { FileSystem } from '@effect/platform'
import { Effect } from 'effect'

import { statusMany, syncMany, type BatchResult } from './batch.ts'
import { NmdCliError, type NmdError } from './errors.ts'
import type { NotionMdGateway } from './model.ts'
import type { NmdStateStore } from './state-store.ts'
import {
  statusPage,
  syncPage,
  type StatusResult,
  type SyncOptions,
  type SyncResult,
} from './sync.ts'
import { syncTree, type TreeSyncResult } from './tree.ts'

/** Filesystem shape used to choose the appropriate notion-md reconcile engine. */
export type PathTargetKind = 'file' | 'directory' | 'missing'

/** Result of status over a single file, directory tree, or flat recursive batch. */
export type StatusPathResult = StatusResult | TreeSyncResult | BatchResult<StatusResult>
/** Result of sync over a single file, directory tree, or flat recursive batch. */
export type SyncPathResult = SyncResult | TreeSyncResult | BatchResult<SyncResult>
/** Result of a dry-run directory tree plan. */
export type PlanPathResult = TreeSyncResult

/** Options for status over the public path-oriented API. */
export interface StatusPathOptions {
  readonly path: string
  readonly recursive?: boolean
  readonly concurrency?: number
}

/** Options for planning a directory tree reconcile pass. */
export interface PlanPathOptions {
  readonly path: string
  readonly rootPageId?: string
  readonly rootFile?: string
  readonly fromRemote?: boolean
}

/** Options for syncing the public file-or-directory path API. */
export interface SyncPathOptions extends Omit<SyncOptions, 'path'> {
  readonly path: string
  readonly recursive?: boolean
  readonly concurrency?: number
  readonly rootPageId?: string
  readonly rootFile?: string
  readonly fromRemote?: boolean
}

/** Classify a local target into file / directory / missing without throwing. */
export const targetKind = (
  target: string,
): Effect.Effect<PathTargetKind, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const info = yield* fs.stat(target).pipe(Effect.either)
    if (info._tag === 'Left') return 'missing'
    return info.right.type === 'Directory' ? 'directory' : 'file'
  })

/** Compare a local path with Notion, routing files, trees, and flat batches safely. */
export const statusPath = (
  opts: StatusPathOptions,
): Effect.Effect<
  StatusPathResult,
  NmdError,
  FileSystem.FileSystem | Path.Path | NotionMdGateway | NmdStateStore
> =>
  Effect.gen(function* () {
    const kind = yield* targetKind(opts.path)
    if (kind === 'directory' && opts.recursive !== true) {
      return yield* syncTree({ root: opts.path, plan: true })
    }
    if (kind === 'file') {
      return yield* statusPage({ path: opts.path })
    }
    return yield* syncManyStatus(opts)
  }).pipe(
    Effect.withSpan('notion-md.status-path', {
      attributes: {
        'span.label': basename(opts.path),
        'notion_md.path.recursive': opts.recursive === true,
      },
    }),
  )

const syncManyStatus = (opts: StatusPathOptions) =>
  statusMany({
    targets: [opts.path],
    ...(opts.recursive === undefined ? {} : { recursive: opts.recursive }),
    ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }),
  })

/** Dry-run a directory tree reconcile pass through the same path-oriented routing. */
export const planPath = (
  opts: PlanPathOptions,
): Effect.Effect<
  PlanPathResult,
  NmdError,
  FileSystem.FileSystem | NotionMdGateway | NmdStateStore
> =>
  Effect.gen(function* () {
    const kind = yield* targetKind(opts.path)
    if (kind === 'file') {
      return yield* new NmdCliError({
        message:
          opts.fromRemote === true
            ? '--from-remote is directory-tree only; use `notion-md sync <page-id-or-url> <file.nmd>` to import one page.'
            : `plan is directory-tree only; use \`notion-md status ${opts.path}\` for a single .nmd file`,
      })
    }
    return yield* syncTree({
      root: opts.path,
      plan: true,
      ...(opts.fromRemote === undefined ? {} : { fromRemote: opts.fromRemote }),
      ...(opts.rootPageId === undefined ? {} : { rootPageId: opts.rootPageId }),
      ...(opts.rootFile === undefined ? {} : { rootFile: opts.rootFile }),
    })
  }).pipe(
    Effect.withSpan('notion-md.plan-path', {
      attributes: {
        'span.label': basename(opts.path),
        'notion_md.tree.from_remote': opts.fromRemote === true,
      },
    }),
  )

/** Reconcile a local path with Notion, routing files, trees, and flat batches safely. */
export const syncPath = (
  opts: SyncPathOptions,
): Effect.Effect<
  SyncPathResult,
  NmdError,
  FileSystem.FileSystem | Path.Path | NotionMdGateway | NmdStateStore
> =>
  Effect.gen(function* () {
    const kind = yield* targetKind(opts.path)
    if (opts.fromRemote === true) {
      if (opts.recursive === true) {
        return yield* new NmdCliError({
          message:
            'Cannot combine --recursive and --from-remote: --recursive is flat batch mode; --from-remote is directory tree mode.',
        })
      }
      if (kind === 'file') {
        return yield* new NmdCliError({
          message:
            '--from-remote is directory-tree only; use `notion-md sync <page-id-or-url> <file.nmd>` to import one page.',
        })
      }
      return yield* syncTree({
        root: opts.path,
        fromRemote: true,
        pushOptions: { path: opts.path, ...pushSafety(opts) },
        ...(opts.rootPageId === undefined ? {} : { rootPageId: opts.rootPageId }),
        ...(opts.rootFile === undefined ? {} : { rootFile: opts.rootFile }),
      })
    }

    if (kind === 'directory') {
      if (opts.recursive === true) {
        return yield* syncMany({
          targets: [opts.path],
          recursive: true,
          ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }),
          ...pushSafety(opts),
        })
      }
      return yield* syncTree({
        root: opts.path,
        fromRemote: false,
        pushOptions: { path: opts.path, ...pushSafety(opts) },
        ...(opts.rootPageId === undefined ? {} : { rootPageId: opts.rootPageId }),
        ...(opts.rootFile === undefined ? {} : { rootFile: opts.rootFile }),
      })
    }

    return yield* syncPage({ path: opts.path, ...pushSafety(opts) })
  }).pipe(
    Effect.withSpan('notion-md.sync-path', {
      attributes: {
        'span.label': basename(opts.path),
        'notion_md.path.recursive': opts.recursive === true,
        'notion_md.tree.from_remote': opts.fromRemote === true,
      },
    }),
  )

const pushSafety = (opts: Omit<SyncPathOptions, 'path'>): Omit<SyncOptions, 'path'> => ({
  ...(opts.force === undefined ? {} : { force: opts.force }),
  ...(opts.allowDeletingUnknownBlocks === undefined
    ? {}
    : { allowDeletingUnknownBlocks: opts.allowDeletingUnknownBlocks }),
  ...(opts.allowReviewMarkup === undefined ? {} : { allowReviewMarkup: opts.allowReviewMarkup }),
})
