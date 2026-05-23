import { basename, dirname, resolve } from 'node:path'

import { Args, Command, Options } from '@effect/cli'
import { FetchHttpClient, FileSystem, Path } from '@effect/platform'
import {
  Cause,
  Config,
  Console,
  Duration,
  Effect,
  Layer,
  Option,
  Queue,
  Redacted,
  Schema,
  Stream,
} from 'effect'

import { NotionConfigLive } from '@overeng/notion-effect-client'
import { resolveCliVersion } from '@overeng/utils/node/cli-version'

import { NmdCliError, NmdTokenMissingError } from './errors.ts'
import {
  isSingleFileTarget,
  pushMany,
  resolveNmdTargets,
  runBatchWatch,
  statusMany,
  syncMany,
} from './batch.ts'
import { NotionMdGatewayLive } from './live.ts'
import type { NotionMdGateway } from './model.ts'
import { NmdStateStoreLive, type NmdStateStore } from './state-store.ts'
import { pullPage, pushPage, statusPage, syncPage, type SyncOptions } from './sync.ts'
import { NOTION_MD_VERSION } from './version.ts'

const NonEmptyCliText = Schema.NonEmptyTrimmedString.annotations({
  identifier: 'NotionMd.Cli.NonEmptyText',
})

const PositiveInteger = Schema.Number.pipe(Schema.int(), Schema.positive()).annotations({
  identifier: 'NotionMd.Cli.PositiveInteger',
})

const pageIdArg = Args.text({ name: 'page-id' }).pipe(
  Args.withDescription('Notion page id to pull'),
  Args.withSchema(NonEmptyCliText),
)

const nmdTargetsArg = Args.text({ name: 'target' }).pipe(
  Args.withDescription('Local .nmd file path or directory with --recursive'),
  Args.withSchema(NonEmptyCliText),
  Args.atLeast(1),
)

const outOption = Options.text('out').pipe(
  Options.withAlias('o'),
  Options.withDescription('Output .nmd file path'),
  Options.withSchema(NonEmptyCliText),
)

const forceOption = Options.boolean('force').pipe(
  Options.withDescription('Allow overwriting remote changes'),
  Options.withDefault(false),
)

const allowDeleteUnknownBlocksOption = Options.boolean('allow-delete-unknown-blocks').pipe(
  Options.withDescription('Allow replace_content to delete unsupported Notion blocks'),
  Options.withDefault(false),
)

const allowReviewMarkupOption = Options.boolean('allow-review-markup').pipe(
  Options.withDescription('Allow unresolved Roughdraft review markup to be sent to Notion'),
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
  Options.withDescription('Discover .nmd files recursively when a target is a directory'),
  Options.withDefault(false),
)

const concurrencyOption = Options.integer('concurrency').pipe(
  Options.withDescription('Maximum number of .nmd files to reconcile concurrently'),
  Options.withDefault(4),
  Options.withSchema(PositiveInteger),
)

const pushSafetyOptions = {
  force: forceOption,
  allowDeletingUnknownBlocks: allowDeleteUnknownBlocksOption,
  allowReviewMarkup: allowReviewMarkupOption,
} as const
const buildStamp = '__CLI_BUILD_STAMP__'
const cliVersion = resolveCliVersion({
  baseVersion: NOTION_MD_VERSION,
  buildStamp,
})

