import { basename, dirname, resolve } from 'node:path'

import { Args, Command, Options } from 'effect/unstable/cli'
import { FetchHttpClient, FileSystem, Path } from '@effect/platform'
import { Cause, Console, Duration, Effect, Layer, Option, Queue, Schema, Stream } from 'effect'

import {
  NMD_SYNC_DIRECTORY,
  NotionConfigLive,
  NmdSyncStateV1Schema,
  resolveNotionToken,
  type NmdSyncStateV1,
} from '@overeng/notion-effect-client'
import { parseNotionUuid } from '@overeng/notion-effect-schema'
import { resolveCliVersion } from '@overeng/utils/node/cli-version'

import { resolveNmdTargets, runBatchWatch, type BatchFailure } from './batch.ts'
import {
  catEditorPage,
  editEditorPage,
  editReadOnlyPage,
  putEditorPage,
  type EditorMode,
} from './editor-commands.ts'
import {
  NmdCliError,
  NmdFileSystemError,
  NmdObjectStoreError,
  NmdTokenMissingError,
  NmdUnresolvablePageError,
} from './errors.ts'
import { NotionMdGatewayLive } from './live.ts'
import type { NotionMdGateway } from './model.ts'
import {
  annotateAttrs,
  cliCommandSpan,
  ObjectGcSpan,
  objectGcResultAttrs,
  watchSyncErrorAttrs,
  watchSyncResultAttrs,
  WatchSpan,
  WatchSyncPassSpan,
  withOperation,
  withRootOperation,
} from './observability.ts'
import { ProgressReporterStderrLines } from './progress.ts'
import { reconcileFile, reconcileTree, statusTree, trackPage } from './reconcile.ts'
import {
  garbageCollectObjects,
  NmdStateStoreLive,
  stateRootPath,
  type NmdStateStore,
  type NmdObjectGcResult,
} from './state-store.ts'
import type { SyncOptions } from './sync.ts'
import { NOTION_MD_VERSION } from './version.ts'

const NonEmptyCliText = Schema.NonEmptyTrimmedString.annotations({
  identifier: 'NotionMd.Cli.NonEmptyText',
})

const PositiveInteger = Schema.Number.pipe(Schema.int(), Schema.positive()).annotations({
  identifier: 'NotionMd.Cli.PositiveInteger',
})

/*
 * The decided v-next surface (spec "Decided surface"): three near-flagless
 * verbs `track` / `status` / `sync` over self-describing files. Direction and
 * identity live in each file's frontmatter (`source`/`page_id`), never in
 * flags. `track` is the ONLY command taking a page id.
 */

/** Local `.nmd` paths (file or directory). `status`/`sync` take only local paths. */
const localTargetsArg = Args.text({ name: 'path' }).pipe(
  Args.withDescription('Local .nmd file or directory (a directory means everything under it)'),
  Args.withSchema(NonEmptyCliText),
  Args.atLeast(1),
)

/** `track` is the only command that takes a Notion page id/url. */
const trackPageRefArg = Args.text({ name: 'page-id-or-url' }).pipe(
  Args.withDescription('Notion page id or URL to track'),
  Args.withSchema(NonEmptyCliText),
)

const trackOutPathArg = Args.text({ name: 'path' }).pipe(
  Args.withDescription('Local .nmd file to write (default: <page-id>.nmd)'),
  Args.withSchema(NonEmptyCliText),
  Args.optional,
)

const SourceLiteral = Schema.Literal('local', 'remote', 'shared').annotations({
  identifier: 'NotionMd.Cli.Source',
})

const trackAsOption = Options.text('as').pipe(
  Options.withDescription(
    'Sync direction to record (local|remote|shared); default remote — this tracks existing Notion state',
  ),
  Options.withSchema(SourceLiteral),
  Options.withDefault('remote'),
)

const dryRunOption = Options.boolean('dry-run').pipe(
  Options.withDescription('Plan and validate without writing local files, sidecars, or Notion'),
  Options.withDefault(false),
)

const forceOption = Options.boolean('force').pipe(
  Options.withDescription(
    'Override a `shared` 3-way-merge divergence (local wins). Inert on single-source files',
  ),
  Options.withDefault(false),
)

const allowDeleteUnknownBlocksOption = Options.boolean('allow-delete-unknown-blocks').pipe(
  Options.withDescription(
    'Explicit destructive mode: allow a body write that may delete unresolved unsupported Notion blocks',
  ),
  Options.withDefault(false),
)

