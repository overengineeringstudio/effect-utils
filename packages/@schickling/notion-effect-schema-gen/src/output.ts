import { type CommandExecutor, FileSystem, Path } from '@effect/platform'
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
    const path = yield* Path.Path

    // Check if biome is available in node_modules
    const cwd = process.cwd()
    const biomePath = path.join(cwd, 'node_modules', '.bin', 'biome')
    const biomeExists = yield* fs.exists(biomePath).pipe(Effect.orElseSucceed(() => false))

    if (!biomeExists) {
      return code
    }

    // Create temp file for formatting
    const tempFile = yield* fs.makeTempFile({ prefix: 'notion-schema-gen-', suffix: '.ts' })

    const formatted = yield* Effect.gen(function* () {
      yield* fs.writeFileString(tempFile, code)

      // Use child_process for biome since CommandExecutor may not be available
      const result = yield* Effect.try({
        try: () => {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { execSync } = require('node:child_process') as typeof import('node:child_process')
          execSync(`npx biome format --write "${tempFile}"`, {
            stdio: 'ignore',
            timeout: 10000,
          })
          return true
        },
        catch: () => false,
      })

      if (result) {
        return yield* fs.readFileString(tempFile)
      }
      return code
    }).pipe(Effect.ensuring(fs.remove(tempFile).pipe(Effect.ignore)))

    return formatted
  }).pipe(Effect.orElseSucceed(() => code))
