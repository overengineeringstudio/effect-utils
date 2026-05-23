import { basename, dirname, resolve } from 'node:path'

import { FileSystem, Path } from '@effect/platform'
import { Duration, Effect, Queue, Stream } from 'effect'

import { NmdCliError, NmdFileSystemError, type NmdError } from './errors.ts'
import { parseNmdFile } from './frontmatter.ts'
import type { NotionMdGateway } from './model.ts'
import { NmdStateStore } from './state-store.ts'
import {
  pushPage,
  statusPage,
  syncPage,
  type PushOptions,
  type PushResult,
  type StatusResult,
  type SyncOptions,
  type SyncResult,
} from './sync.ts'

const DEFAULT_BATCH_CONCURRENCY = 4
const WATCH_DEBOUNCE = Duration.millis(250)

const SKIPPED_DIRECTORIES = new Set(['.git', '.notion-md', 'node_modules'])

/** Batch-capable page operation names. */
export type BatchOperation = 'push' | 'status' | 'sync'

/** Successful per-file result inside a batch operation. */
export interface BatchSuccess<A> {
  readonly _tag: 'success'
  readonly operation: BatchOperation
  readonly path: string
  readonly result: A
}

/** Failed per-file result inside a batch operation. */
export interface BatchFailure {
  readonly _tag: 'error'
  readonly operation: BatchOperation
  readonly path: string
  readonly error: unknown
}

/** Per-file item in a batch result. */
export type BatchItemResult<A> = BatchSuccess<A> | BatchFailure

/** Summary envelope for multi-file status, push, or sync. */
export interface BatchResult<A> {
  readonly _tag: 'batch'
  readonly operation: BatchOperation
  readonly total: number
  readonly succeeded: number
  readonly failed: number
  readonly items: readonly BatchItemResult<A>[]
}

/** Inputs for resolving file and directory targets into `.nmd` files. */
export interface ResolveTargetsOptions {
  readonly targets: readonly string[]
  readonly recursive?: boolean
  readonly operation?: BatchOperation
}

/** Resolved `.nmd` files plus non-fatal target resolution errors. */
export interface ResolveTargetsResult {
  readonly paths: readonly string[]
  readonly errors: readonly BatchFailure[]
}

/** Inputs for checking multiple `.nmd` files. */
export interface StatusManyOptions extends ResolveTargetsOptions {
  readonly concurrency?: number
}

/** Inputs for pushing multiple `.nmd` files. */
export interface PushManyOptions extends ResolveTargetsOptions, Omit<PushOptions, 'path'> {
  readonly concurrency?: number
}

/** Inputs for syncing multiple `.nmd` files. */
export interface SyncManyOptions extends ResolveTargetsOptions, Omit<SyncOptions, 'path'> {
  readonly concurrency?: number
}

/** Trigger reason emitted by one-file and batch watch loops. */
export type WatchReason = 'file' | 'initial' | 'poll'

interface WatchTrigger {
  readonly path: string
  readonly reason: WatchReason
}

/** Inputs for continuous watch mode over a resolved set of `.nmd` files. */
export interface BatchWatchOptions extends Omit<SyncManyOptions, 'targets' | 'recursive'> {
  readonly paths: readonly string[]
  readonly pollIntervalMs: number
  readonly emit?: (value: unknown) => Effect.Effect<void>
}

const makeFsError = (opts: {
  readonly operation: string
  readonly path: string
  readonly cause: unknown
  readonly message: string
}) =>
  new NmdFileSystemError({
    operation: opts.operation,
    path: opts.path,
    cause: opts.cause,
    message: opts.message,
  })

const failure = (opts: {
  readonly operation: BatchOperation
  readonly path: string
  readonly error: unknown
}): BatchFailure => ({
  _tag: 'error',
  operation: opts.operation,
  path: opts.path,
  error: opts.error,
})

const success = <A>(opts: {
  readonly operation: BatchOperation
  readonly path: string
  readonly result: A
}): BatchSuccess<A> => ({
  _tag: 'success',
  operation: opts.operation,
  path: opts.path,
  result: opts.result,
})

const batchResult = <A>(opts: {
  readonly operation: BatchOperation
  readonly items: readonly BatchItemResult<A>[]
}): BatchResult<A> => {
  const succeeded = opts.items.filter((item) => item._tag === 'success').length
  const failed = opts.items.length - succeeded
  return {
    _tag: 'batch',
    operation: opts.operation,
    total: opts.items.length,
    succeeded,
    failed,
    items: opts.items,
  }
}

const uniqueSorted = (values: readonly string[]): readonly string[] =>
  [...new Set(values)].toSorted()

