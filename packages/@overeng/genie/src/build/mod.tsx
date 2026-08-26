import path from 'node:path'

import { Effect, FileSystem, Fiber, Option, pipe, PubSub, Result, Stream } from 'effect'
import type { Path } from 'effect'
import type { PlatformError } from 'effect/PlatformError'
import * as Cli from 'effect/unstable/cli'
import * as CommandExecutor from 'effect/unstable/process/ChildProcessSpawner'
import React from 'react'

import { run } from '@overeng/tui-react'
import { outputOption, outputModeLayer } from '@overeng/tui-react/node'
import { CurrentWorkingDirectory, watchCauseMessage, watchScoped } from '@overeng/utils/node'

import {
  checkAll,
  generateAll,
  mapResultToStatus,
  OXFMT_CONFIG_CONVENTION_PATHS,
  resolveOxfmtConfigPath,
} from '../core/core.ts'
import { findGenieFiles } from '../core/discovery.ts'
import { GenieGenerationFailedError } from '../core/errors.ts'
import { type GenieEvent, GenieEventBus } from '../core/events.ts'
import { generateFile } from '../core/generation.ts'
import { withCliModeSpan } from '../core/observability.ts'
import { GENERATOR_PHASES, type GeneratorPhase } from '../core/phase.ts'
import {
  createInitialGenieState,
  type GenieAction,
  type GenieSummary,
  type GenieMode,
} from '../core/schema.ts'
import { GenieApp } from './app.ts'
import { GenieView } from './view.tsx'

export {
  GenieCheckError,
  GenieFileError,
  GenieGenerationFailedError,
  GenieImportError,
} from '../core/errors.ts'

/** Bridge GenieEvent stream to TUI dispatch. */
const dispatchEvent = (tui: { dispatch: (action: any) => void }, event: GenieEvent): void => {
  switch (event._tag) {
    case 'FilesDiscovered':
      tui.dispatch({ _tag: 'FilesDiscovered', files: event.files })
      break
    case 'FileStarted':
      tui.dispatch({ _tag: 'FileStarted', path: event.path })
      break
    case 'FileCompleted':
      tui.dispatch({
        _tag: 'FileCompleted',
        path: event.path,
        status: event.status,
        message: event.message,
      })
      break
    case 'Complete':
      tui.dispatch({ _tag: 'Complete', summary: event.summary })
      break
    case 'Error':
      tui.dispatch({ _tag: 'Error', message: event.message })
      break
    case 'ValidationWarnings':
      tui.dispatch({ _tag: 'ValidationWarnings', message: event.message })
      break
  }
}

/**
 * One coalesced watch cycle: regenerate every changed file in the batch and
 * drive the TUI exactly once per burst (one WatchReset, one Complete).
 */
export const runWatchCycle = (opts: {
  /** Absolute paths of changed `*.genie.ts` files for this window. */
  readonly changedPaths: ReadonlyArray<string>
  readonly cwd: string
  readonly readOnly: boolean
  readonly oxfmtConfigPath: Option.Option<string>
  readonly tui: { dispatch: (action: GenieAction) => void }
}): Effect.Effect<
  GenieSummary,
  PlatformError,
  FileSystem.FileSystem | CommandExecutor.ChildProcessSpawner | Path.Path
