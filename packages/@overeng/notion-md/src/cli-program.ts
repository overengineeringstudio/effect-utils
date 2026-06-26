import { basename, dirname, resolve } from 'node:path'

import { Args, Command, Options } from '@effect/cli'
import { FetchHttpClient, FileSystem, Path } from '@effect/platform'
import { Cause, Console, Duration, Effect, Layer, Option, Queue, Schema, Stream } from 'effect'
import React from 'react'

import { NotionConfigLive, resolveNotionToken } from '@overeng/notion-effect-client'
import { parseNotionUuid } from '@overeng/notion-effect-schema'
import { OtelAttr, OtelAttrs, OtelOperation } from '@overeng/otel-contract'
import { OutputModeTag, run } from '@overeng/tui-react'
import { outputModeLayer, outputOption } from '@overeng/tui-react/node'
import { resolveCliVersion } from '@overeng/utils/node/cli-version'

import {
  isSingleFileTarget,
  resolveNmdTargets,
  runBatchWatch,
  statusMany,
  syncMany,
} from './batch.ts'
import { getEditApp } from './cli-output/edit/app.ts'
import { EditView } from './cli-output/edit/view.tsx'
import { getPlanApp } from './cli-output/plan/app.ts'
import { planResultPayload } from './cli-output/plan/map.ts'
import { PlanView } from './cli-output/plan/view.tsx'
import { progressReporterTui } from './cli-output/progress-bridge.ts'
import { getPutApp } from './cli-output/put/app.ts'
import type { PutAction } from './cli-output/put/schema.ts'
import { PutView } from './cli-output/put/view.tsx'
import { getStatusApp } from './cli-output/status/app.ts'
import { statusResultPayload, type StatusEngineResult } from './cli-output/status/map.ts'
import { StatusView } from './cli-output/status/view.tsx'
import { getSyncApp } from './cli-output/sync/app.ts'
import { syncErrorAction, syncResultAction, type SyncEngineResult } from './cli-output/sync/map.ts'
import { SyncView } from './cli-output/sync/view.tsx'
import { getWatchApp } from './cli-output/watch/app.ts'
import { toWatchAction } from './cli-output/watch/map.ts'
import { WatchView } from './cli-output/watch/view.tsx'
import {
  catEditorPage,
  editEditorPage,
  editReadOnlyPage,
  putEditorPage,
  type EditorMode,
} from './editor-commands.ts'
import {
  NmdCliError,
  NmdTokenMissingError,
  NmdUnresolvablePageError,
  type NmdError,
} from './errors.ts'
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
    output: outputOption,
  },
  ({ targets, recursive, concurrency, output }) => {
    const label =
      targets.length === 1 ? basename(targets[0] ?? 'target') : `${targets.length} targets`
    /** Context-header target: the real path for a single target, else the count. */
    const headerTarget =
      targets.length === 1 ? (targets[0] ?? 'target') : `${targets.length} targets`
    /*
     * Read-only result: route the engine result through the tui-react OutputMode
     * seam (Slice C-read). `status` is STAGE-LESS — no `ProgressReporter` bridge,
     * no live stages. The handler seeds the target, runs the engine, then maps the
     * polymorphic result (single file / tree / batch) into a precomputed
     * `{sections, problems, summary}` via `SetResult`. Engine failures propagate
     * UNCAUGHT (only `tapErrorCause` dispatches a view action), so the `runMain`
     * teardown owns the real exit code; a drifted/guarded result is exit 0.
     */
    return commandSpan({
      command: 'status',
      label,
      effect: run(
        getStatusApp(),
        (tui) => {
          tui.dispatch({ _tag: 'SetTarget', target: headerTarget })
          return withNotion(
            (targets.length === 1
              ? statusPath({ path: targets[0] ?? '', recursive, concurrency })
              : statusMany({ targets, recursive, concurrency })
            ).pipe(Effect.map((result): StatusEngineResult => result)),
          ).pipe(
            Effect.tap((result) =>
              Effect.sync(() =>
                tui.dispatch({ _tag: 'SetResult', result: statusResultPayload(result) }),
              ),
            ),
            Effect.tapErrorCause((cause) =>
              Option.match(Cause.failureOption(cause), {
                onNone: () => Effect.void,
                onSome: (error) =>
                  Effect.sync(() => tui.dispatch({ _tag: 'SetError', message: String(error) })),
              }),
            ),
          )
        },
        { view: React.createElement(StatusView, { stateAtom: getStatusApp().stateAtom }) },
      ).pipe(Effect.provide(outputModeLayer(output))),
    })
  },
).pipe(Command.withDescription('Compare local .nmd state with the remote Notion page'))

