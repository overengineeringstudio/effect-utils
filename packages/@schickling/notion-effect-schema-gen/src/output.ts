import * as fs from 'node:fs'
import * as path from 'node:path'
import { Effect } from 'effect'

/**
 * Write generated schema code to a file.
 * Creates parent directories if they don't exist.
 */
export const writeSchemaToFile = (code: string, outputPath: string): Effect.Effect<void, Error> =>
  Effect.try({
    try: () => {
      const dir = path.dirname(outputPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      fs.writeFileSync(outputPath, code, 'utf-8')
    },
    catch: (error) =>
      new Error(
        `Failed to write schema to ${outputPath}: ${error instanceof Error ? error.message : String(error)}`,
      ),
  })

/**
 * Format code using the project's formatter (if available).
 * This is a no-op for now, but could be extended to use biome or prettier.
 */
export const formatCode = (code: string): Effect.Effect<string, never> => Effect.succeed(code)
