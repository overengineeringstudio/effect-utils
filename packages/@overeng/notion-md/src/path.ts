import { basename } from 'node:path'

import { Effect, FileSystem, type Path } from 'effect'

import type { BatchResult } from './batch.ts'
import { NmdCliError, type NmdError } from './errors.ts'
import type { NotionMdGateway } from './model.ts'
import * as Observability from './observability.ts'
import {
  reconcileFile,
  reconcileTree,
  statusFile,
  statusTree,
  trackPage,
  type ReconcileResult,
  type ReconcileStatus,
  type TrackResult,
} from './reconcile.ts'
import type { NmdStateStore } from './state-store.ts'
import { syncTree, type TreeSyncResult } from './tree.ts'

/** Filesystem shape used to choose the appropriate notion-md reconcile engine. */
export type PathTargetKind = 'file' | 'directory' | 'missing'

/** Result of status over a single file, directory tree, or flat recursive batch. */
export type StatusPathResult = ReconcileStatus | TreeSyncResult | BatchResult<ReconcileStatus>
/** Result of sync over a single file, directory tree, or flat recursive batch. */
export type SyncPathResult = ReconcileResult | TreeSyncResult | BatchResult<ReconcileResult>
/** Result of a dry-run directory tree plan. */
export type PlanPathResult = TreeSyncResult
/** Result of tracking a remote page into one file or an existing directory tree. */
export type TrackPathResult = TrackResult | TreeSyncResult

/** Options for routing `track` by the explicit filesystem kind of its output path. */
export interface TrackPathOptions {
  readonly pageId: string
  readonly outPath: string
  readonly source: TrackResult['source']
  readonly dryRun?: boolean
}

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

/** Options for syncing a file-or-directory path. */
export interface SyncPathOptions {
  readonly path: string
  readonly recursive?: boolean
  readonly concurrency?: number
  readonly rootPageId?: string
  readonly rootFile?: string
  readonly fromRemote?: boolean
  readonly force?: boolean
  readonly dryRun?: boolean
  readonly allowDeletingUnknownBlocks?: boolean
  readonly allowReviewMarkup?: boolean
  readonly gcObjects?: boolean
}

/** Classify a local target into file / directory / missing without throwing. */
export const targetKind = (
  target: string,
): Effect.Effect<PathTargetKind, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const info = yield* fs.stat(target).pipe(Effect.result)
    if (info._tag === 'Failure') return 'missing'
    return info.success.type === 'Directory' ? 'directory' : 'file'
  })

/**
 * Track one remote page into a file, or its full child-page subtree into an
 * existing directory. Missing targets retain the single-file `trackPage` behavior.
 */
export const trackPath = (
  opts: TrackPathOptions,
): Effect.Effect<
  TrackPathResult,
  NmdError,
  FileSystem.FileSystem | NotionMdGateway | NmdStateStore
> =>
  Effect.gen(function* () {
    const kind = yield* targetKind(opts.outPath)
    if (kind === 'directory') {
      if (opts.source !== 'remote') {
        return yield* new NmdCliError({
          message: `Directory track targets only support --as remote; use a .nmd file target with --as ${opts.source}`,
        })
      }
      return yield* syncTree({
        root: opts.outPath,
        rootPageId: opts.pageId,
        fromRemote: true,
        ...(opts.dryRun === undefined ? {} : { plan: opts.dryRun }),
      })
    }
    return yield* trackPage({
      pageId: opts.pageId,
      outPath: opts.outPath,
      source: opts.source,
      ...(opts.dryRun === undefined ? {} : { dryRun: opts.dryRun }),
    })
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
      return yield* statusFile({ path: opts.path })
    }
    return yield* statusTree({
      targets: [opts.path],
      ...(opts.recursive === undefined ? {} : { recursive: opts.recursive }),
      ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }),
    })
  }).pipe(
    Observability.withOperation({
      operation: Observability.StatusPathSpan,
      attributes: {
        basename: basename(opts.path),
        recursive: opts.recursive === true,
      },
    }),
  )

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
    Observability.withOperation({
      operation: Observability.PlanPathSpan,
      attributes: {
        basename: basename(opts.path),
        fromRemote: opts.fromRemote === true,
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
        ...(opts.dryRun === undefined ? {} : { plan: opts.dryRun }),
        ...(opts.rootPageId === undefined ? {} : { rootPageId: opts.rootPageId }),
        ...(opts.rootFile === undefined ? {} : { rootFile: opts.rootFile }),
      })
    }

    if (kind === 'directory') {
      if (opts.recursive === true) {
        return yield* reconcileTree({
          targets: [opts.path],
          recursive: true,
          ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }),
          ...(opts.force === undefined ? {} : { force: opts.force }),
          ...(opts.dryRun === undefined ? {} : { dryRun: opts.dryRun }),
          ...(opts.allowDeletingUnknownBlocks === undefined
            ? {}
            : { allowDeletingUnknownBlocks: opts.allowDeletingUnknownBlocks }),
          ...(opts.allowReviewMarkup === undefined
            ? {}
            : { allowReviewMarkup: opts.allowReviewMarkup }),
          ...(opts.gcObjects === undefined ? {} : { gcObjects: opts.gcObjects }),
        })
      }
      return yield* syncTree({
        root: opts.path,
        ...(opts.dryRun === undefined ? {} : { plan: opts.dryRun }),
        pushOptions: { path: opts.path, ...pushSafety(opts) },
        ...(opts.rootPageId === undefined ? {} : { rootPageId: opts.rootPageId }),
        ...(opts.rootFile === undefined ? {} : { rootFile: opts.rootFile }),
      })
    }

    return yield* reconcileFile({
      path: opts.path,
      ...(opts.force === undefined ? {} : { force: opts.force }),
      ...(opts.dryRun === undefined ? {} : { dryRun: opts.dryRun }),
      ...(opts.allowDeletingUnknownBlocks === undefined
        ? {}
        : { allowDeletingUnknownBlocks: opts.allowDeletingUnknownBlocks }),
      ...(opts.allowReviewMarkup === undefined
        ? {}
        : { allowReviewMarkup: opts.allowReviewMarkup }),
      ...(opts.gcObjects === undefined ? {} : { gcObjects: opts.gcObjects }),
    })
  }).pipe(
    Observability.withOperation({
      operation: Observability.SyncPathSpan,
      attributes: {
        basename: basename(opts.path),
        recursive: opts.recursive === true,
        fromRemote: opts.fromRemote === true,
      },
    }),
  )

const pushSafety = (opts: Omit<SyncPathOptions, 'path'>) => ({
  ...(opts.force === undefined ? {} : { force: opts.force }),
  ...(opts.dryRun === undefined ? {} : { dryRun: opts.dryRun }),
  ...(opts.allowDeletingUnknownBlocks === undefined
    ? {}
    : { allowDeletingUnknownBlocks: opts.allowDeletingUnknownBlocks }),
  ...(opts.allowReviewMarkup === undefined ? {} : { allowReviewMarkup: opts.allowReviewMarkup }),
})