> =>
  Effect.gen(function* () {
    const changedPaths = new Set(opts.changedPaths)

    // Reset for a new watch cycle — one reset per coalesced burst.
    opts.tui.dispatch({ _tag: 'WatchReset' })

    // Re-discover files (in case new ones were added)
    const newGenieFiles = (yield* findGenieFiles(opts.cwd)).map((file) =>
      path.resolve(opts.cwd, file),
    )

    opts.tui.dispatch({
      _tag: 'FilesDiscovered',
      files: newGenieFiles.map((filePath) => ({
        path: filePath,
        relativePath: path.relative(opts.cwd, filePath.replace('.genie.ts', '')),
      })),
    })

    let created = 0
    let updated = 0
    let unchangedCount = 0
    let skipped = 0
    let failed = 0

    // Regenerate each changed file
    for (const genieFilePath of opts.changedPaths) {
      opts.tui.dispatch({ _tag: 'FileStarted', path: genieFilePath })

      const result = yield* generateFile({
        genieFilePath,
        cwd: opts.cwd,
        readOnly: opts.readOnly,
        oxfmtConfigPath: opts.oxfmtConfigPath,
      }).pipe(Effect.result)

      if (result._tag === 'Success') {
        if (result.success._tag === 'created') created += 1
        else if (result.success._tag === 'updated') updated += 1
        else if (result.success._tag === 'unchanged') unchangedCount += 1
        else skipped += 1
        opts.tui.dispatch({
          _tag: 'FileCompleted',
          path: genieFilePath,
          status: mapResultToStatus(result.success),
          message: result.success._tag === 'updated' ? result.success.diffSummary : undefined,
        })
      } else {
        failed += 1
        opts.tui.dispatch({
          _tag: 'FileCompleted',
          path: genieFilePath,
          status: 'error',
          message: result.failure.message,
        })
      }
    }

    // Mark all other files as unchanged
    for (const otherFile of newGenieFiles) {
      if (!changedPaths.has(otherFile)) {
        unchangedCount += 1
        opts.tui.dispatch({ _tag: 'FileCompleted', path: otherFile, status: 'unchanged' })
      }
    }

    const summary: GenieSummary = {
      created,
      updated,
      unchanged: unchangedCount,
      skipped,
      failed,
    }
    opts.tui.dispatch({ _tag: 'Complete', summary })
    return summary
  })

/** Genie CLI command - generates files from .genie.ts source files */