const allowReviewMarkupOption = Options.boolean('allow-review-markup').pipe(
  Options.withDescription(
    'Explicit destructive mode: allow unresolved Roughdraft review markup to be written as literal Notion body content',
  ),
  Options.withDefault(false),
)

const gcObjectsOption = Options.boolean('gc-objects').pipe(
  Options.withDescription(
    'After validation, remove unreachable .notion-md/objects files; with --dry-run, report the GC plan only',
  ),
  Options.withDefault(false),
)

/*
 * TODO(phase-5-dry-run-convention): The standalone `gc` command defaults to
 * dry-run (plan-only) and requires an explicit `--prune` flag to delete.
 * Phase 5 will normalize the global `--dry-run` convention; at that point this
 * per-command `--prune` flag should be reconciled with the global convention.
 * For now, default-dry-run + explicit-prune is the safe interim (R15).
 */
const pruneOption = Options.boolean('prune').pipe(
  Options.withDescription(
    'Actually delete unreachable .notion-md/objects files (default: plan-only, no deletion)',
  ),
  Options.withDefault(false),
)

const watchOption = Options.boolean('watch').pipe(
  Options.withDescription('Continuously sync after local file changes and remote polling'),
  Options.withDefault(false),
)

const pollIntervalMsOption = Options.integer('poll-interval-ms').pipe(
  Options.withDescription('Remote polling interval in milliseconds for --watch'),
  Options.withDefault(30_000),
  Options.withSchema(PositiveInteger),
)

const recursiveOption = Options.boolean('recursive').pipe(
  Options.withAlias('r'),
  Options.withDescription('Discover existing .nmd files recursively under a directory target'),
  Options.withDefault(false),
)

const concurrencyOption = Options.integer('concurrency').pipe(
  Options.withDescription('Maximum number of .nmd files to reconcile concurrently'),
  Options.withDefault(4),
  Options.withSchema(PositiveInteger),
)

const jsonOption = Options.boolean('json').pipe(
  Options.withDescription('Emit machine-readable JSON instead of git-porcelain text'),
  Options.withDefault(false),
)

const buildStamp = '__CLI_BUILD_STAMP__'
/** Resolved CLI build-version identity, reused by the binary edge to stamp telemetry. */
export const cliVersion = resolveCliVersion({
  baseVersion: NOTION_MD_VERSION,
  buildStamp,
})

const resolveToken = resolveNotionToken().pipe(
  Effect.mapError(
    () =>
      new NmdTokenMissingError({
        message: 'NOTION_API_TOKEN is required',
      }),
  ),
)

/** Live Notion gateway layer assembled from the process Notion token. */
export const MainLayer = Layer.unwrapEffect(
  resolveToken.pipe(
    Effect.map((token) => {
      const baseLayer = Layer.mergeAll(
        NotionConfigLive({ authToken: token }),
        FetchHttpClient.layer,
      )

      return Layer.mergeAll(
        baseLayer,
        NotionMdGatewayLive.pipe(Layer.provide(baseLayer)),
        NmdStateStoreLive,
      ).pipe(Layer.provideMerge(Path.layer))
    }),
  ),
)

const withNotion = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  resolveToken.pipe(Effect.zipRight(Effect.provide(effect, MainLayer)))

const logJson = (value: unknown): Effect.Effect<void> => Console.log(JSON.stringify(value, null, 2))

const parseNotionPageRef = (value: string): string | undefined => parseNotionUuid(value)

const safeJsonError = (error: unknown): Record<string, unknown> => {
  if (typeof error === 'object' && error !== null && '_tag' in error) {
    const tagged = error as {
      readonly _tag?: unknown
      readonly message?: unknown
      readonly path?: unknown
      readonly page_id?: unknown
      readonly conflict_path?: unknown
      readonly object_path?: unknown
      readonly operation?: unknown
      readonly block_id?: unknown
      readonly guard?: unknown
      readonly fileIds?: unknown
      readonly allowFlag?: unknown
    }
    return Object.fromEntries(
      Object.entries({
        _tag: tagged._tag,
        message: typeof tagged.message === 'string' ? tagged.message : String(error),
        path: tagged.path,
        page_id: tagged.page_id,
        conflict_path: tagged.conflict_path,
        object_path: tagged.object_path,
        operation: tagged.operation,
        block_id: tagged.block_id,
        guard: tagged.guard,
        fileIds: tagged.fileIds,
        allowFlag: tagged.allowFlag,
      }).filter(([, value]) => value !== undefined),
    )
  }
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    }
  }
  return { message: String(error) }
}

