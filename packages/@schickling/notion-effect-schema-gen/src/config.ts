import { FileSystem, Path } from '@effect/platform'
import { Effect, Schema } from 'effect'
import type { PropertyTransformConfig } from './introspect.ts'

// -----------------------------------------------------------------------------
// Config Schema
// -----------------------------------------------------------------------------

/** Configuration for a single database */
export interface DatabaseConfig {
  /** Notion database ID */
  readonly id: string
  /** Output file path */
  readonly output: string
  /** Custom schema name (defaults to database title) */
  readonly name?: string | undefined
  /** Include Write schemas */
  readonly includeWrite?: boolean | undefined
  /** Generate typed options for select/status */
  readonly typedOptions?: boolean | undefined
  /** Property-specific transforms */
  readonly transforms?: PropertyTransformConfig | undefined
}

/** Root configuration schema */
export interface SchemaGenConfig {
  /** Notion API token (can also use NOTION_TOKEN env var) */
  readonly token?: string | undefined
  /** Default options applied to all databases */
  readonly defaults?:
    | {
        readonly includeWrite?: boolean | undefined
        readonly typedOptions?: boolean | undefined
        readonly transforms?: PropertyTransformConfig | undefined
      }
    | undefined
  /** List of databases to generate schemas for */
  readonly databases: readonly DatabaseConfig[]
}

const DatabaseConfigSchema = Schema.Struct({
  id: Schema.String,
  output: Schema.String,
  name: Schema.optional(Schema.String),
  includeWrite: Schema.optional(Schema.Boolean),
  typedOptions: Schema.optional(Schema.Boolean),
  transforms: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
})

const SchemaGenConfigSchema = Schema.Struct({
  token: Schema.optional(Schema.String),
  defaults: Schema.optional(
    Schema.Struct({
      includeWrite: Schema.optional(Schema.Boolean),
      typedOptions: Schema.optional(Schema.Boolean),
      transforms: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
    }),
  ),
  databases: Schema.Array(DatabaseConfigSchema),
})

// -----------------------------------------------------------------------------
// Config Loading
// -----------------------------------------------------------------------------

/** Default config file names to search for */
const CONFIG_FILE_NAMES = [
  '.notion-schema-gen.json',
  'notion-schema-gen.json',
  '.notion-schema-gen.config.json',
]

/**
 * Find config file in directory or parent directories
 */
const findConfigFile = (
  startDir: string,
): Effect.Effect<string | undefined, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    let currentDir = startDir

    while (true) {
      for (const fileName of CONFIG_FILE_NAMES) {
        const filePath = path.join(currentDir, fileName)
        const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false))
        if (exists) {
          return filePath
        }
      }
      const parentDir = path.dirname(currentDir)
      if (parentDir === currentDir) {
        break
      }
      currentDir = parentDir
    }

    return undefined
  })

/**
 * Load configuration from file.
 * Searches for config files in the current directory and parent directories.
 */
export const loadConfig = (
  configPath?: string,
): Effect.Effect<
  { config: SchemaGenConfig; path: string },
  Error,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    const resolvedPath = configPath ?? (yield* findConfigFile(process.cwd()))

    if (!resolvedPath) {
      return yield* Effect.fail(
        new Error(`No config file found. Create one of: ${CONFIG_FILE_NAMES.join(', ')}`),
      )
    }

    const exists = yield* fs.exists(resolvedPath).pipe(Effect.orElseSucceed(() => false))
    if (!exists) {
      return yield* Effect.fail(new Error(`Config file not found: ${resolvedPath}`))
    }

    const content = yield* fs
      .readFileString(resolvedPath)
      .pipe(Effect.mapError((error) => new Error(`Failed to read config: ${error.message}`)))

    const config = yield* Schema.decodeUnknown(Schema.parseJson(SchemaGenConfigSchema))(
      content,
    ).pipe(Effect.mapError((error) => new Error(`Invalid config file: ${error.message}`)))

    return { config, path: resolvedPath }
  })

/**
 * Merge database config with defaults
 */
export const mergeWithDefaults = (
  database: DatabaseConfig,
  defaults?: SchemaGenConfig['defaults'],
): DatabaseConfig => {
  if (!defaults) return database

  const includeWrite = database.includeWrite ?? defaults.includeWrite
  const typedOptions = database.typedOptions ?? defaults.typedOptions
  const transforms: PropertyTransformConfig = {
    ...(defaults.transforms ?? {}),
    ...(database.transforms ?? {}),
  }

  return {
    id: database.id,
    output: database.output,
    ...(database.name !== undefined ? { name: database.name } : {}),
    ...(includeWrite !== undefined ? { includeWrite } : {}),
    ...(typedOptions !== undefined ? { typedOptions } : {}),
    ...(Object.keys(transforms).length > 0 ? { transforms } : {}),
  }
}