const planCommand = Command.make(
  'plan',
  {
    target: syncSourceArg,
    root: rootPageOption,
    rootFile: rootFileOption,
    fromRemote: fromRemoteOption,
    output: outputOption,
  },
  ({ target, root, rootFile, fromRemote, output }) =>
    commandSpan({
      command: 'plan',
      label: basename(target),
      // Pre-flight validations (root parse, file-target rejection, from-remote
      // tree assertion) stay OUTSIDE `run`: a bad-flags failure is a usage error,
      // NOT a plan result, and the e2e contract requires `plan <file>` to fail
      // BEFORE token resolution. The framework maps these on the error channel.
      // Only the engine call routes through the read-only OutputMode seam.
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
              /*
               * Read-only result: route the `TreeSyncResult` diff through the
               * tui-react OutputMode seam (Slice C-read). STAGE-LESS — no progress
               * bridge. The handler seeds the target, runs the engine, then maps
               * the diff into a precomputed `{sections, problems, summary}` via
               * `SetResult`. Engine failures propagate UNCAUGHT (only
               * `tapErrorCause` dispatches a view action), so the `runMain`
               * teardown owns the real exit code; a blocked plan is exit 0.
               */
              run(
                getPlanApp(),
                (tui) => {
                  tui.dispatch({ _tag: 'SetTarget', target })
                  return withNotion(
                    planPath({
                      path: target,
                      fromRemote,
                      ...(rootPageId === undefined ? {} : { rootPageId }),
                      ...(Option.isSome(rootFile) === true ? { rootFile: rootFile.value } : {}),
                    }),
                  ).pipe(
                    Effect.tap((result) =>
                      Effect.sync(() =>
                        tui.dispatch({ _tag: 'SetResult', result: planResultPayload(result) }),
                      ),
                    ),
                    Effect.tapErrorCause((cause) =>
                      Option.match(Cause.failureOption(cause), {
                        onNone: () => Effect.void,
                        onSome: (error) =>
                          Effect.sync(() =>
                            tui.dispatch({ _tag: 'SetError', message: String(error) }),
                          ),
                      }),
                    ),
                  )
                },
                { view: React.createElement(PlanView, { stateAtom: getPlanApp().stateAtom }) },
              ).pipe(Effect.provide(outputModeLayer(output))),
            ),
          ),
        ),
      ),
    }),
).pipe(
  Command.withDescription(
    'Dry-run: print the create/update/move/trash/noop diff for a directory tree without applying',
  ),
)

/**
 * Route a one-shot `sync` engine effect through the tui-react OutputMode seam
 * (Slice C). Mirrors the `edit`/`put` wiring: the engine emits stages via the
 * `ProgressReporter` Tag (single-page only — multi-page rows come from the
 * terminal result), `progressReporterTui` bridges each onto `tui.dispatch`, and
 * the normalized terminal action carries the outcome into the view. Engine
 * failures propagate UNCAUGHT so the `runMain` teardown owns the exit code
 * (single-page `NmdConflictError`→7, others→1); a tree/batch conflict is a
 * reported per-page outcome (exit 0). The `--watch` path never reaches here.
 *
 * IMPORTANT: the `engine` MUST already wrap its Notion-touching call in
 * `withNotion` per-branch — NOT the whole effect. The pre-flight validations
 * (`targetKind`, `assertFromRemoteTreeTarget`) run BEFORE token resolution (the
 * "before resolving Notion credentials" e2e contract), and `withNotion` front-
 * runs `resolveToken`. So this helper only adds the view bridge + OutputMode
 * layer, leaving residual `R = FileSystem` for the validation steps.
 */