/** Returns ` [GuardName]` when the error carries a named guard, otherwise `''`. */
const guardSuffix = (error: unknown): string => {
  if (
    typeof error === 'object' &&
    error !== null &&
    'guard' in error &&
    typeof (error as { guard: unknown }).guard === 'string'
  ) {
    return ` [${(error as { guard: string }).guard}]`
  }
  return ''
}

const writeJsonLine = (value: unknown): Effect.Effect<void> => Console.log(JSON.stringify(value))

type WatchReason = 'file' | 'initial' | 'poll'

interface WatchTrigger {
  readonly reason: WatchReason
}

const nextWatchReason = (opts: {
  readonly initial: WatchTrigger
  readonly pending: Iterable<WatchTrigger>
}): WatchReason => {
  let reason = opts.initial.reason
  for (const event of opts.pending) {
    reason = event.reason
  }
  return reason
}

/** Run continuous one-file sync with debounced local changes and remote polling. */
export const runWatch = (opts: {
  readonly syncOptions: SyncOptions
  readonly pollIntervalMs: number
  readonly emit?: (value: unknown) => Effect.Effect<void>
}): Effect.Effect<never, never, FileSystem.FileSystem | NotionMdGateway | NmdStateStore> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const queue = yield* Queue.sliding<WatchTrigger>(1024)
      const emit = opts.emit ?? writeJsonLine
      const path = opts.syncOptions.path
      const watchedFile = basename(path)
      const watchedDir = dirname(path)
      const watchedPath = resolve(path)

      const pass = (reason: WatchReason) =>
        reconcileFile(opts.syncOptions).pipe(
          Effect.tap((result) =>
            annotateAttrs({
              attributes: watchSyncResultAttrs,
              value: {
                result: result._tag,
                reason,
              },
            }),
          ),
          Effect.tap((result) => emit({ event: 'sync', reason, result })),
          Effect.tapError((error: unknown) =>
            annotateAttrs({
              attributes: watchSyncErrorAttrs,
              value: {
                error: true,
                errorTag:
                  typeof error === 'object' && error !== null && '_tag' in error
                    ? String((error as { readonly _tag?: unknown })._tag)
                    : error instanceof Error
                      ? error.name
                      : 'unknown',
              },
            }),
          ),
          withRootOperation({
            operation: WatchSyncPassSpan,
            attributes: {
              command: 'sync',
              watch: true,
              reason,
              basename: watchedFile,
            },
          }),
          Effect.catchAll((error: unknown) =>
            emit({ event: 'sync_error', reason, error: safeJsonError(error) }),
          ),
        )

      const initialEvents = Stream.succeed<WatchTrigger>({ reason: 'initial' })
      const fileEvents = fs.watch(watchedDir).pipe(
        Stream.filter((event) => resolve(watchedDir, event.path) === watchedPath),
        Stream.map((): WatchTrigger => ({ reason: 'file' })),
        Stream.catchAll((error) =>
          Stream.fromEffect(
            emit({ event: 'watch_error', path, error: safeJsonError(error) }).pipe(
              Effect.as<WatchTrigger>({ reason: 'poll' }),
            ),
          ),
        ),
      )
      const pollEvents = Effect.forever(
        Effect.sleep(Duration.millis(opts.pollIntervalMs)).pipe(
          Effect.zipRight(Queue.offer(queue, { reason: 'poll' })),
        ),
      )

      yield* Effect.forkScoped(
        Stream.mergeAll([initialEvents, fileEvents], { concurrency: 'unbounded' }).pipe(
          Stream.runForEach((event) => Queue.offer(queue, event)),
        ),
      )
      yield* Effect.forkScoped(pollEvents)

      return yield* Effect.forever(
        Effect.gen(function* () {
          const initial = yield* Queue.take(queue)
          yield* Effect.sleep(Duration.millis(250))
          const pending = yield* Queue.takeAll(queue)
          yield* pass(nextWatchReason({ initial, pending }))
        }),
      )
    }),
  ).pipe(
    withOperation({
      operation: WatchSpan,
      attributes: {
        command: 'sync',
        watch: true,
        basename: basename(opts.syncOptions.path),
      },
    }),
  )

const commandSpan = <A, E, R>(opts: {
  readonly command: string
  readonly label: string
  readonly effect: Effect.Effect<A, E, R>
}): Effect.Effect<A, E, R> =>
  opts.effect.pipe(
    withOperation({
      operation: cliCommandSpan(opts.command),
      attributes: {
        label: opts.label,
        command: opts.command,
      },
    }),
  )