const discoverDirectory = (opts: {
  readonly root: string
}): Effect.Effect<readonly string[], NmdFileSystemError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const platformPath = yield* Path.Path
    const discovered: string[] = []
    const directories = [opts.root]

    while (directories.length > 0) {
      const current = directories.pop()
      if (current === undefined) continue

      const entries = yield* fs.readDirectory(current).pipe(
        Effect.mapError((cause) =>
          makeFsError({
            operation: 'read_directory',
            path: current,
            cause,
            message: `Failed to read directory ${current}`,
          }),
        ),
      )
      for (const entry of entries) {
        if (SKIPPED_DIRECTORIES.has(entry) === true) continue

        const fullPath = platformPath.join(current, entry)
        const info = yield* fs.stat(fullPath).pipe(
          Effect.mapError((cause) =>
            makeFsError({
              operation: 'stat',
              path: fullPath,
              cause,
              message: `Failed to stat ${fullPath}`,
            }),
          ),
        )

        if (info.type === 'Directory') {
          directories.push(fullPath)
          continue
        }

        if (entry.endsWith('.nmd') === true) {
          discovered.push(fullPath)
        }
      }
    }

    return uniqueSorted(discovered.map((itemPath) => resolve(itemPath)))
  })

/** Resolve explicit file targets and recursive directory targets into `.nmd` paths. */
export const resolveNmdTargets = (
  opts: ResolveTargetsOptions,
): Effect.Effect<ResolveTargetsResult, NmdCliError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    if (opts.targets.length === 0) {
      return yield* new NmdCliError({ message: 'At least one .nmd file or directory is required' })
    }

    const fs = yield* FileSystem.FileSystem
    const operation = opts.operation ?? 'sync'
    const paths: string[] = []
    const errors: BatchFailure[] = []

    for (const target of opts.targets) {
      const absoluteTarget = resolve(target)
      const info = yield* fs.stat(target).pipe(Effect.either)
      if (info._tag === 'Left') {
        errors.push(
          failure({
            operation,
            path: target,
            error: makeFsError({
              operation: 'stat',
              path: target,
              cause: info.left,
              message: `Failed to stat ${target}`,
            }),
          }),
        )
        continue
      }

      if (info.right.type === 'Directory') {
        if (opts.recursive !== true) {
          errors.push(
            failure({
              operation,
              path: target,
              error: new NmdCliError({
                message: `Directory target ${target} requires --recursive`,
              }),
            }),
          )
          continue
        }

        const discovered = yield* discoverDirectory({ root: target }).pipe(Effect.either)
        if (discovered._tag === 'Left') {
          errors.push(failure({ operation, path: target, error: discovered.left }))
          continue
        }
        paths.push(...discovered.right)
        continue
      }

      if (basename(target).endsWith('.nmd') !== true) {
        errors.push(
          failure({
            operation,
            path: target,
            error: new NmdCliError({ message: `Target ${target} is not a .nmd file` }),
          }),
        )
        continue
      }

      paths.push(absoluteTarget)
    }

    return { paths: uniqueSorted(paths), errors }
  })

const preflightPageIds = (opts: {
  readonly operation: BatchOperation
  readonly paths: readonly string[]
}): Effect.Effect<
  {
    readonly runnablePaths: readonly string[]
    readonly errors: readonly BatchFailure[]
  },
  never,
  NmdStateStore
> =>
  Effect.gen(function* () {
    const store = yield* NmdStateStore
    const parsed = yield* Effect.forEach(
      opts.paths,
      (path) =>
        store.readNmdFile({ path }).pipe(
          Effect.flatMap((content) => parseNmdFile({ path, content })),
          Effect.either,
          Effect.map((result) => ({ path, result })),
        ),
      { concurrency: DEFAULT_BATCH_CONCURRENCY },
    )

    const errors: BatchFailure[] = []
    const pageIds = new Map<string, string[]>()

    for (const item of parsed) {
      if (item.result._tag === 'Left') {
        errors.push(
          failure({ operation: opts.operation, path: item.path, error: item.result.left }),
        )
        continue
      }

      const pageId = item.result.right.frontmatter.notion_md.page_id
      pageIds.set(pageId, [...(pageIds.get(pageId) ?? []), item.path])
    }

    const duplicatePaths = new Set<string>()
    for (const [pageId, paths] of pageIds) {
      if (paths.length <= 1) continue
      for (const path of paths) {
        duplicatePaths.add(path)
        errors.push(
          failure({
            operation: opts.operation,
            path,
            error: new NmdCliError({
              message: `Notion page ${pageId} is referenced by multiple .nmd files in the same batch`,
            }),
          }),
        )
      }
    }

    return {
      runnablePaths: opts.paths.filter(
        (path) =>
          duplicatePaths.has(path) === false &&
          errors.some((error) => error.path === path) === false,
      ),
      errors,
    }
  })

