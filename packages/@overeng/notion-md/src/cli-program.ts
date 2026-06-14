import { basename, dirname, resolve } from 'node:path'

import { Args, Command, Options } from '@effect/cli'
import { FetchHttpClient, FileSystem, Path } from '@effect/platform'
import { Cause, Console, Duration, Effect, Layer, Option, Queue, Schema, Stream } from 'effect'

import { NotionConfigLive, resolveNotionToken } from '@overeng/notion-effect-client'
import { parseNotionUuid } from '@overeng/notion-effect-schema'
import { OtelAttr, OtelAttrs, OtelOperation } from '@overeng/otel-contract'
import { resolveCliVersion } from '@overeng/utils/node/cli-version'

import {
  isSingleFileTarget,
  resolveNmdTargets,
  runBatchWatch,
  statusMany,
  syncMany,
} from './batch.ts'
import { NmdCliError, NmdTokenMissingError } from './errors.ts'
import { NotionMdGatewayLive } from './live.ts'
import type { NotionMdGateway } from './model.ts'
import { annotateAttrs, withOperation } from './observability.ts'
import { planPath, statusPath, syncPath, targetKind } from './path.ts'
import { NmdStateStoreLive, type NmdStateStore } from './state-store.ts'
import { pullPage, syncPage, type SyncOptions } from './sync.ts'
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

const nmdTargetsArg = Args.text({ name: 'target' }).pipe(
  Args.withDescription('Local .nmd file path or directory with --recursive'),
  Args.withSchema(NonEmptyCliText),
  Args.atLeast(1),
)

const syncSourceArg = Args.text({ name: 'source' }).pipe(
  Args.withDescription('Local target, or Notion page id/url when a local target is also provided'),
  Args.withSchema(NonEmptyCliText),
)

const syncTargetArg = Args.text({ name: 'target' }).pipe(
  Args.withDescription('Local .nmd file to establish from Notion'),
  Args.withSchema(NonEmptyCliText),
  Args.optional,
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
  Options.withDescription(
    'Flat batch mode: discover existing .nmd files recursively; no tree hierarchy/moves/trash/materialization',
  ),
  Options.withDefault(false),
)

const concurrencyOption = Options.integer('concurrency').pipe(
  Options.withDescription('Maximum number of .nmd files to reconcile concurrently'),
  Options.withDefault(4),
  Options.withSchema(PositiveInteger),
)

const rootPageOption = Options.text('root').pipe(
  Options.withDescription(
    'Notion root page id/url for directory tree import or first local-authoritative tree sync',
  ),
  Options.optional,
)

const fromRemoteOption = Options.boolean('from-remote').pipe(
  Options.withDescription(
    'Directory tree mode: import/refresh local files from Notion instead of applying local desired tree state',
  ),
  Options.withDefault(false),
)

const rootFileOption = Options.text('root-file').pipe(
  Options.withDescription(
    'Directory tree root-file basename (default: index.nmd, or existing tree index binding)',
  ),
  Options.optional,
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
        syncPage(opts.syncOptions).pipe(
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

const hasExistingTreeIndex = (root: string): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs
      .exists(resolve(root, '.notion-md', 'workspace.json'))
      .pipe(Effect.catchAll(() => Effect.succeed(false)))
  })

const rejectPlanFileTarget = (target: string): Effect.Effect<void, NmdCliError> =>
  Effect.fail(
    new NmdCliError({
      message: `plan is directory-tree only; use \`notion-md status ${target}\` for a single .nmd file`,
    }),
  )

const assertFromRemoteTreeTarget = (opts: {
  readonly source: string
  readonly recursive: boolean
  readonly rootPageId: string | undefined
}): Effect.Effect<void, NmdCliError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (opts.recursive === true) {
      return yield* new NmdCliError({
        message:
          'Cannot combine --recursive and --from-remote: --recursive is flat batch mode; --from-remote is directory tree mode.',
      })
    }
    const kind = yield* targetKind(opts.source)
    if (kind === 'file') {
      return yield* new NmdCliError({
        message:
          '--from-remote is directory-tree only; use `notion-md sync <page-id-or-url> <file.nmd>` to import one page.',
      })
    }
    if (opts.rootPageId === undefined && (yield* hasExistingTreeIndex(opts.source)) === false) {
      return yield* new NmdCliError({
        message:
          '--from-remote requires --root <page-id-or-url> unless the directory already has .notion-md/workspace.json.',
      })
    }
  })

const parseRootPage = (
  root: Option.Option<string>,
): Effect.Effect<string | undefined, NmdCliError> => {
  if (Option.isNone(root) === true) return Effect.succeed(undefined)
  const parsed = parseNotionPageRef(root.value)
  return parsed === undefined
    ? Effect.fail(
        new NmdCliError({ message: `Invalid --root ${root.value}: not a Notion page id/url` }),
      )
    : Effect.succeed(parsed)
}

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
        targets.length === 1
          ? statusPath({ path: targets[0] ?? '', recursive, concurrency }).pipe(
              Effect.map((result): unknown => result),
            )
          : statusMany({ targets, recursive, concurrency }).pipe(
              Effect.map((result): unknown => result),
            ),
      ),
    }).pipe(Effect.flatMap(logJson)),
).pipe(Command.withDescription('Compare local .nmd state with the remote Notion page'))