const runSyncOutput = <E>({
  target,
  output,
  engine,
}: {
  readonly target: string
  readonly output: Parameters<typeof outputModeLayer>[0]
  readonly engine: Effect.Effect<SyncEngineResult, E, FileSystem.FileSystem | Path.Path>
}) =>
  run(
    getSyncApp(),
    (tui) => {
      // `getSyncApp` is cached with an empty-target placeholder; seed the real
      // target first so the context header + summary name it (dispatch is sync +
      // the reducer is pure, so this lands before the engine's first stage).
      tui.dispatch({ _tag: 'SetTarget', target })
      return engine.pipe(
        Effect.tap((result) => Effect.sync(() => tui.dispatch(syncResultAction(result)))),
        Effect.tapErrorCause((cause) =>
          Option.match(Cause.failureOption(cause), {
            onNone: () => Effect.void,
            onSome: (error) => Effect.sync(() => tui.dispatch(syncErrorAction(error))),
          }),
        ),
        Effect.provide(progressReporterTui(tui.dispatch)),
      )
    },
    { view: React.createElement(SyncView, { stateAtom: getSyncApp().stateAtom }) },
  ).pipe(Effect.provide(outputModeLayer(output)))

/**
 * Run a `--watch` loop with mode-appropriate output.
 *
 * Hard constraint: the per-pass NDJSON/`writeJsonLine` stream MUST stay
 * byte-identical to today's (scripts depend on it). So this branches on the
 * RESOLVED `OutputMode` instead of folding both paths through the kit's
 * `NdjsonConfig`:
 *
 * - **react (TTY)**: mount {@link getWatchApp} and redirect the loop's per-pass
 *   `emit` into `tui.dispatch(toWatchAction(event))` for a live status view.
 *   Watch is infinite — `run`'s handler never returns; Ctrl+C interrupts the
 *   scope and the finalizer unmounts. The view renders to the TTY only.
 * - **machine (json/ndjson/log/ci/auto-piped)**: run the IDENTICAL loop with the
 *   default `writeJsonLine` emit (no `emit` override). Byte-identity holds by
 *   construction — there is no re-encoding, no schema key-order risk, and the
 *   heterogeneous `sync`/`sync_error`/`watch_error`/batch-`paths` lines are
 *   reproduced verbatim. `--output json` for `--watch` streams these ndjson-
 *   style per-pass lines (there is no single terminal state for an infinite
 *   stream); the kit's progressive-json snapshot mode is intentionally bypassed.
 *
 * `buildWatch` receives the loop's optional `emit` override and returns the
 * (never-returning) watch Effect — the two call sites pass `runWatch` /
 * `runBatchWatch` partially applied with their target-specific options.
 */