const runBatch = <A>(opts: {
  readonly operation: BatchOperation
  readonly targets: readonly string[]
  readonly recursive?: boolean | undefined
  readonly concurrency?: number | undefined
  readonly run: (path: string) => Effect.Effect<A, NmdError, NotionMdGateway | NmdStateStore>
}): Effect.Effect<
  BatchResult<A>,
  NmdCliError,
  FileSystem.FileSystem | Path.Path | NotionMdGateway | NmdStateStore
> =>
  Effect.gen(function* () {
    const resolved = yield* resolveNmdTargets({
      targets: opts.targets,
      ...(opts.recursive === undefined ? {} : { recursive: opts.recursive }),
      operation: opts.operation,
    })
    const preflight = yield* preflightPageIds({
      operation: opts.operation,
      paths: resolved.paths,
    })

    const operationItems = yield* Effect.forEach(
      preflight.runnablePaths,
      (path) =>
        opts.run(path).pipe(
          Effect.map((result) => success({ operation: opts.operation, path, result })),
          Effect.catchAll((error) =>
            Effect.succeed(failure({ operation: opts.operation, path, error })),
          ),
        ),
      { concurrency: opts.concurrency ?? DEFAULT_BATCH_CONCURRENCY },
    )

    return batchResult({
      operation: opts.operation,
      items: [...resolved.errors, ...preflight.errors, ...operationItems],
    })
  }).pipe(
    Effect.withSpan(`notion-md.${opts.operation}-many`, {
      attributes: {
        'span.label': `${opts.targets.length} target(s)`,
        'notion_md.command': opts.operation,
        'notion_md.batch': true,
        'notion_md.batch.target_count': opts.targets.length,
        'notion_md.batch.recursive': opts.recursive === true,
      },
    }),
  )

/** Compare multiple local `.nmd` files with their remote Notion pages. */
export const statusMany = (
  opts: StatusManyOptions,
): Effect.Effect<
  BatchResult<StatusResult>,
  NmdCliError,
  FileSystem.FileSystem | Path.Path | NotionMdGateway | NmdStateStore
> =>
  runBatch({
    operation: 'status',
    targets: opts.targets,
    ...(opts.recursive === undefined ? {} : { recursive: opts.recursive }),
    ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }),
    run: (path) => statusPage({ path }),
  })

/** Push guarded local edits from multiple `.nmd` files. */
export const pushMany = (
  opts: PushManyOptions,
): Effect.Effect<
  BatchResult<PushResult>,
  NmdCliError,
  FileSystem.FileSystem | Path.Path | NotionMdGateway | NmdStateStore
> =>
  runBatch({
    operation: 'push',
    targets: opts.targets,
    ...(opts.recursive === undefined ? {} : { recursive: opts.recursive }),
    ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }),
    run: (path) =>
      pushPage({
        path,
        ...(opts.force === undefined ? {} : { force: opts.force }),
        ...(opts.allowDeletingUnknownBlocks === undefined
          ? {}
          : { allowDeletingUnknownBlocks: opts.allowDeletingUnknownBlocks }),
        ...(opts.allowReviewMarkup === undefined
          ? {}
          : { allowReviewMarkup: opts.allowReviewMarkup }),
      }),
  })

/** Run one guarded reconciliation pass for multiple `.nmd` files. */
export const syncMany = (
  opts: SyncManyOptions,
): Effect.Effect<
  BatchResult<SyncResult>,
  NmdCliError,
  FileSystem.FileSystem | Path.Path | NotionMdGateway | NmdStateStore
> =>
  runBatch({
    operation: 'sync',
    targets: opts.targets,
    ...(opts.recursive === undefined ? {} : { recursive: opts.recursive }),
    ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }),
    run: (path) =>
      syncPage({
        path,
        ...(opts.force === undefined ? {} : { force: opts.force }),
        ...(opts.allowDeletingUnknownBlocks === undefined
          ? {}
          : { allowDeletingUnknownBlocks: opts.allowDeletingUnknownBlocks }),
        ...(opts.allowReviewMarkup === undefined
          ? {}
          : { allowReviewMarkup: opts.allowReviewMarkup }),
      }),
  })

const reasonRank = (reason: WatchReason): number => {
  switch (reason) {
    case 'initial':
      return 0
    case 'poll':
      return 1
    case 'file':
      return 2
  }
}

