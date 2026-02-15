import { FileSystem } from '@effect/platform'
import type * as CommandExecutor from '@effect/platform/CommandExecutor'
import { Effect } from 'effect'

import { EffectPath, type AbsoluteFilePath } from '@overeng/effect-path'
import { type CurrentWorkingDirectory, cmd } from '@overeng/utils/node'

/** Options for writing generated schema files */
export interface WriteSchemaToFileOptions {
  /** The generated code to write */
  readonly code: string
  /** Output file path (absolute) */
  readonly outputPath: AbsoluteFilePath
  /** If true, the file will remain writable; if false (default), file will be made read-only */
  readonly writable?: boolean
}

/** Read-only permission (0o444 = r--r--r--) */
const READ_ONLY_MODE = 0o444

/** Read-write permission (0o644 = rw-r--r--) */
const READ_WRITE_MODE = 0o644

/**
 * Write generated schema code to a file.
 * Creates parent directories if they don't exist.
 * By default, makes the file read-only to discourage manual edits.
 * If the file already exists and is read-only, it will be made writable before writing.
 */
export const writeSchemaToFile = (
  options: WriteSchemaToFileOptions,
): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const { code, outputPath, writable = false } = options

    const dir = EffectPath.ops.parent(outputPath)

    // Create directory if it doesn't exist
    const dirExists = yield* fs.exists(dir)
    if (dirExists === false) {
      yield* fs.makeDirectory(dir, { recursive: true })
    }

    // If file exists, make it writable before overwriting (handles read-only files)
    const fileExists = yield* fs.exists(outputPath)
    if (fileExists === true) {
      yield* fs.chmod(outputPath, READ_WRITE_MODE)
    }

    yield* fs.writeFileString(outputPath, code)

    // Set file permissions based on writable option
    if (writable === false) {
      yield* fs.chmod(outputPath, READ_ONLY_MODE)
    }
  }).pipe(
    Effect.mapError(
      (error) =>
        new Error(
          `Failed to write schema to ${options.outputPath}: ${error instanceof Error ? error.message : String(error)}`,
        ),
    ),
  )

/**
 * Format code using oxfmt if available.
 * Falls back to returning unformatted code if oxfmt is not available or formatting fails.
 */
export const formatCode = (
  code: string,
): Effect.Effect<
  string,
  never,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor | CurrentWorkingDirectory
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    // Create temp file for formatting
    const tempFile = yield* fs.makeTempFile({
      prefix: 'notion-schema-gen-',
      suffix: '.ts',
    })

    const formatted = yield* Effect.gen(function* () {
      yield* fs.writeFileString(tempFile, code)

      const didFormat = yield* cmd(['oxfmt', '--write', tempFile]).pipe(
        Effect.as(true),
        Effect.catchAll(() => Effect.succeed(false)),
      )

      if (didFormat === true) {
        return yield* fs.readFileString(tempFile)
      }
      return code
    }).pipe(Effect.ensuring(fs.remove(tempFile).pipe(Effect.ignore)))

    return formatted
  }).pipe(Effect.orElseSucceed(() => code))
