import { Command, type CommandExecutor, FileSystem, Path } from '@effect/platform'
import { Effect } from 'effect'

/**
 * Write generated schema code to a file.
 * Creates parent directories if they don't exist.
 */
export const writeSchemaToFile = (
  code: string,
  outputPath: string,
): Effect.Effect<void, Error, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const dir = path.dirname(outputPath)

    // Create directory if it doesn't exist
    const dirExists = yield* fs.exists(dir)
    if (!dirExists) {
      yield* fs.makeDirectory(dir, { recursive: true })
    }

    yield* fs.writeFileString(outputPath, code)
  }).pipe(
    Effect.mapError(
      (error) =>
        new Error(
          `Failed to write schema to ${outputPath}: ${error instanceof Error ? error.message : String(error)}`,
        ),
    ),
  )

/**
 * Format code using Biome if available.
 * Falls back to returning unformatted code if Biome is not available or formatting fails.
 */
export const formatCode = (
  code: string,
): Effect.Effect<
  string,
  never,
  FileSystem.FileSystem | Path.Path | CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    // Create temp file for formatting
    const tempFile = yield* fs.makeTempFile({ prefix: 'notion-schema-gen-', suffix: '.ts' })

    const formatted = yield* Effect.gen(function* () {
      yield* fs.writeFileString(tempFile, code)

      const exitCode = yield* Command.exitCode(
        Command.make('biome', 'format', '--write', tempFile),
      ).pipe(Effect.catchAll(() => Effect.succeed(1)))

      if (exitCode === 0) {
        return yield* fs.readFileString(tempFile)
      }
      return code
    }).pipe(Effect.ensuring(fs.remove(tempFile).pipe(Effect.ignore)))

    return formatted
  }).pipe(Effect.orElseSucceed(() => code))
