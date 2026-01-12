/**
 * Config file loader
 *
 * Loads and parses dotdot.json config files
 */

import path from 'node:path'

import { FileSystem } from '@effect/platform'
import { Effect, Schema } from 'effect'

import {
  CONFIG_FILE_NAME,
  type DotdotConfig,
  DotdotConfigSchema,
  GENERATED_CONFIG_FILE_NAME,
} from './config.ts'

/** Error when config file is invalid */
export class ConfigError extends Schema.TaggedError<ConfigError>()('ConfigError', {
  path: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

/** Source of a config file */
export type ConfigSource = {
  /** Absolute path to the config file */
  path: string
  /** Directory containing the config file */
  dir: string
  /** Whether this is the root workspace config */
  isRoot: boolean
  /** Parsed config */
  config: DotdotConfig
}

/** Load and parse a dotdot.json file */
export const loadConfigFile = (configPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const absolutePath = path.resolve(configPath)

    // Read the JSON file
    const content = yield* fs.readFileString(absolutePath).pipe(
      Effect.mapError(
        (cause) =>
          new ConfigError({
            path: absolutePath,
            message: `Failed to read config file`,
            cause,
          }),
      ),
    )

    // Parse JSON
    const rawConfig = yield* Effect.try({
      try: () => JSON.parse(content),
      catch: (cause) =>
        new ConfigError({
          path: absolutePath,
          message: `Failed to parse JSON`,
          cause: cause as Error,
        }),
    })

    // Validate against schema
    const config = yield* Schema.decodeUnknown(DotdotConfigSchema)(rawConfig).pipe(
      Effect.mapError(
        (cause) =>
          new ConfigError({
            path: absolutePath,
            message: `Invalid config schema`,
            cause,
          }),
      ),
    )

    return config
  }).pipe(Effect.withSpan('loader/loadConfigFile'))

/** Find the workspace root (directory containing dotdot-root.json) */
export const findWorkspaceRoot = (startDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    let currentDir = path.resolve(startDir)

    // Walk up the tree to find dotdot-root.json (the workspace root marker)
    // Only the workspace root has the generated config file
    // Member repos have dotdot.json (not generated)
    while (currentDir !== '/') {
      const generatedConfigPath = path.join(currentDir, GENERATED_CONFIG_FILE_NAME)
      const exists = yield* fs.exists(generatedConfigPath)
      if (exists) {
        return currentDir
      }
      currentDir = path.dirname(currentDir)
    }

    return yield* Effect.fail(
      new ConfigError({
        path: startDir,
        message: `Not a dotdot workspace (no ${GENERATED_CONFIG_FILE_NAME} found). Run 'dotdot sync <path>' to initialize.`,
      }),
    )
  }).pipe(Effect.withSpan('loader/findWorkspaceRoot'))

/** Load root config from workspace (loads the generated config) */
export const loadRootConfig = (workspaceRoot: string) =>
  Effect.gen(function* () {
    // Root config is always the generated config (not dotdot.json)
    const configPath = path.join(workspaceRoot, GENERATED_CONFIG_FILE_NAME)
    const fs = yield* FileSystem.FileSystem

    const exists = yield* fs.exists(configPath)
    if (!exists) {
      // Return empty config if no generated config file
      return {
        path: configPath,
        dir: workspaceRoot,
        isRoot: true,
        config: { repos: {} },
      } satisfies ConfigSource
    }

    const config = yield* loadConfigFile(configPath)
    return {
      path: configPath,
      dir: workspaceRoot,
      isRoot: true,
      config,
    } satisfies ConfigSource
  }).pipe(Effect.withSpan('loader/loadRootConfig'))

/** Load config from a repo directory (if it has one) */
export const loadRepoConfig = (repoDir: string) =>
  Effect.gen(function* () {
    const configPath = path.join(repoDir, CONFIG_FILE_NAME)
    const fs = yield* FileSystem.FileSystem

    const exists = yield* fs.exists(configPath)
    if (!exists) {
      return null
    }

    const config = yield* loadConfigFile(configPath)
    return {
      path: configPath,
      dir: repoDir,
      isRoot: false,
      config,
    } satisfies ConfigSource
  }).pipe(Effect.withSpan('loader/loadRepoConfig'))

/** Collect all configs in workspace (root + repos that have their own) */
export const collectAllConfigs = (workspaceRoot: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const configs: ConfigSource[] = []

    // Load root config
    const rootConfig = yield* loadRootConfig(workspaceRoot)
    configs.push(rootConfig)

    // Scan directories for repo configs
    const entries = yield* fs.readDirectory(workspaceRoot)
    for (const entry of entries) {
      if (entry.startsWith('.')) continue

      const entryPath = path.join(workspaceRoot, entry)
      const stat = yield* fs.stat(entryPath)
      if (stat.type !== 'Directory') continue

      const repoConfig = yield* loadRepoConfig(entryPath)
      if (repoConfig) {
        configs.push(repoConfig)
      }
    }

    return configs
  }).pipe(Effect.withSpan('loader/collectAllConfigs'))
