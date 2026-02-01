import path from 'node:path'

import * as Cli from '@effect/cli'
import { FileSystem } from '@effect/platform'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { Effect, Either, Layer, Option, pipe, Stream } from 'effect'
import React from 'react'

import { outputOption, outputModeLayer } from '@overeng/tui-react'
import { CurrentWorkingDirectory } from '@overeng/utils/node'
import { resolveCliVersion } from '@overeng/utils/node/cli-version'

import { GenieApp } from './app.ts'
import { findGenieFiles } from './discovery.ts'
import type { GenieFileError } from './errors.ts'
import { GenieGenerationFailedError } from './errors.ts'
import { checkFile, errorOriginatesInFile, generateFile, isTdzError } from './generation.ts'
import {
  createInitialGenieState,
  type GenieFileStatus,
  type GenieSummary,
  type GenieMode,
} from './schema.ts'
import { logTsconfigWarnings, validateTsconfigReferences } from './tsconfig-validation.ts'
import type { GenieCommandConfig, GenieCommandEnv, GenieCommandError } from './types.ts'
import { runGenieValidationPlugins } from './validation.ts'
import { GenieConnectedView } from './view.tsx'

export {
  GenieCheckError,
  GenieFileError,
  GenieGenerationFailedError,
  GenieImportError,
} from './errors.ts'

/** Convention paths for oxfmt config relative to workspace root (checked in order) */
const OXFMT_CONFIG_CONVENTION_PATHS = ['.oxfmtrc.json', 'oxfmt.json']

/** Resolve the oxfmt config path: explicit option → convention paths → none */
const resolveOxfmtConfigPath = Effect.fn('resolveOxfmtConfigPath')(function* ({
  explicitPath,
  cwd,
}: {
  explicitPath: Option.Option<string>
  cwd: string
}) {
  // Use explicit path if provided
  if (Option.isSome(explicitPath)) {
    return explicitPath
  }
  // Check convention paths in order
  const fs = yield* FileSystem.FileSystem
  for (const conventionPath of OXFMT_CONFIG_CONVENTION_PATHS) {
    const fullPath = path.join(cwd, conventionPath)
    const exists = yield* fs.exists(fullPath)
    if (exists) {
      return Option.some(fullPath)
    }
  }
  return Option.none()
})