const runWatchOutput = <R>({
  target,
  pollIntervalMs,
  output,
  buildWatch,
}: {
  readonly target: string
  readonly pollIntervalMs: number
  readonly output: Parameters<typeof outputModeLayer>[0]
  readonly buildWatch: (
    emit?: (value: unknown) => Effect.Effect<void>,
  ) => Effect.Effect<never, never, R>
}): Effect.Effect<never, NmdCliError, R> =>
  Effect.gen(function* () {
    const mode = yield* OutputModeTag
    if (mode._tag === 'react') {
      return yield* run(
        getWatchApp(),
        (tui) => {
          tui.dispatch({ _tag: 'Init', target, pollIntervalMs })
          return buildWatch((event) =>
            Effect.sync(() => {
              const action = toWatchAction(event)
              if (action !== undefined) tui.dispatch(action)
            }),
          )
        },
        { view: React.createElement(WatchView, { stateAtom: getWatchApp().stateAtom }) },
      )
    }
    // Machine modes: today's stream, verbatim (default `writeJsonLine` emit).
    return yield* buildWatch()
  }).pipe(Effect.provide(outputModeLayer(output)))

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
    output: outputOption,
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
    output,
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
        effect: runSyncOutput({
          target: target.value,
          output,
          engine: targetKind(target.value).pipe(
            Effect.flatMap((kind) =>
              kind === 'directory'
                ? Effect.fail(
                    new NmdCliError({
                      message:
                        'Directory tree materialization uses `notion-md sync <dir> --from-remote --root <page-id-or-url>`; the two-argument form is only for single `.nmd` file targets.',
                    }),
                  )
                : withNotion(
                    pullPage({ pageId, outPath: target.value }).pipe(
                      Effect.map((result): SyncEngineResult => result),
                    ),
                  ),
            ),
          ),
        }),
      })
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
                        ? runWatchOutput({
                            target: targets[0] ?? source,
                            pollIntervalMs,
                            output,
                            buildWatch: (emit) =>
                              runWatch({
                                syncOptions: { ...syncOptions, path: targets[0] ?? '' },
                                pollIntervalMs,
                                ...(emit === undefined ? {} : { emit }),
                              }),
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
                              return runWatchOutput({
                                target: label,
                                pollIntervalMs,
                                output,
                                buildWatch: (emit) =>
                                  runBatchWatch({
                                    ...syncOptions,
                                    paths: resolved.paths,
                                    concurrency,
                                    pollIntervalMs,
                                    ...(emit === undefined ? {} : { emit }),
                                  }),
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
          effect: runSyncOutput({
            target: source,
            output,
            engine: parseRootPage(root).pipe(
              // Explicit return annotation widens the four engine result shapes
              // (SyncResult / TreeSyncResult / BatchResult) to `SyncEngineResult`.
              // `withNotion` wraps only the reconcile call so `assertFromRemoteTreeTarget`
              // / `targetKind` run BEFORE token resolution (the pre-credentials contract).
              Effect.flatMap(
                (
                  rootPageId,
                ): Effect.Effect<
                  SyncEngineResult,
                  NmdError | NmdTokenMissingError,
                  FileSystem.FileSystem | Path.Path
                > =>
                  fromRemote === true
                    ? assertFromRemoteTreeTarget({ source, recursive, rootPageId }).pipe(
                        Effect.zipRight(
                          withNotion(
                            syncPath({
                              path: source,
                              fromRemote: true,
                              ...syncOptions,
                              ...(rootPageId === undefined ? {} : { rootPageId }),
                              ...(Option.isSome(rootFile) === true
                                ? { rootFile: rootFile.value }
                                : {}),
                            }),
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
                                }),
                              )
                            : singleFile.pipe(
                                Effect.flatMap((isSingleFile) =>
                                  isSingleFile === true
                                    ? withNotion(
                                        syncPath({ path: targets[0] ?? '', ...syncOptions }),
                                      )
                                    : withNotion(
                                        syncMany({
                                          ...syncOptions,
                                          targets,
                                          recursive,
                                          concurrency,
                                        }),
                                      ),
                                ),
                              ),
                        ),
                      ),
              ),
            ),
          }),
        })
  },
).pipe(
  Command.withDescription(
    'Sync a local target (file or directory tree) — local-authoritative by default, `--from-remote` to mirror from Notion',
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

/**
 * Map a `put` engine failure to the terminal view action. The `_tag` switch is
 * presentation-only: the same failure also propagates UNCAUGHT to the `runMain`
 * teardown, which owns the process exit code. `NmdPartialWriteError` (exit 10)
 * carries which surfaces landed so the view can render the `✗ write-title` row.
 */
const putErrorAction = (error: unknown): PutAction => {
  const tag =
    typeof error === 'object' && error !== null && '_tag' in error
      ? (error as { readonly _tag?: unknown })._tag
      : undefined
  switch (tag) {
    case 'NmdPartialWriteError': {
      const e = error as { readonly body_written?: boolean; readonly title_written?: boolean }
      return {
        _tag: 'SetPartial',
        bodyWritten: e.body_written ?? true,
        titleWritten: e.title_written ?? false,
      }
    }
    case 'NmdConflictError':
      return { _tag: 'SetConflict', message: String(error) }
    default:
      return { _tag: 'SetError', message: String(error) }
  }
}

const putCommand = Command.make(
  'put',
  { page: pageArg, baseHash: baseHashOption, force: forceOption, output: outputOption },
  ({ page, baseHash, force, output }) =>
    commandSpan({
      command: 'put',
      label: basename(page),
      effect: resolvePageArg(page).pipe(
        Effect.flatMap((pageId) =>
          force === false && Option.isNone(baseHash) === true
            ? // Usage error (missing guard): stays OUTSIDE `run` so it never
              // routes through the staged view — a bad-flags failure is not a
              // write outcome. The framework maps it on the error channel.
              Effect.fail(
                new NmdCliError({
                  message:
                    'put requires either --base-hash <hash> (guarded; capture it from `cat`) or --force (concurrency override).',
                }),
              )
            : readStdin().pipe(
                Effect.flatMap((buffer) =>
                  /*
                   * Write path: route the staged write-progress + outcome through
                   * the tui-react OutputMode seam (Slice C). The engine emits stages
                   * via the `ProgressReporter` Tag; `progressReporterTui` bridges each
                   * transition onto `tui.dispatch`. The terminal action carries the
                   * `PutResult`/failure into the view. Engine failures propagate
                   * UNCAUGHT (only `tapErrorCause` dispatches a view action), so the
                   * `runMain` teardown (`editorExitCode`) owns the real exit code
                   * (Conflict→7, Partial→10, PostPushGate→9, …). The app is built
                   * lazily inside the handler (no #787 TDZ risk).
                   */
                  run(
                    getPutApp(),
                    (tui) =>
                      withNotion(
                        putEditorPage({
                          pageId,
                          buffer,
                          force,
                          ...(Option.isSome(baseHash) === true
                            ? { baseHash: baseHash.value as never }
                            : {}),
                        }),
                      ).pipe(
                        Effect.tap((result) =>
                          Effect.sync(() =>
                            tui.dispatch({
                              _tag: 'SetResult',
                              result: {
                                bodyWritten: result.bodyWritten,
                                titleWritten: result.titleWritten,
                                forced: result.forced,
                                baseHash: result.baseHash,
                              },
                            }),
                          ),
                        ),
                        Effect.tapErrorCause((cause) =>
                          Option.match(Cause.failureOption(cause), {
                            onNone: () => Effect.void,
                            onSome: (error) =>
                              Effect.sync(() => tui.dispatch(putErrorAction(error))),
                          }),
                        ),
                        Effect.provide(progressReporterTui(tui.dispatch)),
                      ),
                    { view: React.createElement(PutView, { stateAtom: getPutApp().stateAtom }) },
                  ).pipe(Effect.provide(outputModeLayer(output))),
                ),
              ),
        ),
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
    {
      page: pageArg,
      frontmatter: frontmatterOption,
      readOnly: readOnlyOption,
      output: outputOption,
    },
    ({ page, frontmatter, readOnly, output }) => {
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
              ? // Read-only does no push (no stages, no result to render): keep its
                // existing minimal JSON path so its e2e behavior is unchanged.
                withNotion(editReadOnlyPage({ pageId, mode })).pipe(
                  Effect.map((result): unknown => result),
                  Effect.flatMap(logJson),
                )
              : /*
                 * Push path: route the staged write-progress + outcome through the
                 * tui-react OutputMode seam (Slice B). The engine emits stages via
                 * the `ProgressReporter` Tag; `progressReporterTui` bridges each
                 * transition onto `tui.dispatch`, and `SetResult` carries the final
                 * `EditResult` into the terminal view state. Under `run`, the human
                 * view AND json both go to stdout, switched by `--output` (auto
                 * detects non-tty → json/log), so a pipe stays clean. The app is
                 * built lazily inside the handler (no #787 TDZ risk).
                 */
                run(
                  getEditApp(),
                  (tui) =>
                    withNotion(editEditorPage({ pageId, mode, pageRef: page })).pipe(
                      Effect.tap((result) =>
                        Effect.sync(() =>
                          tui.dispatch({
                            _tag: 'SetResult',
                            result: {
                              outcome: result.outcome,
                              ...(result.conflictPath === undefined
                                ? {}
                                : { conflictPath: result.conflictPath }),
                            },
                          }),
                        ),
                      ),
                      Effect.tapErrorCause((cause) =>
                        Option.match(Cause.failureOption(cause), {
                          onNone: () => Effect.void,
                          onSome: (error) =>
                            Effect.sync(() =>
                              tui.dispatch({ _tag: 'SetError', message: String(error) }),
                            ),
                        }),
                      ),
                      Effect.provide(progressReporterTui(tui.dispatch)),
                    ),
                  { view: React.createElement(EditView, { stateAtom: getEditApp().stateAtom }) },
                ).pipe(Effect.provide(outputModeLayer(output))),
          ),
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
      statusCommand,
      planCommand,
      syncCommand,
      catCommand,
      putCommand,
      editCommand,
    ]),
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
