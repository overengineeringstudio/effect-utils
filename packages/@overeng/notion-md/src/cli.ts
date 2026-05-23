#!/usr/bin/env bun

import { watch } from 'node:fs'
import { basename, dirname } from 'node:path'

import { Args, Command, Options } from '@effect/cli'
import { FetchHttpClient } from '@effect/platform'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { Cause, Console, Effect, Layer, Option, Redacted, Schema } from 'effect'

import { NotionConfigLive } from '@overeng/notion-effect-client'

import { NmdTokenMissingError } from './errors.ts'
import { NotionMdGatewayLive } from './live.ts'
import { NotionMdGateway } from './model.ts'
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

const MainLayer = Layer.unwrapEffect(
  resolveToken.pipe(
    Effect.map((token) => {
      const baseLayer = Layer.mergeAll(
        NotionConfigLive({ authToken: Redacted.make(token) }),
        FetchHttpClient.layer,
      )

      return Layer.mergeAll(baseLayer, NotionMdGatewayLive.pipe(Layer.provide(baseLayer)))
    }),
  ),
)

const withNotion = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provide(effect, MainLayer)

const logJson = (value: unknown): Effect.Effect<void> => Console.log(JSON.stringify(value, null, 2))

const writeJsonLine = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

const runWatch = (opts: {
  readonly syncOptions: SyncOptions
  readonly pollIntervalMs: number
}): Effect.Effect<never, never, NotionMdGateway> =>
  Effect.scoped(
    Effect.gen(function* () {
      const gateway = yield* NotionMdGateway
      const path = opts.syncOptions.path
      const watchedFile = basename(path)
      const watchedDir = dirname(path)

      const state = yield* Effect.acquireRelease(
        Effect.sync(() => {
          let debounceTimer: ReturnType<typeof setTimeout> | undefined
          let running = false
          let pendingReason: string | undefined

          const run = (reason: string): void => {
            if (running === true) {
              pendingReason = reason
              return
            }

            running = true
            pendingReason = undefined
            void Effect.runPromise(
              syncPage(opts.syncOptions).pipe(Effect.provideService(NotionMdGateway, gateway)),
            )
              .then((result) => writeJsonLine({ event: 'sync', reason, result }))
              .catch((error: unknown) => writeJsonLine({ event: 'sync_error', reason, error }))
              .finally(() => {
                running = false
                if (pendingReason !== undefined) {
                  const nextReason = pendingReason
                  pendingReason = undefined
                  schedule(nextReason)
                }
              })
          }

          const schedule = (reason: string): void => {
            if (debounceTimer !== undefined) {
              clearTimeout(debounceTimer)
            }
            debounceTimer = setTimeout(() => run(reason), 250)
          }

          const watcher = watch(watchedDir, (_eventType, filename) => {
            if (filename === watchedFile) {
              schedule('file')
            }
          })
          watcher.on('error', (error) => {
            writeJsonLine({ event: 'watch_error', path, error })
          })

          const pollTimer = setInterval(() => schedule('poll'), opts.pollIntervalMs)
          run('initial')

          return {
            cleanup: (): void => {
              if (debounceTimer !== undefined) {
                clearTimeout(debounceTimer)
              }
              clearInterval(pollTimer)
              watcher.close()
            },
          }
        }),
        (resource) => Effect.sync(() => resource.cleanup()),
      )

      void state
      return yield* Effect.never
    }),
  ).pipe(Effect.withSpan('notion-md.watch'))

const pullCommand = Command.make(
  'pull',
  {
    pageId: pageIdArg,
    outPath: outOption,
  },
  ({ pageId, outPath }) => withNotion(pullPage({ pageId, outPath })).pipe(Effect.flatMap(logJson)),
).pipe(Command.withDescription('Pull a Notion page into a local .nmd file'))

const statusCommand = Command.make('status', { path: nmdFileArg }, ({ path }) =>
  withNotion(statusPage({ path })).pipe(Effect.flatMap(logJson)),
).pipe(Command.withDescription('Compare local .nmd state with the remote Notion page'))

const pushCommand = Command.make(
  'push',
  {
    path: nmdFileArg,
    ...pushSafetyOptions,
  },
  (opts) => withNotion(pushPage(opts)).pipe(Effect.flatMap(logJson)),
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
      : withNotion(syncPage(syncOptions)).pipe(Effect.flatMap(logJson)),
).pipe(Command.withDescription('Reconcile a local .nmd file with its Notion page'))

const notionMdCommand = Command.make('notion-md').pipe(
  Command.withSubcommands([pullCommand, statusCommand, pushCommand, syncCommand]),
  Command.withDescription('Two-way Notion enhanced Markdown sync'),
)

const cli = Command.run(notionMdCommand, {
  name: 'notion-md',
  version: '0.1.0',
})

cli(process.argv).pipe(
  Effect.tapErrorCause((cause) =>
    Cause.isInterruptedOnly(cause) === true
      ? Effect.void
      : Option.match(Cause.failureOption(cause), {
          onNone: () => Effect.logError(cause),
          onSome: (error) => Effect.logError(error),
        }),
  ),
  Effect.provide(NodeContext.layer),
  NodeRuntime.runMain({ disableErrorReporting: true }),
)
