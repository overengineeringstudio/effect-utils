import path from 'node:path'

import { Effect, Fiber, Option, pipe, PubSub, Result, Stream } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as Cli from 'effect/unstable/cli'
import React from 'react'

import { run } from '@overeng/tui-react'
import { outputOption, outputModeLayer } from '@overeng/tui-react/node'
import { CurrentWorkingDirectory } from '@overeng/utils/node'

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
import { createInitialGenieState, type GenieSummary, type GenieMode } from '../core/schema.ts'
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
                  // Watch mode - uses low-level APIs directly (CLI-specific)
                  yield* pipe(
                    fs.watch(resolvedCwd),
                    Stream.filter(({ path: p }) => p.endsWith('.genie.ts')),
                    Stream.tap(({ path: p }) => {
                      const genieFilePath = path.join(resolvedCwd, p)

                      // Reset for new watch cycle
                      tui.dispatch({ _tag: 'WatchReset' })

                      return Effect.gen(function* () {
                        // Re-discover files (in case new ones were added)
                        const newGenieFiles = (yield* findGenieFiles(resolvedCwd)).map((file) =>
                          path.resolve(resolvedCwd, file),
                        )

                        tui.dispatch({
                          _tag: 'FilesDiscovered',
                          files: newGenieFiles.map((filePath) => ({
                            path: filePath,
                            relativePath: path.relative(
                              resolvedCwd,
                              filePath.replace('.genie.ts', ''),
                            ),
                          })),
                        })

                        // Regenerate the changed file
                        tui.dispatch({ _tag: 'FileStarted', path: genieFilePath })

                        const result = yield* generateFile({
                          genieFilePath,
                          cwd: resolvedCwd,
                          readOnly,
                          oxfmtConfigPath,
                        }).pipe(Effect.result)

                        if (Result.isSuccess(result)) {
                          const message =
                            result.success._tag === 'updated'
                              ? result.success.diffSummary
                              : undefined
                          tui.dispatch({
                            _tag: 'FileCompleted',
                            path: genieFilePath,
                            status: mapResultToStatus(result.success),
                            message,
                          })
                        } else {
                          tui.dispatch({
                            _tag: 'FileCompleted',
                            path: genieFilePath,
                            status: 'error',
                            message: result.failure.message,
                          })
                        }

                        // Mark all other files as unchanged
                        for (const otherFile of newGenieFiles) {
                          if (otherFile !== genieFilePath) {
                            tui.dispatch({
                              _tag: 'FileCompleted',
                              path: otherFile,
                              status: 'unchanged',
                            })
                          }
                        }

                        const watchSummary: GenieSummary = Result.isSuccess(result)
                          ? {
                              created: result.success._tag === 'created' ? 1 : 0,
                              updated: result.success._tag === 'updated' ? 1 : 0,
                              unchanged:
                                newGenieFiles.length -
                                1 +
                                (result.success._tag === 'unchanged' ? 1 : 0),
                              skipped: result.success._tag === 'skipped' ? 1 : 0,
                              failed: 0,
                            }
                          : {
                              created: 0,
                              updated: 0,
                              unchanged: newGenieFiles.length - 1,
                              skipped: 0,
                              failed: 1,
                            }

                        tui.dispatch({ _tag: 'Complete', summary: watchSummary })
                      })
                    }),
                    Stream.runDrain,
                  )
                }
              }).pipe(
                Effect.ensuring(
                  Effect.gen(function* () {
                    const _ = yield* Fiber.interrupt(consumerFiber)
                    const pendingEvents = yield* PubSub.takeAll(sub)
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
