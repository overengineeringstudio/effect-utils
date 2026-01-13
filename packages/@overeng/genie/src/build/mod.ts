import path from 'node:path'

import * as Cli from '@effect/cli'
import { FileSystem } from '@effect/platform'
import * as PlatformNode from '@effect/platform-node'
import { Effect, Either, Layer, pipe, Stream } from 'effect'

import { CurrentWorkingDirectory } from '@overeng/utils/node'
import { resolveCliVersion } from '@overeng/utils/node/cli-version'

import { findGenieFiles } from './discovery.ts'
import { GenieGenerationFailedError } from './errors.ts'
import { checkFile, generateFile, summarizeResults } from './generation.ts'
import { logTsconfigWarnings, validateTsconfigReferences } from './tsconfig-validation.ts'
import type { GenieCommandConfig, GenieCommandEnv, GenieCommandError } from './types.ts'

export { GenieCheckError, GenieFileError, GenieGenerationFailedError, GenieImportError } from './errors.ts'

const baseVersion = '0.1.0'
const buildVersion = '__CLI_VERSION__'
const version = resolveCliVersion({
  baseVersion,
  buildVersion,
  runtimeStampEnvVar: 'NIX_CLI_BUILD_STAMP',
})

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
  },
  ({ cwd, writeable, watch, check, dryRun }) =>
    Effect.gen(function* () {
      const readOnly = !writeable
      const fs = yield* FileSystem.FileSystem
      const currentWorkingDirectory = yield* CurrentWorkingDirectory
      const resolvedCwd = path.isAbsolute(cwd) ? cwd : path.resolve(currentWorkingDirectory, cwd)

      const genieFiles = yield* findGenieFiles(resolvedCwd)

      if (genieFiles.length === 0) {
        yield* Effect.log('No .genie.ts files found')
        return
      }

      yield* Effect.log(`Found ${genieFiles.length} .genie.ts files`)

      if (check) {
        yield* Effect.all(
          genieFiles.map((genieFilePath) => checkFile({ genieFilePath, cwd: resolvedCwd })),
          { concurrency: 'unbounded' },
        )
        yield* Effect.log('✓ All generated files are up to date')

        // Validate tsconfig references
        const warnings = yield* validateTsconfigReferences({ genieFiles, cwd: resolvedCwd })
        yield* logTsconfigWarnings(warnings)

        return
      }

      if (dryRun) {
        yield* Effect.log('Dry run mode - no files will be modified\n')
      }

      // Generate all files, capturing both successes and failures
      const results = yield* Effect.all(
        genieFiles.map((genieFilePath) =>
          generateFile({ genieFilePath, cwd: resolvedCwd, readOnly, dryRun }).pipe(Effect.either),
        ),
        { concurrency: 'unbounded' },
      )

      // Partition results into successes and failures
      const successes = results.filter(Either.isRight).map((r) => r.right)
      const failures = results.filter(Either.isLeft).map((r) => r.left)

      // Show summary
      const summary = yield* summarizeResults({ successes, failures })

      // Exit with error code if any files failed
      if (summary.failed > 0) {
        return yield* new GenieGenerationFailedError({
          failedCount: summary.failed,
          message: `${summary.failed} file(s) failed to generate`,
        })
      }

      if (watch && !dryRun) {
        yield* Effect.log('\nWatching for changes...')
        yield* pipe(
          fs.watch(resolvedCwd),
          Stream.filter(({ path: p }) => p.endsWith('.genie.ts')),
          Stream.tap(({ path: p }) => {
            const genieFilePath = path.join(resolvedCwd, p)
            return generateFile({ genieFilePath, cwd: resolvedCwd, readOnly }).pipe(
              Effect.catchAll((error) => Effect.logError(error.message)),
            )
          }),
          Stream.runDrain,
        )
      }
    }).pipe(Effect.withSpan('genie')),
)

if (import.meta.main) {
  pipe(
    Cli.Command.run(genieCommand, {
      name: 'genie',
      version,
    })(process.argv),
    Effect.provide(Layer.mergeAll(PlatformNode.NodeContext.layer, CurrentWorkingDirectory.live)),
    PlatformNode.NodeRuntime.runMain,
  )
}
