/**
 * JSON Schema Generator
 *
 * Generates a JSON Schema file for megarepo.json configuration.
 * Output: megarepo.schema.json in the specified location.
 */

import { FileSystem } from '@effect/platform'
import { Effect } from 'effect'

import {
  type AbsoluteDirPath,
  EffectPath,
  generateJsonSchema,
  type MegarepoConfig,
} from '../config.ts'

export interface SchemaGeneratorOptions {
  /** Path to the megarepo root */
  readonly megarepoRoot: AbsoluteDirPath
  /** The megarepo config (unused, but kept for consistency) */
  readonly config: typeof MegarepoConfig.Type
  /** Output path for the schema file (relative to megarepo root) */
  readonly outputPath?: string
}

/**
 * Generate JSON Schema content
 */
export const generateSchemaContent = (): string => {
  const schema = generateJsonSchema()
  return JSON.stringify(schema, null, 2) + '\n'
}

/**
 * Generate JSON Schema file
 */
export const generateSchema = (options: SchemaGeneratorOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    const content = generateSchemaContent()
    const outputPath = EffectPath.ops.join(
      options.megarepoRoot,
      EffectPath.unsafe.relativeFile(options.outputPath ?? 'megarepo.schema.json'),
    )

    yield* fs.writeFileString(outputPath, content)

    return { path: outputPath, content }
  })
