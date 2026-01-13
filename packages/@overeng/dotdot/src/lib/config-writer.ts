/**
 * Config file writer
 *
 * Writes/updates dotdot config files:
 * - Member configs (`dotdot.json`): exposes + deps
 * - Root config (`dotdot-root.json`): repos + packages index
 */

import path from 'node:path'

import { FileSystem } from '@effect/platform'
import { Effect, Schema } from 'effect'

import {
  CONFIG_FILE_NAME,
  GENERATED_CONFIG_FILE_NAME,
  GENERATED_CONFIG_WARNING,
  JSON_SCHEMA_URL,
  type MemberConfig,
  type PackageIndexEntry,
  type RepoConfig,
  type RootConfig,
} from './config.ts'

/** Error when writing config file fails */
export class ConfigWriteError extends Schema.TaggedError<ConfigWriteError>()('ConfigWriteError', {
  path: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

/** Generate JSON content for member config file */
const generateMemberConfigContent = (config: MemberConfig): string => {
  const output: MemberConfig = {
    $schema: JSON_SCHEMA_URL,
    ...(config.exposes && Object.keys(config.exposes).length > 0
      ? { exposes: config.exposes }
      : {}),
    ...(config.deps && Object.keys(config.deps).length > 0 ? { deps: config.deps } : {}),
  }
  return JSON.stringify(output, null, 2) + '\n'
}

/** Write a member config file */
export const writeMemberConfig = (configPath: string, config: MemberConfig) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const content = generateMemberConfigContent(config)
    yield* fs.writeFileString(configPath, content).pipe(
      Effect.mapError(
        (cause) =>
          new ConfigWriteError({
            path: configPath,
            message: 'Failed to write member config file',
            cause,
          }),
      ),
    )
  }).pipe(Effect.withSpan('config-writer/writeMemberConfig'))

/** Generate JSON content for root config file */
const generateRootConfigContent = (config: RootConfig): string => {
  const output: RootConfig = {
    $schema: JSON_SCHEMA_URL,
    repos: config.repos,
    ...(config.packages && Object.keys(config.packages).length > 0
      ? { packages: config.packages }
      : {}),
  }
  return JSON.stringify(output, null, 2) + '\n'
}

/** Write a root config file (for non-generated configs) */
export const writeRootConfig = (configPath: string, config: RootConfig) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const content = generateRootConfigContent(config)
    yield* fs.writeFileString(configPath, content).pipe(
      Effect.mapError(
        (cause) =>
          new ConfigWriteError({
            path: configPath,
            message: 'Failed to write root config file',
            cause,
          }),
      ),
    )
  }).pipe(Effect.withSpan('config-writer/writeRootConfig'))

/** Add or update a repo in a root config file */
export const upsertRepo = (
  configPath: string,
  name: string,
  repoConfig: RepoConfig,
  existingConfig: RootConfig,
) =>
  Effect.gen(function* () {
    const newConfig: RootConfig = {
      ...existingConfig,
      repos: {
        ...existingConfig.repos,
        [name]: repoConfig,
      },
    }
    yield* writeRootConfig(configPath, newConfig)
    return newConfig
  }).pipe(Effect.withSpan('config-writer/upsertRepo'))

/** Remove a repo from a root config file */
export const removeRepo = (configPath: string, name: string, existingConfig: RootConfig) =>
  Effect.gen(function* () {
    const { [name]: _, ...remainingRepos } = existingConfig.repos
    const newConfig: RootConfig = {
      ...existingConfig,
      repos: remainingRepos,
    }
    yield* writeRootConfig(configPath, newConfig)
    return newConfig
  }).pipe(Effect.withSpan('config-writer/removeRepo'))

/** Update a repo's rev in a root config file */
export const updateRepoRev = (
  configPath: string,
  name: string,
  rev: string,
  existingConfig: RootConfig,
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

    const newConfig: RootConfig = {
      ...existingConfig,
      repos: {
        ...existingConfig.repos,
        [name]: {
          ...existingRepo,
          rev,
        },
      },
    }
    yield* writeRootConfig(configPath, newConfig)
    return newConfig
  }).pipe(Effect.withSpan('config-writer/updateRepoRev'))

/** Create an empty member config file */
export const createEmptyMemberConfig = (dir: string) =>
  Effect.gen(function* () {
    const configPath = path.join(dir, CONFIG_FILE_NAME)
    const config: MemberConfig = {}
    yield* writeMemberConfig(configPath, config)
    return configPath
  }).pipe(Effect.withSpan('config-writer/createEmptyMemberConfig'))

/** Generate content for the generated config file (dotdot-root.json) */
const generateGeneratedConfigContent = (
  repos: Record<string, RepoConfig>,
  packages: Record<string, PackageIndexEntry>,
): string => {
  const output: RootConfig = {
    $schema: JSON_SCHEMA_URL,
    _: GENERATED_CONFIG_WARNING,
    repos,
    ...(Object.keys(packages).length > 0 ? { packages } : {}),
  }
  return JSON.stringify(output, null, 2) + '\n'
}

/** Write the generated (aggregated) config file */
export const writeGeneratedConfig = (
  workspaceRoot: string,
  repos: Record<string, RepoConfig>,
  packages: Record<string, PackageIndexEntry> = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const configPath = path.join(workspaceRoot, GENERATED_CONFIG_FILE_NAME)
    const content = generateGeneratedConfigContent(repos, packages)
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