const resolveToken = Config.redacted('NOTION_TOKEN').pipe(
  Effect.filterOrFail(
    (token) => Redacted.value(token).length > 0,
    () =>
      new NmdTokenMissingError({
        message: 'NOTION_TOKEN is required',
      }),
  ),
  Effect.mapError(
    () =>
      new NmdTokenMissingError({
        message: 'NOTION_TOKEN is required',
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
        syncPage(opts.syncOptions).pipe(
          Effect.tap((result) =>
            Effect.annotateCurrentSpan({
              'notion_md.sync.result': result._tag,
              'notion_md.watch.reason': reason,
            }),
          ),
          Effect.tap((result) => emit({ event: 'sync', reason, result })),
          Effect.tapError((error: unknown) =>
            Effect.annotateCurrentSpan({
              'notion_md.sync.error': true,
              'notion_md.sync.error_tag':
                typeof error === 'object' && error !== null && '_tag' in error
                  ? String((error as { readonly _tag?: unknown })._tag)
                  : error instanceof Error
                    ? error.name
                    : 'unknown',
            }),
          ),
          Effect.withSpan('notion-md.watch.sync-pass', {
            root: true,
            attributes: {
              'span.label': `${watchedFile}:${reason}`,
              'notion_md.command': 'sync',
              'notion_md.watch': true,
              'notion_md.watch.reason': reason,
              'notion_md.path.basename': watchedFile,
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
    Effect.withSpan('notion-md.watch', {
      attributes: {
        'span.label': basename(opts.syncOptions.path),
        'notion_md.command': 'sync',
        'notion_md.watch': true,
        'notion_md.path.basename': basename(opts.syncOptions.path),
      },
    }),
  )

const commandSpan = <A, E, R>(opts: {
  readonly command: string
  readonly label: string
  readonly effect: Effect.Effect<A, E, R>
}): Effect.Effect<A, E, R> =>
  opts.effect.pipe(
    Effect.withSpan(`notion-md.cli.${opts.command}`, {
      root: true,
      attributes: {
        'span.label': opts.label,
        'notion_md.command': opts.command,
      },
    }),
  )

const pullCommand = Command.make(
  'pull',
  {
    pageId: pageIdArg,
    outPath: outOption,
  },
  ({ pageId, outPath }) =>
    commandSpan({
      command: 'pull',
      label: basename(outPath),
      effect: withNotion(pullPage({ pageId, outPath })),
    }).pipe(Effect.flatMap(logJson)),
).pipe(Command.withDescription('Pull a Notion page into a local .nmd file'))

const statusCommand = Command.make(
  'status',
  {
    targets: nmdTargetsArg,
    recursive: recursiveOption,
    concurrency: concurrencyOption,
  },
  ({ targets, recursive, concurrency }) =>
    commandSpan({
      command: 'status',
      label: targets.length === 1 ? basename(targets[0] ?? 'target') : `${targets.length} targets`,
      effect: withNotion(
        isSingleFileTarget({ targets, recursive }).pipe(
          Effect.flatMap((singleFile) =>
            singleFile === true
              ? statusPage({ path: targets[0] ?? '' }).pipe(Effect.map((result): unknown => result))
              : statusMany({ targets, recursive, concurrency }).pipe(
                  Effect.map((result): unknown => result),
                ),
          ),
        ),
      ),
    }).pipe(Effect.flatMap(logJson)),
).pipe(Command.withDescription('Compare local .nmd state with the remote Notion page'))

const pushCommand = Command.make(
  'push',
  {
    targets: nmdTargetsArg,
    recursive: recursiveOption,
    concurrency: concurrencyOption,
    ...pushSafetyOptions,
  },
  (opts) =>
    commandSpan({
      command: 'push',
      label:
        opts.targets.length === 1
          ? basename(opts.targets[0] ?? 'target')
          : `${opts.targets.length} targets`,
      effect: withNotion(
        isSingleFileTarget({ targets: opts.targets, recursive: opts.recursive }).pipe(
          Effect.flatMap((singleFile) =>
            singleFile === true
              ? pushPage({
                  path: opts.targets[0] ?? '',
                  ...(opts.force === undefined ? {} : { force: opts.force }),
                  ...(opts.allowDeletingUnknownBlocks === undefined
                    ? {}
                    : { allowDeletingUnknownBlocks: opts.allowDeletingUnknownBlocks }),
                  ...(opts.allowReviewMarkup === undefined
                    ? {}
                    : { allowReviewMarkup: opts.allowReviewMarkup }),
                }).pipe(Effect.map((result): unknown => result))
              : pushMany(opts).pipe(Effect.map((result): unknown => result)),
          ),
        ),
      ),
    }).pipe(Effect.flatMap(logJson)),
).pipe(Command.withDescription('Push guarded local .nmd edits to Notion'))

const syncCommand = Command.make(
  'sync',
  {
    targets: nmdTargetsArg,
    watch: watchOption,
    pollIntervalMs: pollIntervalMsOption,
    recursive: recursiveOption,
    concurrency: concurrencyOption,
    ...pushSafetyOptions,
  },
  ({ watch, pollIntervalMs, targets, recursive, concurrency, ...syncOptions }) => {
    const label =
      targets.length === 1 ? basename(targets[0] ?? 'target') : `${targets.length} targets`
    const singleFile = isSingleFileTarget({ targets, recursive })

    return watch === true
      ? withNotion(
          singleFile.pipe(
            Effect.flatMap((isSingleFile) =>
              isSingleFile === true
                ? runWatch({
                    syncOptions: { ...syncOptions, path: targets[0] ?? '' },
                    pollIntervalMs,
                  })
                : resolveNmdTargets({ targets, recursive, operation: 'sync' }).pipe(
                    Effect.flatMap((resolved) => {
                      const firstError = resolved.errors[0]
                      if (firstError !== undefined) return Effect.fail(firstError.error)
                      if (resolved.paths.length === 0) {
                        return Effect.fail(
                          new NmdCliError({
                            message: 'No .nmd files matched the requested watch targets',
                          }),
                        )
                      }
                      return runBatchWatch({
                        ...syncOptions,
                        paths: resolved.paths,
                        concurrency,
                        pollIntervalMs,
                      })
                    }),
                  ),
            ),
          ),
        )
      : commandSpan({
          command: 'sync',
          label,
          effect: withNotion(
            singleFile.pipe(
              Effect.flatMap((isSingleFile) =>
                isSingleFile === true
                  ? syncPage({ ...syncOptions, path: targets[0] ?? '' }).pipe(
                      Effect.map((result): unknown => result),
                    )
                  : syncMany({ ...syncOptions, targets, recursive, concurrency }).pipe(
                      Effect.map((result): unknown => result),
                    ),
              ),
            ),
          ),
        }).pipe(Effect.flatMap(logJson))
  },
).pipe(Command.withDescription('Reconcile a local .nmd file with its Notion page'))

/** Effect CLI command tree for the notion-md binary. */
export const notionMdCommand = Command.make('notion-md').pipe(
  Command.withSubcommands([pullCommand, statusCommand, pushCommand, syncCommand]),
  Command.withDescription('Two-way Notion enhanced Markdown sync'),
)

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