/** Map generation result tag to file status */
const mapResultToStatus = (result: { _tag: string }): GenieFileStatus => {
  switch (result._tag) {
    case 'created':
      return 'created'
    case 'updated':
      return 'updated'
    case 'unchanged':
      return 'unchanged'
    case 'skipped':
      return 'skipped'
    default:
      return 'error'
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
  ({ cwd, writeable, watch, check, dryRun, oxfmtConfig, output }) =>
    Effect.gen(function* () {
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

      // Start TUI
      const tui = yield* GenieApp.run(<GenieConnectedView />)

      // Set initial state
      tui.dispatch({
        _tag: 'SetState',
        state: createInitialGenieState({ cwd: resolvedCwd, mode }),
      })

      // Discover genie files
      const genieFiles = yield* findGenieFiles(resolvedCwd)

      if (genieFiles.length === 0) {
        tui.dispatch({
          _tag: 'Complete',
          summary: { created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 },
        })
        yield* tui.unmount({ mode: 'persist' })
        return
      }

      // Dispatch files discovered
      tui.dispatch({
        _tag: 'FilesDiscovered',
        files: genieFiles.map((filePath) => ({
          path: filePath,
          relativePath: path.relative(resolvedCwd, filePath.replace('.genie.ts', '')),
        })),
      })

      if (check) {
        // Check mode - verify all files are up to date
        const results = yield* Effect.all(
          genieFiles.map((genieFilePath) =>
            Effect.gen(function* () {
              const targetFilePath = genieFilePath.replace('.genie.ts', '')
              tui.dispatch({ _tag: 'FileStarted', path: genieFilePath })

              const result = yield* checkFile({
                genieFilePath,
                cwd: resolvedCwd,
                oxfmtConfigPath,
              }).pipe(
                Effect.map(() => ({ success: true as const })),
                Effect.catchAll((error) => Effect.succeed({ success: false as const, error })),
              )

              if (result.success) {
                tui.dispatch({ _tag: 'FileCompleted', path: genieFilePath, status: 'unchanged' })
              } else {
                tui.dispatch({
                  _tag: 'FileCompleted',
                  path: genieFilePath,
                  status: 'error',
                  message: result.error.message,
                })
              }

              return result
            }),
          ),
          { concurrency: 'unbounded' },
        )

        const failed = results.filter((r) => !r.success).length
        const summary: GenieSummary = {
          created: 0,
          updated: 0,
          unchanged: results.filter((r) => r.success).length,
          skipped: 0,
          failed,
        }

        tui.dispatch({ _tag: 'Complete', summary })

        // Persist output before exiting
        yield* tui.unmount({ mode: 'persist' })

        // Validate tsconfig references
        const warnings = yield* validateTsconfigReferences({
          genieFiles,
          cwd: resolvedCwd,
        })
        yield* logTsconfigWarnings(warnings)

        if (failed > 0) {
          return yield* new GenieGenerationFailedError({
            failedCount: failed,
            message: `${failed} file(s) are out of date`,
          })
        }

        yield* runGenieValidationPlugins({ cwd: resolvedCwd }).pipe(
          Effect.catchAll((error) =>
            Effect.fail(
              new GenieGenerationFailedError({
                failedCount: 1,
                message: error.message,
              }),
            ),
          ),
        )

        return
      }

      // Generate mode (including dry-run)
      const results = yield* Effect.all(
        genieFiles.map((genieFilePath) =>
          Effect.gen(function* () {
            tui.dispatch({ _tag: 'FileStarted', path: genieFilePath })

            const result = yield* generateFile({
              genieFilePath,
              cwd: resolvedCwd,
              readOnly,
              dryRun,
              oxfmtConfigPath,
            }).pipe(Effect.either)

            if (Either.isRight(result)) {
              const status = mapResultToStatus(result.right)
              const message = result.right._tag === 'updated' ? result.right.diffSummary : undefined
              tui.dispatch({
                _tag: 'FileCompleted',
                path: genieFilePath,
                status,
                message,
              })
              return result
            } else {
              tui.dispatch({
                _tag: 'FileCompleted',
                path: genieFilePath,
                status: 'error',
                message: result.left.message,
              })
              return result
            }
          }),
        ),
        { concurrency: 'unbounded' },
      )

      // Partition results
      const successes = results.filter(Either.isRight).map((r) => r.right)
      const failures = results.filter(Either.isLeft).map((r) => r.left)

      // Check for TDZ errors
      const hasTdzErrors = failures.some((f) => isTdzError(f.cause))

      if (failures.length > 0 && hasTdzErrors) {
        // Re-validate sequentially to identify root causes
        const revalidateErrors: Array<{
          genieFilePath: string
          error: GenieFileError
          isRootCause: boolean
        }> = []

        for (const genieFilePath of genieFiles) {
          const result = yield* generateFile({
            genieFilePath,
            cwd: resolvedCwd,
            readOnly,
            dryRun,
            oxfmtConfigPath,
          }).pipe(Effect.either)

          if (Either.isLeft(result)) {
            const error = result.left
            revalidateErrors.push({
              genieFilePath,
              error,
              isRootCause: errorOriginatesInFile({
                error: error.cause,
                filePath: genieFilePath,
              }),
            })
          }
        }

        const rootCauses = revalidateErrors.filter((e) => e.isRootCause)
        const dependentCount = revalidateErrors.length - rootCauses.length

        // Update state with revalidated errors
        for (const { genieFilePath, error, isRootCause } of revalidateErrors) {
          tui.dispatch({
            _tag: 'FileCompleted',
            path: genieFilePath,
            status: 'error',
            message: isRootCause ? error.message : 'Failed due to dependency error',
          })
        }

        const summary: GenieSummary = {
          created: successes.filter((s) => s._tag === 'created').length,
          updated: successes.filter((s) => s._tag === 'updated').length,
          unchanged: successes.filter((s) => s._tag === 'unchanged').length,
          skipped: successes.filter((s) => s._tag === 'skipped').length,
          failed: revalidateErrors.length,
        }

        tui.dispatch({ _tag: 'Complete', summary })

        // Persist output before exiting
        yield* tui.unmount({ mode: 'persist' })

        return yield* new GenieGenerationFailedError({
          failedCount: revalidateErrors.length,
          message: `${rootCauses.length} root cause error(s), ${dependentCount} dependent failure(s)`,
        })
      }

      // No TDZ errors - compute summary
      const summary: GenieSummary = {
        created: successes.filter((s) => s._tag === 'created').length,
        updated: successes.filter((s) => s._tag === 'updated').length,
        unchanged: successes.filter((s) => s._tag === 'unchanged').length,
        skipped: successes.filter((s) => s._tag === 'skipped').length,
        failed: failures.length,
      }

      tui.dispatch({ _tag: 'Complete', summary })

      // Persist output before exiting (non-watch mode)
      if (!watch || dryRun) {
        yield* tui.unmount({ mode: 'persist' })
      }

      // Exit with error code if any files failed
      if (summary.failed > 0) {
        return yield* new GenieGenerationFailedError({
          failedCount: summary.failed,
          message: `${summary.failed} file(s) failed to generate`,
        })
      }

      if (watch && !dryRun) {
        // Watch mode
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
                  relativePath: path.relative(resolvedCwd, filePath.replace('.genie.ts', '')),
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
                      newGenieFiles.length - 1 + (result.right._tag === 'unchanged' ? 1 : 0),
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
    }).pipe(Effect.provide(outputModeLayer(output)), Effect.scoped, Effect.withSpan('genie')),
)

// =============================================================================
// CLI Runner
// =============================================================================

const GENIE_VERSION = '0.1.0'

// Build stamp placeholder replaced by nix build with NixStamp JSON
const buildStamp = '__CLI_BUILD_STAMP__'
const version = resolveCliVersion({
  baseVersion: GENIE_VERSION,
  buildStamp,
})

const baseLayer = Layer.mergeAll(NodeContext.layer, CurrentWorkingDirectory.live)

Cli.Command.run(genieCommand, {
  name: 'genie',
  version,
})(process.argv).pipe(Effect.scoped, Effect.provide(baseLayer), NodeRuntime.runMain)
