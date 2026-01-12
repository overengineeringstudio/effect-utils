/**
 * Config file writer
 *
 * Writes/updates dotdot.json files
 */

import path from 'node:path'

import { FileSystem } from '@effect/platform'
import { Effect, Schema } from 'effect'

import {
  CONFIG_FILE_NAME,
  type DotdotConfig,
  GENERATED_CONFIG_FILE_NAME,
  GENERATED_CONFIG_WARNING,
  JSON_SCHEMA_URL,
  type RepoConfig,
} from './config.ts'

/** Error when writing config file fails */
export class ConfigWriteError extends Schema.TaggedError<ConfigWriteError>()('ConfigWriteError', {
  path: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

/** Generate JSON config file content */
const generateConfigContent = (config: DotdotConfig): string => {
  const output: DotdotConfig = {
    $schema: JSON_SCHEMA_URL,
    repos: config.repos,
  }
  return JSON.stringify(output, null, 2) + '\n'
}

/** Write a config file */
export const writeConfig = (configPath: string, config: DotdotConfig) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const content = generateConfigContent(config)
    yield* fs.writeFileString(configPath, content).pipe(
      Effect.mapError(
        (cause) =>
          new ConfigWriteError({
            path: configPath,
            message: 'Failed to write config file',
            cause,
          }),
      ),
    )
  }).pipe(Effect.withSpan('config-writer/writeConfig'))

/** Add or update a repo in a config file */
export const upsertRepo = (
  configPath: string,
  name: string,
  repoConfig: RepoConfig,
  existingConfig: DotdotConfig,
) =>
  Effect.gen(function* () {
    const newConfig: DotdotConfig = {
      ...existingConfig,
      repos: {
        ...existingConfig.repos,
        [name]: repoConfig,
      },
    }
    yield* writeConfig(configPath, newConfig)
    return newConfig
  }).pipe(Effect.withSpan('config-writer/upsertRepo'))

/** Remove a repo from a config file */
export const removeRepo = (configPath: string, name: string, existingConfig: DotdotConfig) =>
  Effect.gen(function* () {
    const { [name]: _, ...remainingRepos } = existingConfig.repos
    const newConfig: DotdotConfig = {
      ...existingConfig,
      repos: remainingRepos,
    }
    yield* writeConfig(configPath, newConfig)
    return newConfig
  }).pipe(Effect.withSpan('config-writer/removeRepo'))

/** Update a repo's rev in a config file */
export const updateRepoRev = (
  configPath: string,
  name: string,
  rev: string,
  existingConfig: DotdotConfig,
) =>
  Effect.gen(function* () {
    const existingRepo = existingConfig.repos[name]
    if (!existingRepo) {
      return yield* Effect.fail(
        new ConfigWriteError({
          path: configPath,
          message: `Repo '${name}' not found in config`,
        }),
      )
    }

    const newConfig: DotdotConfig = {
      ...existingConfig,
      repos: {
        ...existingConfig.repos,
        [name]: {
          ...existingRepo,
          rev,
        },
      },
    }
    yield* writeConfig(configPath, newConfig)
    return newConfig
  }).pipe(Effect.withSpan('config-writer/updateRepoRev'))

/** Create an empty config file */
export const createEmptyConfig = (dir: string) =>
  Effect.gen(function* () {
    const configPath = path.join(dir, CONFIG_FILE_NAME)
    const config: DotdotConfig = { repos: {} }
    yield* writeConfig(configPath, config)
    return configPath
  }).pipe(Effect.withSpan('config-writer/createEmptyConfig'))

/** Generate content for the generated config file */
const generateGeneratedConfigContent = (config: DotdotConfig): string => {
  const output = {
    $schema: JSON_SCHEMA_URL,
    _: GENERATED_CONFIG_WARNING,
    repos: config.repos,
  }
  return JSON.stringify(output, null, 2) + '\n'
}

/** Write the generated (aggregated) config file */
export const writeGeneratedConfig = (workspaceRoot: string, config: DotdotConfig) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const configPath = path.join(workspaceRoot, GENERATED_CONFIG_FILE_NAME)
    const content = generateGeneratedConfigContent(config)
    yield* fs.writeFileString(configPath, content).pipe(
      Effect.mapError(
        (cause) =>
          new ConfigWriteError({
            path: configPath,
            message: 'Failed to write generated config file',
            cause,
          }),
      ),
    )
    return configPath
  }).pipe(Effect.withSpan('config-writer/writeGeneratedConfig'))
