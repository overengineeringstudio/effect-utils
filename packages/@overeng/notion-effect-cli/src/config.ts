import { FileSystem, Path } from '@effect/platform'
import { Effect, Schema } from 'effect'

import { CurrentWorkingDirectory } from '@overeng/utils/node'

import type {
  DatabaseConfig,
  DefaultsConfig,
  PropertyTransforms,
  SchemaGenConfig,
  Transform,
} from './config-def.ts'
import type { PropertyTransformConfig } from './introspect.ts'

// Re-export config definition types
export type { DatabaseConfig, DefaultsConfig, PropertyTransforms, SchemaGenConfig, Transform }

// -----------------------------------------------------------------------------
// Internal Types (for backwards compat with codegen)
// -----------------------------------------------------------------------------

/** Resolved database config with all paths resolved and transforms normalized */
export interface ResolvedDatabaseConfig {
  /** Notion database ID */
  readonly id: string
  /** Resolved output file path (absolute) */
  readonly output: string
  /** Custom schema name (defaults to database title) */
  readonly name?: string
  /** Include Write schemas */
  readonly includeWrite?: boolean
  /** Generate typed options for select/status */
  readonly typedOptions?: boolean
  /** Generate a typed database API wrapper */
  readonly includeApi?: boolean
  /** Property-specific transforms (normalized to string values) */
  readonly transforms?: PropertyTransformConfig
}

/** Resolved config with all paths resolved */
export interface ResolvedConfig {
  readonly databases: readonly ResolvedDatabaseConfig[]
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

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

/** Config file names to search for (TS config only) */
const CONFIG_FILE_NAMES = ['notion-schema-gen.config.ts', '.notion-schema-gen.config.ts']

const formatUnknownErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** Find config file in directory or parent directories */
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

/** Check if a value is a Transform object */
const isTransform = (value: unknown): value is Transform =>
  typeof value === 'object' &&
  value !== null &&
  '_tag' in value &&
  (value as Transform)._tag === 'Transform'

/** Normalize transform value to string */
const normalizeTransform = (value: Transform | string): string =>
  isTransform(value) ? value.name : value

/** Normalize PropertyTransforms to PropertyTransformConfig (string values) */
const normalizeTransforms = (
  transforms: PropertyTransforms | undefined,
): PropertyTransformConfig | undefined => {
  if (!transforms) return undefined

  const result: PropertyTransformConfig = {}
  for (const [key, value] of Object.entries(transforms)) {
    result[key] = normalizeTransform(value)
  }
  return result
}

/** Load TypeScript config file using dynamic import */
const loadTsConfig = (
  configPath: string,
): Effect.Effect<SchemaGenConfig, ConfigReadError | ConfigParseError> =>
  Effect.gen(function* () {
    const module = yield* Effect.tryPromise({
      // oxlint-disable-next-line eslint-plugin-import(no-dynamic-require) -- runtime config file loading requires dynamic import
      try: () => import(configPath),
      catch: (cause) =>
        new ConfigReadError({
          message: `Failed to import config: ${formatUnknownErrorMessage(cause)}`,
          path: configPath,
          cause,
        }),
    })

    const config = module.default as unknown
    if (!config || typeof config !== 'object') {
      return yield* new ConfigParseError({
        message: 'Config file must export a default config object',
        path: configPath,
        cause: new Error('Invalid export'),
      })
    }

    // Validate required fields
    if (!('databases' in config) || typeof config.databases !== 'object') {
      return yield* new ConfigParseError({
        message: 'Config must have a "databases" object',
        path: configPath,
        cause: new Error('Missing databases'),
      })
    }

    return config as SchemaGenConfig
  })

interface ResolveConfigOptions {
  config: SchemaGenConfig
  configDir: string
  path: Path.Path
}

/** Build resolved database config with optional fields */
const buildResolvedDatabaseConfig = (opts: {
  id: string
  output: string
  merged: DatabaseConfig
  normalizedTransforms: PropertyTransformConfig | undefined
}): ResolvedDatabaseConfig => ({
  id: opts.id,
  output: opts.output,
  ...(opts.merged.name !== undefined && { name: opts.merged.name }),
  ...(opts.merged.includeWrite !== undefined && { includeWrite: opts.merged.includeWrite }),
  ...(opts.merged.typedOptions !== undefined && { typedOptions: opts.merged.typedOptions }),
  ...(opts.merged.includeApi !== undefined && { includeApi: opts.merged.includeApi }),
  ...(opts.normalizedTransforms !== undefined && { transforms: opts.normalizedTransforms }),
})

/** Resolve database configs with outputDir and defaults applied */
const resolveConfig = ({ config, configDir, path }: ResolveConfigOptions): ResolvedConfig => {
  const baseDir = config.outputDir ? path.resolve(configDir, config.outputDir) : configDir

  const databases = Object.entries(config.databases).map(([id, db]): ResolvedDatabaseConfig => {
    const merged = mergeWithDefaults(db, config.defaults)
    const normalizedTransforms = normalizeTransforms(merged.transforms)

    return buildResolvedDatabaseConfig({
      id,
      output: path.resolve(baseDir, db.output),
      merged,
      normalizedTransforms,
    })
  })

  return { databases }
}

/**
 * Load configuration from file.
 * Searches for config files in the current directory and parent directories.
 */
export const loadConfig = (
  configPath?: string,
): Effect.Effect<
  { config: ResolvedConfig; path: string },
  ConfigError,
  FileSystem.FileSystem | Path.Path | CurrentWorkingDirectory
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path

    const searchStartDir = yield* CurrentWorkingDirectory
    const resolvedPath = configPath ?? (yield* findConfigFile(searchStartDir))

    if (!resolvedPath) {
      return yield* new ConfigNotFoundError({
        message: `No config file found. Create one of: ${CONFIG_FILE_NAMES.join(', ')}`,
        searchStartDir,
        fileNames: CONFIG_FILE_NAMES,
      })
    }

    const absolutePath = pathService.resolve(searchStartDir, resolvedPath)
    const exists = yield* fs.exists(absolutePath).pipe(Effect.orElseSucceed(() => false))
    if (!exists) {
      return yield* new ConfigFileNotFoundError({
        message: `Config file not found: ${absolutePath}`,
        path: absolutePath,
      })
    }

    const rawConfig = yield* loadTsConfig(absolutePath)
    const configDir = pathService.dirname(absolutePath)
    const config = resolveConfig({ config: rawConfig, configDir, path: pathService })

    return { config, path: absolutePath }
  })

/**
 * Merge database config with defaults
 */
export const mergeWithDefaults = (
  database: DatabaseConfig,
  defaults?: DefaultsConfig,
): DatabaseConfig => {
  if (!defaults) return database

  const includeWrite = database.includeWrite ?? defaults.includeWrite
  const typedOptions = database.typedOptions ?? defaults.typedOptions
  const includeApi = database.includeApi ?? defaults.includeApi
  const transforms: PropertyTransforms = {
    ...defaults.transforms,
    ...database.transforms,
  }

  return {
    output: database.output,
    ...(database.name !== undefined ? { name: database.name } : {}),
    ...(includeWrite !== undefined ? { includeWrite } : {}),
    ...(typedOptions !== undefined ? { typedOptions } : {}),
    ...(includeApi !== undefined ? { includeApi } : {}),
    ...(Object.keys(transforms).length > 0 ? { transforms } : {}),
  }
}