const parseNotionPageRefOrFail = (value: string): Effect.Effect<string, NmdCliError> => {
  const parsed = parseNotionPageRef(value)
  return parsed === undefined
    ? Effect.fail(
        new NmdCliError({
          message: `Invalid Notion page id/url: ${value} (track takes a page id, status/sync take local paths)`,
        }),
      )
    : Effect.succeed(parsed)
}

/*
 * Direction is each file's `source`; there is deliberately no push/pull verb.
 * `status` and `sync` surface this one-line explainer (spec git-native framing).
 */
const directionExplainer =
  "no push/pull — direction is each file's `source`; `sync` always moves toward in-sync, `source` decides which way."

const porcelainLine = (status: { readonly path: string; readonly status: string }): string =>
  `${status.status.padEnd(12)} ${basename(status.path)}`

const renderStatus = (opts: {
  readonly json: boolean
  readonly results: ReadonlyArray<{ readonly path: string; readonly status: string }>
}): Effect.Effect<void> =>
  opts.json === true
    ? logJson(opts.results)
    : Effect.gen(function* () {
        for (const r of opts.results) yield* Console.log(porcelainLine(r))
        yield* Console.log('')
        yield* Console.log(directionExplainer)
      })

/** `track <id|url> [path]` — bootstrap a local file/subtree from an existing Notion page. */
const trackCommand = Command.make(
  'track',
  {
    pageRef: trackPageRefArg,
    out: trackOutPathArg,
    as: trackAsOption,
    dryRun: dryRunOption,
  },
  ({ pageRef, out, as, dryRun }) =>
    commandSpan({
      command: 'track',
      label: pageRef.slice(0, 8),
      effect: parseNotionPageRefOrFail(pageRef).pipe(
        Effect.flatMap((pageId) => {
          const outPath = Option.isSome(out) === true ? out.value : `${pageId}.nmd`
          return withNotion(
            trackPage({ pageId, outPath, source: as, dryRun }).pipe(
              Effect.map((result): unknown => result),
            ),
          )
        }),
      ),
    }).pipe(Effect.flatMap(logJson)),
).pipe(
  Command.withDescription(
    'Track an existing Notion page as a local .nmd file (the only command taking a page id)',
  ),
)

/** Resolve a single local path or a flat recursive batch into the run targets. */
const targetsFor = (opts: {
  readonly paths: readonly string[]
  readonly recursive: boolean
}): Effect.Effect<readonly string[], NmdCliError, FileSystem.FileSystem | Path.Path> =>
  resolveNmdTargets({ targets: opts.paths, recursive: opts.recursive, operation: 'status' }).pipe(
    Effect.map((resolved) => resolved.paths),
  )

/** `status [path...]` — read-only, safe by construction. */
const statusCommand = Command.make(
  'status',
  {
    paths: localTargetsArg,
    recursive: recursiveOption,
    concurrency: concurrencyOption,
    json: jsonOption,
  },
  ({ paths, recursive, concurrency, json }) =>
    commandSpan({
      command: 'status',
      label: paths.length === 1 ? basename(paths[0] ?? 'target') : `${paths.length} targets`,
      effect: withNotion(
        statusTree({ targets: paths, recursive, concurrency }).pipe(
          Effect.flatMap((batch) =>
            renderStatus({
              json,
              results: batch.items.flatMap((item) =>
                item._tag === 'success'
                  ? [{ path: item.result.path, status: item.result.status }]
                  : [{ path: item.path, status: 'error' }],
              ),
            }),
          ),
        ),
      ),
    }),
).pipe(
  Command.withDescription(
    'Read-only: report the live in-sync decision per file in git-porcelain words (never mutates)',
  ),
)