const planCommand = Command.make(
  'plan',
  {
    target: syncSourceArg,
    root: rootPageOption,
    rootFile: rootFileOption,
    fromRemote: fromRemoteOption,
  },
  ({ target, root, rootFile, fromRemote }) =>
    commandSpan({
      command: 'plan',
      label: basename(target),
      effect: parseRootPage(root).pipe(
        Effect.flatMap((rootPageId) =>
          targetKind(target).pipe(
            Effect.flatMap((kind) =>
              kind === 'file'
                ? rejectPlanFileTarget(target)
                : fromRemote === true
                  ? assertFromRemoteTreeTarget({ source: target, recursive: false, rootPageId })
                  : Effect.void,
            ),
            Effect.zipRight(
              withNotion(
                planPath({
                  path: target,
                  fromRemote,
                  ...(rootPageId === undefined ? {} : { rootPageId }),
                  ...(Option.isSome(rootFile) === true ? { rootFile: rootFile.value } : {}),
                }).pipe(Effect.map((result): unknown => result)),
              ),
            ),
          ),
        ),
      ),
    }).pipe(Effect.flatMap(logJson)),
).pipe(
  Command.withDescription(
    'Dry-run: print the create/update/move/trash/noop diff for a directory tree without applying',
  ),
)

const syncCommand = Command.make(
  'sync',
  {
    source: syncSourceArg,
    target: syncTargetArg,
    watch: watchOption,
    pollIntervalMs: pollIntervalMsOption,
    recursive: recursiveOption,
    concurrency: concurrencyOption,
    root: rootPageOption,
    rootFile: rootFileOption,
    fromRemote: fromRemoteOption,
    ...pushSafetyOptions,
  },
  ({
    watch,
    pollIntervalMs,
    source,
    target,
    recursive,
    concurrency,
    root,
    rootFile,
    fromRemote,
    ...syncOptions
  }) => {
    const targets = [source]
    const label =
      targets.length === 1 ? basename(targets[0] ?? 'target') : `${targets.length} targets`
    const singleFile = isSingleFileTarget({ targets, recursive })

    /*
     * Legacy two-arg establish: `sync <page-id|url> <local-target>` materializes
     * a local file (or, with `--from-remote` semantics, a remote-authoritative
     * directory) from Notion. The unified single-arg form below subsumes the
     * steady-state cases; this branch keeps first-establish ergonomic.
     */
    if (Option.isSome(target) === true) {
      const pageId = parseNotionPageRef(source)
      if (pageId === undefined) {
        return Effect.fail(
          new NmdCliError({
            message: `Expected ${source} to be a Notion page id or URL when a local target is provided`,
          }),
        )
      }
      if (watch === true) {
        return Effect.fail(
          new NmdCliError({
            message:
              'Use `notion-md sync <target> --watch` after the local target has been established',
          }),
        )
      }
      return commandSpan({
        command: 'sync',
        label: basename(target.value),
        effect: withNotion(
          targetKind(target.value).pipe(
            Effect.flatMap((kind) =>
              kind === 'directory'
                ? Effect.fail(
                    new NmdCliError({
                      message:
                        'Directory tree materialization uses `notion-md sync <dir> --from-remote --root <page-id-or-url>`; the two-argument form is only for single `.nmd` file targets.',
                    }),
                  )
                : pullPage({ pageId, outPath: target.value }).pipe(
                    Effect.map((result): unknown => result),
                  ),
            ),
          ),
        ),
      }).pipe(Effect.flatMap(logJson))
    }

    return watch === true
      ? withNotion(
          targetKind(source).pipe(
            Effect.flatMap((kind) =>
              kind === 'directory'
                ? Effect.fail(
                    new NmdCliError({
                      message:
                        'Directory tree watch is not implemented yet. Run `notion-md sync <dir>` periodically, or watch specific .nmd files.',
                    }),
                  )
                : singleFile.pipe(
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
            ),
          ),
        )
      : commandSpan({
          command: 'sync',
          label,
          effect: parseRootPage(root).pipe(
            Effect.flatMap((rootPageId) =>
              fromRemote === true
                ? assertFromRemoteTreeTarget({ source, recursive, rootPageId }).pipe(
                    Effect.zipRight(
                      withNotion(
                        syncPath({
                          path: source,
                          fromRemote: true,
                          ...syncOptions,
                          ...(rootPageId === undefined ? {} : { rootPageId }),
                          ...(Option.isSome(rootFile) === true ? { rootFile: rootFile.value } : {}),
                        }).pipe(Effect.map((result): unknown => result)),
                      ),
                    ),
                  )
                : targetKind(source).pipe(
                    Effect.flatMap((kind) =>
                      kind === 'directory'
                        ? withNotion(
                            syncPath({
                              path: source,
                              recursive,
                              concurrency,
                              ...syncOptions,
                              ...(rootPageId === undefined ? {} : { rootPageId }),
                              ...(Option.isSome(rootFile) === true
                                ? { rootFile: rootFile.value }
                                : {}),
                            }).pipe(Effect.map((result): unknown => result)),
                          )
                        : singleFile.pipe(
                            Effect.flatMap((isSingleFile) =>
                              isSingleFile === true
                                ? withNotion(
                                    syncPath({
                                      path: targets[0] ?? '',
                                      ...syncOptions,
                                    }).pipe(Effect.map((result): unknown => result)),
                                  )
                                : withNotion(
                                    syncMany({
                                      ...syncOptions,
                                      targets,
                                      recursive,
                                      concurrency,
                                    }).pipe(Effect.map((result): unknown => result)),
                                  ),
                            ),
                          ),
                    ),
                  ),
            ),
          ),
        }).pipe(Effect.flatMap(logJson))
  },
).pipe(
  Command.withDescription(
    'Sync a local target (file or directory tree) — local-authoritative by default, `--from-remote` to mirror from Notion',
  ),
)

const makeNotionMdCommand = (name: 'md' | 'notion-md') =>
  Command.make(name).pipe(
    Command.withSubcommands([statusCommand, planCommand, syncCommand]),
    Command.withDescription('Two-way Notion enhanced Markdown sync'),
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
