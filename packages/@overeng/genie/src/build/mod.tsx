import path from 'node:path'

import * as Cli from '@effect/cli'
import { FileSystem } from '@effect/platform'
import { Effect, Either, pipe, PubSub, Queue, Stream } from 'effect'
import React from 'react'

import { run } from '@overeng/tui-react'
import { outputOption, outputModeLayer } from '@overeng/tui-react/node'
import { CurrentWorkingDirectory } from '@overeng/utils/node'

import { GenieApp } from './app.ts'
import {
  checkAll,
  generateAll,
  mapResultToStatus,
  OXFMT_CONFIG_CONVENTION_PATHS,
  resolveOxfmtConfigPath,
} from './core.ts'
import { findGenieFiles } from './discovery.ts'
import { GenieGenerationFailedError } from './errors.ts'
import { type GenieEvent, GenieEventBus } from './events.ts'
import { generateFile } from './generation.ts'
import { createInitialGenieState, type GenieSummary, type GenieMode } from './schema.ts'
import type { GenieCommandConfig, GenieCommandEnv, GenieCommandError } from './types.ts'
import { GenieView } from './view.tsx'

export {
  GenieCheckError,
  GenieFileError,
  GenieGenerationFailedError,
  GenieImportError,
} from './errors.ts'

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
  }
}

/** Genie CLI command - generates files from .genie.ts source files */
export const genieCommand: Cli.Command.Command<
  'genie',
  GenieCommandEnv,
  GenieCommandError,
  GenieCommandConfig
> = Cli.Command.make(
  'genie',
  {
    cwd: Cli.Options.text('cwd').pipe(
      Cli.Options.withDescription('Working directory to search for .genie.ts files'),
      Cli.Options.withDefault('.'),
    ),
    watch: Cli.Options.boolean('watch').pipe(
      Cli.Options.withDescription('Watch for changes and regenerate automatically'),
      Cli.Options.withDefault(false),
    ),
    writeable: Cli.Options.boolean('writeable').pipe(
      Cli.Options.withDescription('Generate files as writable (default: read-only)'),
      Cli.Options.withDefault(false),
    ),
    check: Cli.Options.boolean('check').pipe(
      Cli.Options.withDescription('Check if generated files are up to date (for CI)'),
      Cli.Options.withDefault(false),
    ),
    dryRun: Cli.Options.boolean('dry-run').pipe(
      Cli.Options.withDescription('Preview changes without writing files'),
      Cli.Options.withDefault(false),
    ),
    oxfmtConfig: Cli.Options.file('oxfmt-config').pipe(
      Cli.Options.withDescription(
        `Path to oxfmt config file (default: ${OXFMT_CONFIG_CONVENTION_PATHS.join(' or ')})`,
      ),
      Cli.Options.optional,
    ),
    output: outputOption,
  },
  ({ cwd, writeable, watch, check, dryRun, oxfmtConfig, output }) => {
    const cliMode = watch ? 'watch' : check ? 'check' : dryRun ? 'dry-run' : 'generate'
    const handler = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const readOnly = !writeable
      const currentWorkingDirectory = yield* CurrentWorkingDirectory
      const inputCwd = path.isAbsolute(cwd) ? cwd : path.resolve(currentWorkingDirectory, cwd)

      /**
       * CRITICAL: Normalize cwd to its real path (resolve symlinks).
       */
      const resolvedCwd = yield* fs
        .realPath(inputCwd)
        .pipe(Effect.catchAll(() => Effect.succeed(inputCwd)))

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
              yield* Queue.take(sub).pipe(
                Effect.tap((event) => Effect.sync(() => dispatchEvent(tui, event))),
                Effect.forever,
                Effect.forkScoped,
              )

              if (check) {
                yield* checkAll({ cwd: resolvedCwd, oxfmtConfigPath }).pipe(
                  Effect.provideService(GenieEventBus, bus),
                )
              } else {
                yield* generateAll({
                  cwd: resolvedCwd,
                  readOnly,
                  dryRun,
                  oxfmtConfigPath,
                }).pipe(Effect.provideService(GenieEventBus, bus))
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
                      const newGenieFiles = yield* findGenieFiles(resolvedCwd)

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
                      }).pipe(Effect.either)

                      if (Either.isRight(result)) {
                        const message =
                          result.right._tag === 'updated' ? result.right.diffSummary : undefined
                        tui.dispatch({
                          _tag: 'FileCompleted',
                          path: genieFilePath,
                          status: mapResultToStatus(result.right),
                          message,
                        })
                      } else {
                        tui.dispatch({
                          _tag: 'FileCompleted',
                          path: genieFilePath,
                          status: 'error',
                          message: result.left.message,
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

                      const watchSummary: GenieSummary = Either.isRight(result)
                        ? {
                            created: result.right._tag === 'created' ? 1 : 0,
                            updated: result.right._tag === 'updated' ? 1 : 0,
                            unchanged:
                              newGenieFiles.length -
                              1 +
                              (result.right._tag === 'unchanged' ? 1 : 0),
                            skipped: result.right._tag === 'skipped' ? 1 : 0,
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
            }),
          ),
        { view: <GenieView stateAtom={GenieApp.stateAtom} /> },
      )
    }).pipe(
      Effect.provide(outputModeLayer(output)),
      Effect.withSpan(`genie/${cliMode}`, { attributes: { 'cli.mode': cliMode } }),
    )
    return handler
  },
)
