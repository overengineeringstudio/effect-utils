import { basename, dirname, resolve } from 'node:path'

import { Args, Command, Options } from '@effect/cli'
import { FetchHttpClient, FileSystem, Path } from '@effect/platform'
import { Cause, Console, Duration, Effect, Layer, Option, Queue, Schema, Stream } from 'effect'

import { NotionConfigLive, resolveNotionToken } from '@overeng/notion-effect-client'
import { parseNotionUuid } from '@overeng/notion-effect-schema'
import { OtelAttr, OtelAttrs, OtelOperation } from '@overeng/otel-contract'
import { resolveCliVersion } from '@overeng/utils/node/cli-version'

import { resolveNmdTargets, runBatchWatch } from './batch.ts'
import { NmdCliError, NmdTokenMissingError } from './errors.ts'
import { NotionMdGatewayLive } from './live.ts'
import type { NotionMdGateway } from './model.ts'
import { annotateAttrs, withOperation } from './observability.ts'
import { reconcileFile, reconcileTree, statusTree, trackPage } from './reconcile.ts'
import { NmdStateStoreLive, type NmdStateStore } from './state-store.ts'
import type { SyncOptions } from './sync.ts'
import { NOTION_MD_VERSION } from './version.ts'

const NonEmptyCliText = Schema.NonEmptyTrimmedString.annotations({
  identifier: 'NotionMd.Cli.NonEmptyText',
})

const PositiveInteger = Schema.Number.pipe(Schema.int(), Schema.positive()).annotations({
  identifier: 'NotionMd.Cli.PositiveInteger',
})

const WatchReasonSchema = Schema.Literal('file', 'initial', 'poll')

const WatchSyncResultAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    result: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.sync.result' })),
    reason: WatchReasonSchema.pipe(OtelAttr.key({ key: 'notion_md.watch.reason' })),
  }),
)

const WatchSyncErrorAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    error: Schema.Boolean.pipe(OtelAttr.key({ key: 'notion_md.sync.error' })),
    errorTag: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.sync.error_tag' })),
  }),
)

const WatchSyncPassSpan = OtelOperation.define({
  name: 'notion-md.watch.sync-pass',
  root: true,
  schema: Schema.Struct({
    command: Schema.Literal('sync').pipe(OtelAttr.key({ key: 'notion_md.command' })),
    watch: Schema.Boolean.pipe(OtelAttr.key({ key: 'notion_md.watch' })),
    reason: WatchReasonSchema.pipe(OtelAttr.key({ key: 'notion_md.watch.reason' })),
    basename: Schema.NonEmptyString.pipe(OtelAttr.key({ key: 'notion_md.path.basename' })),
  }),
  label: ({ basename, reason }) => `${basename}:${reason}`,
})

const WatchSpan = OtelOperation.define({
  name: 'notion-md.watch',
  schema: Schema.Struct({
    command: Schema.Literal('sync').pipe(OtelAttr.key({ key: 'notion_md.command' })),
    watch: Schema.Boolean.pipe(OtelAttr.key({ key: 'notion_md.watch' })),
    basename: Schema.NonEmptyString.pipe(OtelAttr.key({ key: 'notion_md.path.basename' })),
  }),
  label: ({ basename }) => basename,
})

const cliCommandSpan = (command: string) =>
  OtelOperation.define({
    name: `notion-md.cli.${command}`,
    root: true,
    schema: Schema.Struct({
      label: OtelAttr.drop(Schema.NonEmptyString),
      command: Schema.NonEmptyString.pipe(OtelAttr.key({ key: 'notion_md.command' })),
    }),
    label: ({ label }) => label,
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
const cliVersion = resolveCliVersion({
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
        Path.layer,
      )
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
            annotateAttrs(WatchSyncResultAttrs, {
              result: result._tag,
              reason,
            }),
          ),
          Effect.tap((result) => emit({ event: 'sync', reason, result })),
          Effect.tapError((error: unknown) =>
            annotateAttrs(WatchSyncErrorAttrs, {
              error: true,
              errorTag:
                typeof error === 'object' && error !== null && '_tag' in error
                  ? String((error as { readonly _tag?: unknown })._tag)
                  : error instanceof Error
                    ? error.name
                    : 'unknown',
            }),
          ),
          withOperation(WatchSyncPassSpan, {
            command: 'sync',
            watch: true,
            reason,
            basename: watchedFile,
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
    withOperation(WatchSpan, {
      command: 'sync',
      watch: true,
      basename: basename(opts.syncOptions.path),
    }),
  )

const commandSpan = <A, E, R>(opts: {
  readonly command: string
  readonly label: string
  readonly effect: Effect.Effect<A, E, R>
}): Effect.Effect<A, E, R> =>
  opts.effect.pipe(
    withOperation(cliCommandSpan(opts.command), {
      label: opts.label,
      command: opts.command,
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
    dryRun: dryRunOption,
    json: jsonOption,
  },
  ({ paths, watch, pollIntervalMs, recursive, concurrency, force, dryRun, json }) => {
    if (watch === true) {
      const syncOptions: SyncOptions = { path: paths[0] ?? '', force, dryRun }
      return paths.length === 1
        ? withNotion(runWatch({ syncOptions, pollIntervalMs }))
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
        reconcileTree({ targets: paths, recursive, concurrency, force, dryRun }).pipe(
          Effect.flatMap((batch) =>
            json === true
              ? logJson(batch)
              : Effect.gen(function* () {
                  for (const item of batch.items) {
                    yield* Console.log(
                      item._tag === 'success'
                        ? `${item.result._tag.padEnd(16)} ${basename(item.result.path)}`
                        : `error            ${basename(item.path)}`,
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

const makeNotionMdCommand = (name: 'md' | 'notion-md') =>
  Command.make(name).pipe(
    Command.withSubcommands([trackCommand, statusCommand, syncCommand]),
    Command.withDescription('Frictionless Notion enhanced Markdown sync (track / status / sync)'),
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
