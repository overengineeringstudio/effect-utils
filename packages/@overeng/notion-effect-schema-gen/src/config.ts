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
  /** Generate a typed database API wrapper */
  readonly includeApi?: boolean | undefined
  /** Property-specific transforms */
  readonly transforms?: PropertyTransformConfig | undefined
}

/** Root configuration schema */
export interface SchemaGenConfig {
  /** Default options applied to all databases */
  readonly defaults?:
    | {
        readonly includeWrite?: boolean | undefined
        readonly typedOptions?: boolean | undefined
        readonly includeApi?: boolean | undefined
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
  includeApi: Schema.optional(Schema.Boolean),
  transforms: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
})

const SchemaGenConfigSchema = Schema.Struct({
  defaults: Schema.optional(
    Schema.Struct({
      includeWrite: Schema.optional(Schema.Boolean),
      typedOptions: Schema.optional(Schema.Boolean),
      includeApi: Schema.optional(Schema.Boolean),
      transforms: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
    }),
  ),
  databases: Schema.Array(DatabaseConfigSchema),
})

export class ConfigNotFoundError extends Schema.TaggedError<ConfigNotFoundError>()(
  'ConfigNotFoundError',
  {
    message: Schema.String,
    searchStartDir: Schema.String,
    fileNames: Schema.Array(Schema.String),
  },
) {}

export class ConfigFileNotFoundError extends Schema.TaggedError<ConfigFileNotFoundError>()(
  'ConfigFileNotFoundError',
  {
    message: Schema.String,
    path: Schema.String,
  },
) {}

export class ConfigReadError extends Schema.TaggedError<ConfigReadError>()('ConfigReadError', {
  message: Schema.String,
  path: Schema.String,
  cause: Schema.Defect,
}) {}

export class ConfigParseError extends Schema.TaggedError<ConfigParseError>()('ConfigParseError', {
  message: Schema.String,
  path: Schema.String,
  cause: Schema.Defect,
}) {}

export type ConfigError =
  | ConfigNotFoundError
  | ConfigFileNotFoundError
  | ConfigReadError
  | ConfigParseError

// -----------------------------------------------------------------------------
// Config Loading
// -----------------------------------------------------------------------------

/** Default config file names to search for */
const CONFIG_FILE_NAMES = [
  '.notion-schema-gen.json',
  'notion-schema-gen.json',
  '.notion-schema-gen.config.json',
]

const formatUnknownErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

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
  ConfigError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    const searchStartDir = process.cwd()
    const resolvedPath = configPath ?? (yield* findConfigFile(searchStartDir))

    if (!resolvedPath) {
      return yield* new ConfigNotFoundError({
        message: `No config file found. Create one of: ${CONFIG_FILE_NAMES.join(', ')}`,
        searchStartDir,
        fileNames: CONFIG_FILE_NAMES,
      })
    }

    const exists = yield* fs.exists(resolvedPath).pipe(Effect.orElseSucceed(() => false))
    if (!exists) {
      return yield* new ConfigFileNotFoundError({
        message: `Config file not found: ${resolvedPath}`,
        path: resolvedPath,
      })
    }

    const content = yield* fs.readFileString(resolvedPath).pipe(
      Effect.mapError(
        (cause) =>
          new ConfigReadError({
            message: `Failed to read config: ${formatUnknownErrorMessage(cause)}`,
            path: resolvedPath,
            cause,
          }),
      ),
    )

    const config = yield* Schema.decodeUnknown(Schema.parseJson(SchemaGenConfigSchema))(
      content,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new ConfigParseError({
            message: `Invalid config file: ${formatUnknownErrorMessage(cause)}`,
            path: resolvedPath,
            cause,
          }),
      ),
    )

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
  const includeApi = database.includeApi ?? defaults.includeApi
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
    ...(includeApi !== undefined ? { includeApi } : {}),
    ...(Object.keys(transforms).length > 0 ? { transforms } : {}),
  }
}