/** `sync [path...]` — reconcile self-describing files; dispatch per file on `source`. */
const syncCommand = Command.make(
  'sync',
  {
    paths: localTargetsArg,
    watch: watchOption,
    pollIntervalMs: pollIntervalMsOption,
    recursive: recursiveOption,
    concurrency: concurrencyOption,
    force: forceOption,
    allowDeleteUnknownBlocks: allowDeleteUnknownBlocksOption,
    allowReviewMarkup: allowReviewMarkupOption,
    gcObjects: gcObjectsOption,
    dryRun: dryRunOption,
    json: jsonOption,
  },
  ({
    paths,
    watch,
    pollIntervalMs,
    recursive,
    concurrency,
    force,
    allowDeleteUnknownBlocks,
    allowReviewMarkup,
    gcObjects,
    dryRun,
    json,
  }) => {
    if (watch === true) {
      const syncOptions: SyncOptions = {
        path: paths[0] ?? '',
        force,
        dryRun,
        allowDeletingUnknownBlocks: allowDeleteUnknownBlocks,
        allowReviewMarkup,
      }
      return paths.length === 1
        ? withNotion(
            runWatch({
              syncOptions: { ...syncOptions, gcObjects } as SyncOptions,
              pollIntervalMs,
            }),
          )
        : withNotion(
            targetsFor({ paths, recursive }).pipe(
              Effect.flatMap((resolved) =>
                resolved.length === 0
                  ? Effect.fail(
                      new NmdCliError({
                        message: 'No .nmd files matched the requested watch targets',
                      }),
                    )
                  : runBatchWatch({
                      paths: resolved,
                      concurrency,
                      pollIntervalMs,
                      force,
                      dryRun,
                      runSyncMany: (batchOpts) =>
                        reconcileTree({
                          targets: batchOpts.targets,
                          ...(batchOpts.concurrency === undefined
                            ? {}
                            : { concurrency: batchOpts.concurrency }),
                          ...(batchOpts.force === undefined ? {} : { force: batchOpts.force }),
                          ...(batchOpts.dryRun === undefined ? {} : { dryRun: batchOpts.dryRun }),
                          allowDeletingUnknownBlocks: allowDeleteUnknownBlocks,
                          allowReviewMarkup,
                          gcObjects,
                        }),
                    }),
              ),
            ),
          )
    }

    return commandSpan({
      command: 'sync',
      label: paths.length === 1 ? basename(paths[0] ?? 'target') : `${paths.length} targets`,
      effect: withNotion(
        reconcileTree({
          targets: paths,
          recursive,
          concurrency,
          force,
          allowDeletingUnknownBlocks: allowDeleteUnknownBlocks,
          allowReviewMarkup,
          gcObjects,
          dryRun,
        }).pipe(
          Effect.flatMap((batch) =>
            json === true
              ? logJson(batch)
              : Effect.gen(function* () {
                  for (const item of batch.items) {
                    yield* Console.log(
                      item._tag === 'success'
                        ? `${item.result._tag.padEnd(16)} ${basename(item.result.path)}`
                        : `error            ${basename(item.path)}${guardSuffix(item.error)}`,
                    )
                  }
                  yield* Console.log('')
                  yield* Console.log(directionExplainer)
                }),
          ),
        ),
      ),
    })
  },
).pipe(
  Command.withDescription(
    'Reconcile self-describing .nmd files toward in-sync; dispatch per file on frontmatter `source`',
  ),
)

// ---------------------------------------------------------------------------
// Local object-store GC
// ---------------------------------------------------------------------------

/**
 * Token-free layer for the `gc` command: only NmdStateStore + filesystem.
 * GC is a local-only operation and must not require NOTION_API_TOKEN.
 */
const GcLayer = NmdStateStoreLive.pipe(Layer.provideMerge(Path.layer))

const withGc = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provide(effect, GcLayer)

/**
 * Read all sync states that exist on disk under the `.notion-md/sync/` directory
 * adjacent to the given `.nmd` file path. This is the correct set to pass to
 * `garbageCollectObjects` for that state root so we never mark live sibling
 * objects as unreachable.
 *
 * @internal exported for testing
 */
export const readAllSyncStates = (
  nmdPath: string,
): Effect.Effect<
  readonly NmdSyncStateV1[],
  NmdFileSystemError | NmdObjectStoreError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const syncDir = path.join(path.dirname(nmdPath), NMD_SYNC_DIRECTORY)
    const exists = yield* fs.exists(syncDir).pipe(
      Effect.mapError(
        (cause) =>
          new NmdFileSystemError({
            operation: 'gc_probe_sync_dir',
            path: syncDir,
            cause,
            message: `Failed to probe .notion-md/sync directory ${syncDir}`,
          }),
      ),
    )
    if (exists === false) return []
    const entries = yield* fs.readDirectory(syncDir).pipe(
      Effect.mapError(
        (cause) =>
          new NmdFileSystemError({
            operation: 'gc_list_sync_dir',
            path: syncDir,
            cause,
            message: `Failed to list .notion-md/sync directory ${syncDir}`,
          }),
      ),
    )
    const strictOptions = { errors: 'all', onExcessProperty: 'error' } as const
    const decodeSyncState = Schema.decodeUnknown(
      Schema.parseJson(NmdSyncStateV1Schema),
      strictOptions,
    )
    const syncStates: NmdSyncStateV1[] = []
    for (const entry of entries) {
      if (entry.endsWith('.json') === false) continue
      const fullPath = path.join(syncDir, entry)
      const content = yield* fs.readFileString(fullPath).pipe(
        Effect.mapError(
          (cause) =>
            new NmdFileSystemError({
              operation: 'gc_read_sync_state',
              path: fullPath,
              cause,
              message: `Failed to read sync state ${fullPath}`,
            }),
        ),
      )
      const decoded = yield* decodeSyncState(content).pipe(
        Effect.mapError(
          (cause) =>
            new NmdObjectStoreError({
              path: nmdPath,
              object_path: fullPath,
              cause,
              message: `Failed to parse sync state ${fullPath}`,
            }),
        ),
      )
      syncStates.push(decoded)
    }
    return syncStates
  })