const coalesceTriggers = (triggers: Iterable<WatchTrigger>): readonly WatchTrigger[] => {
  const byPath = new Map<string, WatchReason>()
  for (const trigger of triggers) {
    const current = byPath.get(trigger.path)
    if (current === undefined || reasonRank(trigger.reason) >= reasonRank(current)) {
      byPath.set(trigger.path, trigger.reason)
    }
  }
  return [...byPath.entries()]
    .map(([path, reason]) => ({ path, reason }))
    .toSorted((left, right) => left.path.localeCompare(right.path))
}

const writeJsonLine = (value: unknown): Effect.Effect<void> =>
  Effect.sync(() => {
    console.log(JSON.stringify(value))
  })

const watchErrorJson = (error: unknown): Record<string, unknown> => {
  if (typeof error === 'object' && error !== null && '_tag' in error) {
    const tagged = error as {
      readonly _tag?: unknown
      readonly message?: unknown
      readonly path?: unknown
      readonly operation?: unknown
    }
    return Object.fromEntries(
      Object.entries({
        _tag: tagged._tag,
        message: tagged.message,
        path: tagged.path,
        operation: tagged.operation,
      }).filter(([, value]) => value !== undefined),
    )
  }
  if (error instanceof Error) return { name: error.name, message: error.message }
  return { message: String(error) }
}

/** Watch a resolved set of `.nmd` files and run coalesced batch sync passes. */
export const runBatchWatch = (
  opts: BatchWatchOptions,
): Effect.Effect<
  never,
  never,
  FileSystem.FileSystem | Path.Path | NotionMdGateway | NmdStateStore
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const queue = yield* Queue.sliding<WatchTrigger>(4096)
      const emit = opts.emit ?? writeJsonLine
      const paths = uniqueSorted(opts.paths.map((path) => resolve(path)))
      const watchedPaths = new Set(paths)
      const watchedDirs = uniqueSorted(paths.map((path) => dirname(path)))

      yield* Effect.forEach(paths, (path) => Queue.offer(queue, { path, reason: 'initial' }))

      for (const watchedDir of watchedDirs) {
        yield* Effect.forkScoped(
          fs.watch(watchedDir).pipe(
            Stream.filter((event) => watchedPaths.has(resolve(watchedDir, event.path))),
            Stream.runForEach((event) =>
              Queue.offer(queue, {
                path: resolve(watchedDir, event.path),
                reason: 'file',
              }),
            ),
            Effect.catchAll((error) =>
              emit({
                event: 'watch_error',
                path: watchedDir,
                error: watchErrorJson(error),
              }),
            ),
          ),
        )
      }

      yield* Effect.forkScoped(
        Effect.forever(
          Effect.sleep(Duration.millis(opts.pollIntervalMs)).pipe(
            Effect.zipRight(
              Effect.forEach(paths, (path) => Queue.offer(queue, { path, reason: 'poll' })),
            ),
          ),
        ),
      )

      return yield* Effect.forever(
        Effect.gen(function* () {
          const first = yield* Queue.take(queue)
          yield* Effect.sleep(WATCH_DEBOUNCE)
          const rest = yield* Queue.takeAll(queue)
          const triggers = coalesceTriggers([first, ...rest])
          const batch = yield* syncMany({
            targets: triggers.map((trigger) => trigger.path),
            ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }),
            ...(opts.force === undefined ? {} : { force: opts.force }),
            ...(opts.allowDeletingUnknownBlocks === undefined
              ? {}
              : { allowDeletingUnknownBlocks: opts.allowDeletingUnknownBlocks }),
            ...(opts.allowReviewMarkup === undefined
              ? {}
              : { allowReviewMarkup: opts.allowReviewMarkup }),
          })
          yield* emit({
            event: 'sync',
            reason: triggers.length === 1 ? triggers[0]?.reason : 'batch',
            paths: triggers.map((trigger) => trigger.path),
            result: batch,
          })
        }).pipe(
          Effect.catchAll((error) =>
            emit({
              event: 'sync_error',
              reason: 'batch',
              error: watchErrorJson(error),
            }),
          ),
        ),
      )
    }),
  ).pipe(
    Effect.withSpan('notion-md.batch-watch', {
      attributes: {
        'span.label': `${opts.paths.length} file(s)`,
        'notion_md.command': 'sync',
        'notion_md.watch': true,
        'notion_md.batch': true,
        'notion_md.batch.path_count': opts.paths.length,
      },
    }),
  )

/** Return whether CLI targets should preserve the legacy single-file output shape. */
export const isSingleFileTarget = (opts: {
  readonly targets: readonly string[]
  readonly recursive?: boolean
}): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (opts.recursive === true || opts.targets.length !== 1) return false
    const fs = yield* FileSystem.FileSystem
    const info = yield* fs.stat(opts.targets[0] ?? '').pipe(Effect.either)
    return info._tag === 'Right' && info.right.type !== 'Directory'
  })
