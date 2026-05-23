import { watch as watchFile } from 'node:fs'
import { basename, dirname } from 'node:path'

import { Args, Command, Options } from '@effect/cli'
import { FetchHttpClient } from '@effect/platform'
import {
  Cause,
  Console,
  Duration,
  Effect,
  Layer,
  Option,
  Queue,
  Redacted,
  Runtime,
  Schema,
} from 'effect'

import { NotionConfigLive } from '@overeng/notion-effect-client'

import { NmdTokenMissingError } from './errors.ts'
import { NotionMdGatewayLive } from './live.ts'
import type { NotionMdGateway } from './model.ts'
import { NmdStateStoreLive, type NmdStateStore } from './state-store.ts'
import { pullPage, pushPage, statusPage, syncPage, type SyncOptions } from './sync.ts'

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

const nmdFileArg = Args.text({ name: 'file.nmd' }).pipe(
  Args.withDescription('Local .nmd file path'),
  Args.withSchema(NonEmptyCliText),
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

const pushSafetyOptions = {
  force: forceOption,
  allowDeletingUnknownBlocks: allowDeleteUnknownBlocksOption,
  allowReviewMarkup: allowReviewMarkupOption,
} as const

const resolveToken = Effect.sync(
  () => process.env.NOTION_TOKEN ?? process.env.NOTION_API_TOKEN,
).pipe(
  Effect.flatMap((token) =>
    token !== undefined && token.length > 0
      ? Effect.succeed(token)
      : Effect.fail(
          new NmdTokenMissingError({
            message: 'NOTION_TOKEN or NOTION_API_TOKEN is required',
          }),
        ),
  ),
)

/** Live Notion gateway layer assembled from the process Notion token. */
export const MainLayer = Layer.unwrapEffect(
  resolveToken.pipe(
    Effect.map((token) => {
      const baseLayer = Layer.mergeAll(
        NotionConfigLive({ authToken: Redacted.make(token) }),
        FetchHttpClient.layer,
      )

      return Layer.mergeAll(
        baseLayer,
        NotionMdGatewayLive.pipe(Layer.provide(baseLayer)),
        NmdStateStoreLive,
      )
    }),
  ),
)

const withNotion = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provide(effect, MainLayer)

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

const writeJsonLine = (value: unknown): Effect.Effect<void> =>
  Effect.sync(() => {
    process.stdout.write(`${JSON.stringify(value)}\n`)
  })

type WatchReason = 'file' | 'initial' | 'poll'

interface WatchEvent {
  readonly reason: WatchReason
}

const nextWatchReason = (opts: {
  readonly initial: WatchEvent
  readonly pending: Iterable<WatchEvent>
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
}): Effect.Effect<never, never, NotionMdGateway | NmdStateStore> =>
  Effect.scoped(
    Effect.gen(function* () {
      const queue = yield* Queue.sliding<WatchEvent>(1024)
      const runtime = yield* Effect.runtime<never>()
      const emit = opts.emit ?? writeJsonLine
      const path = opts.syncOptions.path
      const watchedFile = basename(path)
      const watchedDir = dirname(path)

      const offer = (event: WatchEvent): void => {
        void Runtime.runFork(runtime)(Queue.offer(queue, event))
      }

      const pass = (reason: WatchReason) =>
        syncPage(opts.syncOptions).pipe(
          Effect.tap((result) =>
            Effect.annotateCurrentSpan({
              'notion_md.sync.result': result._tag,
              'notion_md.watch.reason': reason,
            }),
          ),
          Effect.tap((result) => emit({ event: 'sync', reason, result })),
          Effect.catchAll((error: unknown) =>
            Effect.annotateCurrentSpan({
              'notion_md.sync.error': true,
              'notion_md.sync.error_tag':
                typeof error === 'object' && error !== null && '_tag' in error
                  ? String((error as { readonly _tag?: unknown })._tag)
                  : error instanceof Error
                    ? error.name
                    : 'unknown',
            }).pipe(
              Effect.zipRight(emit({ event: 'sync_error', reason, error: safeJsonError(error) })),
            ),
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
        )

      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const watcher = watchFile(watchedDir, (_eventType, filename) => {
            if (filename === watchedFile) {
              offer({ reason: 'file' })
            }
          })
          watcher.on('error', (error) => {
            void Runtime.runFork(runtime)(
              emit({ event: 'watch_error', path, error: safeJsonError(error) }),
            )
          })
          return watcher
        }),
        (watcher) => Effect.sync(() => watcher.close()),
      )

      yield* Queue.offer(queue, { reason: 'initial' })
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.sleep(Duration.millis(opts.pollIntervalMs)).pipe(
            Effect.zipRight(Queue.offer(queue, { reason: 'poll' })),
          ),
        ),
      )

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

const statusCommand = Command.make('status', { path: nmdFileArg }, ({ path }) =>
  commandSpan({
    command: 'status',
    label: basename(path),
    effect: withNotion(statusPage({ path })),
  }).pipe(Effect.flatMap(logJson)),
).pipe(Command.withDescription('Compare local .nmd state with the remote Notion page'))

const pushCommand = Command.make(
  'push',
  {
    path: nmdFileArg,
    ...pushSafetyOptions,
  },
  (opts) =>
    commandSpan({
      command: 'push',
      label: basename(opts.path),
      effect: withNotion(pushPage(opts)),
    }).pipe(Effect.flatMap(logJson)),
).pipe(Command.withDescription('Push guarded local .nmd edits to Notion'))

const syncCommand = Command.make(
  'sync',
  {
    path: nmdFileArg,
    watch: watchOption,
    pollIntervalMs: pollIntervalMsOption,
    ...pushSafetyOptions,
  },
  ({ watch, pollIntervalMs, ...syncOptions }) =>
    watch === true
      ? withNotion(runWatch({ syncOptions, pollIntervalMs }))
      : commandSpan({
          command: 'sync',
          label: basename(syncOptions.path),
          effect: withNotion(syncPage(syncOptions)),
        }).pipe(Effect.flatMap(logJson)),
).pipe(Command.withDescription('Reconcile a local .nmd file with its Notion page'))

/** Effect CLI command tree for the notion-md binary. */
export const notionMdCommand = Command.make('notion-md').pipe(
  Command.withSubcommands([pullCommand, statusCommand, pushCommand, syncCommand]),
  Command.withDescription('Two-way Notion enhanced Markdown sync'),
)

/** Process argv runner for the notion-md command tree. */
export const cli = Command.run(notionMdCommand, {
  name: 'notion-md',
  version: '0.1.0',
})

/** Render expected CLI failures without duplicating Effect's defect reporter. */
export const renderCliError = (cause: Cause.Cause<unknown>) =>
  Cause.isInterruptedOnly(cause) === true
    ? Effect.void
    : Option.match(Cause.failureOption(cause), {
        onNone: () => Effect.logError(cause),
        onSome: (error) => Effect.logError(error),
      })