/** Render a target-resolution failure as a single readable line for gc output. */
const formatTargetFailure = (failure: BatchFailure): string => {
  const detail = safeJsonError(failure.error)
  const message = typeof detail.message === 'string' ? detail.message : String(failure.error)
  return `gc: skipped ${failure.path}: ${message}`
}

/**
 * GC result for one state root: the root path, reachable/removed counts, and
 * the removed file list.
 */
interface GcRootResult {
  readonly root: string
  readonly reachableCount: number
  readonly removed: readonly string[]
  readonly dryRun: boolean
}

/**
 * Collect GC results across all unique state roots implied by the target paths.
 * Each target maps to one state root (its parent directory + `.notion-md/`).
 * We group targets by unique state root so we can pass the complete syncStates
 * for that root to `garbageCollectObjects` — never a partial per-file subset,
 * which would misclassify sibling objects as unreachable.
 */
const gcNmdTargets = (opts: {
  readonly paths: readonly string[]
  readonly recursive: boolean
  readonly dryRun: boolean
}): Effect.Effect<
  readonly GcRootResult[],
  NmdCliError | NmdFileSystemError | NmdObjectStoreError,
  FileSystem.FileSystem | Path.Path | NmdStateStore
> =>
  Effect.gen(function* () {
    const resolved = yield* resolveNmdTargets({
      targets: opts.paths,
      recursive: opts.recursive,
      operation: 'sync',
    })

    // Surface target-resolution failures rather than silently dropping them —
    // gc is deletion-adjacent, so a mistyped/nonexistent path, a non-`.nmd`
    // file, or an un-`--recursive` directory must never resolve to a quiet
    // no-op. We log every error and fail-fast when nothing valid remains.
    for (const failure of resolved.errors) {
      yield* Console.error(formatTargetFailure(failure))
    }
    if (resolved.paths.length === 0) {
      return yield* new NmdCliError({
        message:
          resolved.errors.length > 0
            ? `gc: no valid .nmd targets — all ${resolved.errors.length} target(s) failed to resolve:\n${resolved.errors
                .map((failure) => `  ${formatTargetFailure(failure)}`)
                .join('\n')}`
            : 'gc: no .nmd targets matched the requested paths',
      })
    }

    // Group resolved .nmd paths by their unique state root (parent dir).
    const rootToNmdPaths = new Map<string, string[]>()
    for (const nmdPath of resolved.paths) {
      const stateRoot = stateRootPath(nmdPath)
      const existing = rootToNmdPaths.get(stateRoot) ?? []
      existing.push(nmdPath)
      rootToNmdPaths.set(stateRoot, existing)
    }

    const results: GcRootResult[] = []
    for (const [, nmdPaths] of rootToNmdPaths) {
      // Use any of the nmd paths — they share the same parent dir, so one
      // representative path is enough to resolve the state root.
      const representativePath = nmdPaths[0]!
      const syncStates = yield* readAllSyncStates(representativePath)

      const gcResult: NmdObjectGcResult = yield* withOperation({
        operation: ObjectGcSpan,
        attributes: {
          dryRun: opts.dryRun,
        },
      })(
        Effect.gen(function* () {
          const result = yield* garbageCollectObjects({
            path: representativePath,
            syncStates,
            dryRun: opts.dryRun,
          })
          yield* annotateAttrs({
            attributes: objectGcResultAttrs,
            value: {
              reachableCount: result.reachable.length,
              removedCount: result.removed.length,
            },
          })
          return result
        }),
      )

      results.push({
        root: gcResult.root,
        reachableCount: gcResult.reachable.length,
        removed: gcResult.removed,
        dryRun: opts.dryRun,
      })
    }
    return results
  })