export const genieCommand = Cli.Command.make(
  'genie',
  {
    cwd: Cli.Flag.string('cwd').pipe(
      Cli.Flag.withDescription('Working directory to search for .genie.ts files'),
      Cli.Flag.withDefault('.'),
    ),
    watch: Cli.Flag.boolean('watch').pipe(
      Cli.Flag.withDescription('Watch for changes and regenerate automatically'),
      Cli.Flag.withDefault(false),
    ),
    writeable: Cli.Flag.boolean('writeable').pipe(
      Cli.Flag.withDescription('Generate files as writable (default: read-only)'),
      Cli.Flag.withDefault(false),
    ),
    check: Cli.Flag.boolean('check').pipe(
      Cli.Flag.withDescription('Check if generated files are up to date (for CI)'),
      Cli.Flag.withDefault(false),
    ),
    dryRun: Cli.Flag.boolean('dry-run').pipe(
      Cli.Flag.withDescription('Preview changes without writing files'),
      Cli.Flag.withDefault(false),
    ),
    deferValidation: Cli.Flag.boolean('defer-validation').pipe(
      Cli.Flag.withDescription(
        'Generate projections before a repair step; the caller must finish with genie --check',
      ),
      Cli.Flag.withDefault(false),
    ),
    phase: Cli.Flag.choice('phase', GENERATOR_PHASES).pipe(
      Cli.Flag.withDescription(
        'Only run generators declaring this phase (bootstrap runs before install; default: all phases)',
      ),
      Cli.Flag.optional,
    ),
    oxfmtConfig: Cli.Flag.file('oxfmt-config').pipe(
      Cli.Flag.withDescription(
        `Path to oxfmt config file (default: ${OXFMT_CONFIG_CONVENTION_PATHS.join(' or ')})`,
      ),
      Cli.Flag.optional,
    ),
    output: outputOption,
  },
  ({ cwd, writeable, watch, check, dryRun, deferValidation, phase, oxfmtConfig, output }) => {
    const cliMode = watch ? 'watch' : check ? 'check' : dryRun ? 'dry-run' : 'generate'
    const selectedPhase: GeneratorPhase | undefined = Option.getOrUndefined(phase)
    const handler = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const readOnly = !writeable
      const currentWorkingDirectory = yield* CurrentWorkingDirectory
      const inputCwd = path.isAbsolute(cwd) ? cwd : path.resolve(currentWorkingDirectory, cwd)

      /**
       * CRITICAL: Normalize cwd to its real path (resolve symlinks).
       */
      const resolvedCwd = yield* fs.realPath(inputCwd).pipe(Effect.orElseSucceed(() => inputCwd))

      // Resolve oxfmt config path
      const oxfmtConfigPath = yield* resolveOxfmtConfigPath({
        explicitPath: oxfmtConfig,
        cwd: resolvedCwd,
      })

      // Determine mode
      const mode: GenieMode = check ? 'check' : dryRun ? 'dry-run' : 'generate'

      yield* run(
        GenieApp,
        (tui) =>
          Effect.scoped(
            Effect.gen(function* () {
              // Set initial state
              tui.dispatch({
                _tag: 'SetState',
                state: createInitialGenieState({ cwd: resolvedCwd, mode }),
              })

              // Create event bus and subscribe for TUI progress
              const bus = yield* PubSub.unbounded<GenieEvent>()
              const sub = yield* PubSub.subscribe(bus)
              const consumerFiber = yield* PubSub.take(sub).pipe(
                Effect.tap((event) => Effect.sync(() => dispatchEvent(tui, event))),
                Effect.forever,
                Effect.forkScoped,
              )

              const syncStateFromGenerationError = Effect.fn('genie/syncStateFromGenerationError')(
                function* (error: GenieGenerationFailedError) {
                  const currentState = tui.getState()
                  const summary: GenieSummary = {
                    created: error.files.filter((file) => file.status === 'created').length,
                    updated: error.files.filter((file) => file.status === 'updated').length,
                    unchanged: error.files.filter((file) => file.status === 'unchanged').length,
                    skipped: error.files.filter((file) => file.status === 'skipped').length,
                    failed: error.files.filter((file) => file.status === 'error').length,
                  }

                  tui.dispatch({
                    _tag: 'SetState',
                    state: {
                      ...currentState,
                      phase: 'complete',
                      files: error.files,
                      summary,
                    },
                  })
                },
              )

              yield* Effect.gen(function* () {
                if (check) {
                  yield* checkAll({ cwd: resolvedCwd, oxfmtConfigPath, phase: selectedPhase }).pipe(
                    Effect.provideService(GenieEventBus, bus),
                    Effect.catchTag('GenieGenerationFailedError', (error) =>
                      syncStateFromGenerationError(error).pipe(Effect.andThen(Effect.fail(error))),
                    ),
                  )
                } else {
                  yield* generateAll({
                    cwd: resolvedCwd,
                    readOnly,
                    dryRun,
                    oxfmtConfigPath,
                    phase: selectedPhase,
                    validate: !deferValidation,
                  }).pipe(
                    Effect.provideService(GenieEventBus, bus),
                    Effect.catchTag('GenieGenerationFailedError', (error) =>
                      syncStateFromGenerationError(error).pipe(Effect.andThen(Effect.fail(error))),
                    ),
                  )
                }

                if (watch && !check && !dryRun) {
                  // Watch mode — recursive scoped watch with a 250 ms
                  // coalescing window (context/effect-4/
                  // watch-recursion-experiments.md §3.2). Discovery is already
                  // recursive, so the previous non-recursive watcher silently
                  // never fired for nested *.genie.ts edits; the window
                  // collapses editor write bursts into one regeneration pass.
                  yield* pipe(
                    watchScoped({
                      roots: [resolvedCwd],
                      scope: (absolutePath) => absolutePath.endsWith('.genie.ts'),
                    }),
                    Stream.mapEffect((batch) =>
                      runWatchCycle({
                        changedPaths: batch.map((group) => group.path),
                        cwd: resolvedCwd,
                        readOnly,
                        oxfmtConfigPath,
                        tui,
                      }),
                    ),
                    // Surface watch-stream failures instead of dying silently;
                    // the stream ends after a fatal watcher error.
                    Stream.catchCause((cause) =>
                      Stream.fromEffect(
                        Effect.sync(() => {
                          tui.dispatch({
                            _tag: 'Error',
                            message: `watch error: ${watchCauseMessage(cause)}`,
                          })
                        }),
                      ),
                    ),
                    Stream.runDrain,
                  )
                }
              }).pipe(
                Effect.ensuring(
                  Effect.gen(function* () {
                    const _ = yield* Fiber.interrupt(consumerFiber)
                    // Drain any events published but not yet consumed. Must be non-blocking:
                    // `PubSub.takeAll` suspends when the subscription is empty, which deadlocks
                    // the finalizer (and the whole CLI) whenever the consumer fiber already
                    // drained every event before the scope closed.
                    const pendingEvents = yield* PubSub.takeUpTo(sub, Number.MAX_SAFE_INTEGER)
                    for (const event of pendingEvents) {
                      yield* Effect.sync(() => dispatchEvent(tui, event))
                    }
                  }),
                ),
              )
            }),
          ),
        { view: <GenieView stateAtom={GenieApp.stateAtom} /> },
      )
    }).pipe(Effect.provide(outputModeLayer(output)), withCliModeSpan(cliMode))

    return handler
  },
)