/** `gc [path...]` — object-store garbage collection; plan-only by default, `--prune` to delete. */
const gcCommand = Command.make(
  'gc',
  {
    paths: localTargetsArg,
    recursive: recursiveOption,
    prune: pruneOption,
  },
  ({ paths, recursive, prune }) => {
    const dryRun = prune === false
    return commandSpan({
      command: 'gc',
      label: paths.length === 1 ? basename(paths[0] ?? 'target') : `${paths.length} targets`,
      effect: withGc(
        gcNmdTargets({ paths, recursive, dryRun }).pipe(
          Effect.flatMap((results) =>
            Effect.gen(function* () {
              for (const r of results) {
                yield* Console.log(`root: ${r.root}`)
                yield* Console.log(`  reachable: ${r.reachableCount}`)
                if (r.removed.length === 0) {
                  yield* Console.log(`  removed:   0 (nothing to remove)`)
                } else {
                  yield* Console.log(`  removed:   ${r.removed.length}`)
                  for (const file of r.removed) {
                    yield* Console.log(`    - ${file}`)
                  }
                }
                if (r.dryRun === true) {
                  yield* Console.log('  (plan only — pass --prune to delete)')
                } else {
                  yield* Console.log('  (objects pruned)')
                }
              }
            }),
          ),
        ),
      ),
    })
  },
).pipe(
  Command.withDescription(
    'Garbage-collect unreachable .notion-md/objects files (dry-run by default; pass --prune to delete)',
  ),
)

// ---------------------------------------------------------------------------
// Editor surfaces: cat / put / edit (VRS "Editor Surfaces")
// ---------------------------------------------------------------------------

const pageArg = Args.text({ name: 'page' }).pipe(
  Args.withDescription('Notion page id, dashed id, or URL'),
  Args.withSchema(NonEmptyCliText),
)

const frontmatterOption = Options.boolean('frontmatter').pipe(
  Options.withDescription(
    'Use the full strict `.nmd` envelope instead of the default `# title` + body',
  ),
  Options.withDefault(false),
)

const baseHashOption = Options.text('base-hash').pipe(
  Options.withDescription('Optimistic-concurrency token from a prior `cat` (guards the write)'),
  Options.optional,
)

const readOnlyOption = Options.boolean('read-only').pipe(
  Options.withDescription(
    'Open the page in $EDITOR for inspection only; discard edits and never push (like `vim -R`)',
  ),
  Options.withDefault(false),
)

/** Resolve a `<page>` token to a Notion page id, failing with exit 4 when unresolvable. */
const resolvePageArg = (page: string): Effect.Effect<string, NmdUnresolvablePageError> => {
  const parsed = parseNotionPageRef(page)
  return parsed === undefined
    ? Effect.fail(
        new NmdUnresolvablePageError({
          page,
          message: `\`${page}\` is not a valid Notion page id, dashed id, or URL.`,
        }),
      )
    : Effect.succeed(parsed)
}

/** Read all of stdin as a UTF-8 string (the `put` body buffer). */
const readStdin = (): Effect.Effect<string> =>
  Effect.async<string>((resume) => {
    const chunks: Buffer[] = []
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk))
    process.stdin.on('end', () => resume(Effect.succeed(Buffer.concat(chunks).toString('utf8'))))
    process.stdin.on('error', () => resume(Effect.succeed(Buffer.concat(chunks).toString('utf8'))))
    process.stdin.resume()
  })

const catCommand = Command.make(
  'cat',
  { page: pageArg, frontmatter: frontmatterOption },
  ({ page, frontmatter }) => {
    const mode: EditorMode = frontmatter === true ? 'frontmatter' : 'default'
    return commandSpan({
      command: 'cat',
      label: basename(page),
      effect: resolvePageArg(page).pipe(
        Effect.flatMap((pageId) => withNotion(catEditorPage({ pageId, mode }))),
        Effect.asVoid,
      ),
    })
  },
).pipe(
  Command.withDescription(
    'Print a Notion page as editor Markdown (`# title` + body) with the base hash on stderr; `--frontmatter` dumps the full `.nmd` envelope',
  ),
)

const putCommand = Command.make(
  'put',
  { page: pageArg, baseHash: baseHashOption, force: forceOption },
  ({ page, baseHash, force }) =>
    commandSpan({
      command: 'put',
      label: basename(page),
      effect: resolvePageArg(page).pipe(
        Effect.flatMap((pageId) =>
          force === false && Option.isNone(baseHash) === true
            ? Effect.fail(
                new NmdCliError({
                  message:
                    'put requires either --base-hash <hash> (guarded; capture it from `cat`) or --force (concurrency override).',
                }),
              )
            : readStdin().pipe(
                Effect.flatMap((buffer) =>
                  withNotion(
                    putEditorPage({
                      pageId,
                      buffer,
                      force,
                      ...(Option.isSome(baseHash) === true
                        ? { baseHash: baseHash.value as never }
                        : {}),
                    }),
                  ),
                ),
              ),
        ),
        Effect.flatMap(logJson),
      ),
    }),
).pipe(
  Command.withDescription(
    'Write editor Markdown from stdin (`# title` + body) back to a Notion page; guarded by --base-hash, or --force to override concurrency',
  ),
)

/**
 * Build the `edit` command. Shared by the `notion-md`/`notion md` subcommand and
 * the top-level `notion edit <page>` alias (R18) so both delegate to the exact
 * same engine-backed session.
 */
const makeEditCommand = (name: string) =>
  Command.make(
    name,
    { page: pageArg, frontmatter: frontmatterOption, readOnly: readOnlyOption },
    ({ page, frontmatter, readOnly }) => {
      const mode: EditorMode = frontmatter === true ? 'frontmatter' : 'default'
      return commandSpan({
        command: 'edit',
        label: basename(page),
        // `edit` exposes no `--force` (force lives on `put`/`sync`), so the
        // documented `--read-only`/`--force` contradiction cannot be expressed
        // here — there is nothing to reject.
        effect: resolvePageArg(page).pipe(
          Effect.flatMap((pageId) =>
            readOnly === true
              ? withNotion(editReadOnlyPage({ pageId, mode })).pipe(
                  Effect.map((result): unknown => result),
                )
              : withNotion(editEditorPage({ pageId, mode, pageRef: page })).pipe(
                  Effect.map((result): unknown => result),
                  /*
                   * Staged write-path progress (R43–R45, decision 0018): wire the
                   * live stderr-line reporter ONLY on the `edit` push path, and
                   * only when stderr is a TTY — a piped/redirected write provides
                   * nothing (Layer.empty → serviceOption None → silent), keeping
                   * the path byte-identical and pipe-safe (R44/R45). Constructed
                   * lazily inside the handler (no TUI graph, no #787 TDZ risk).
                   */
                  Effect.provide(
                    process.stderr.isTTY === true ? ProgressReporterStderrLines : Layer.empty,
                  ),
                ),
          ),
          Effect.flatMap(logJson),
        ),
      })
    },
  ).pipe(
    Command.withDescription(
      'Edit a Notion page in $EDITOR via an ephemeral .nmd session, then push the change through the sync engine; `--read-only` inspects without pushing',
    ),
  )

const editCommand = makeEditCommand('edit')

/**
 * Top-level `notion edit <page>` alias (R18) — the marquee editor verb, wired
 * into the umbrella root alongside `md`/`schema`/`db`. Delegates to the same
 * `editEditorPage` session as `notion md edit`.
 */
export const notionEditAliasCommand = makeEditCommand('edit')

const makeNotionMdCommand = (name: 'md' | 'notion-md') =>
  Command.make(name).pipe(
    Command.withSubcommands([
      trackCommand,
      statusCommand,
      syncCommand,
      gcCommand,
      catCommand,
      putCommand,
      editCommand,
    ]),
    Command.withDescription(
      'Frictionless Notion enhanced Markdown sync, local object GC, and editor surfaces',
    ),
  )

/** Effect CLI command tree for the notion-md binary. */
export const notionMdCommand = makeNotionMdCommand('notion-md')

/** Effect CLI command tree for the umbrella notion binary. */
export const notionMdDispatchCommand = makeNotionMdCommand('md')

/** Process argv runner for the notion-md command tree. */
export const cli = Command.run(notionMdCommand, {
  name: 'notion-md',
  version: cliVersion,
})

/** Render expected CLI failures without duplicating Effect's defect reporter. */
export const renderCliError = (cause: Cause.Cause<unknown>) =>
  Cause.isInterruptedOnly(cause) === true
    ? Effect.void
    : Option.match(Cause.failureOption(cause), {
        onNone: () => Effect.logError(cause),
        onSome: (error) => Effect.logError(error),
      })
