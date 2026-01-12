/**
 * Config file loader
 *
 * Loads and parses dotdot config files:
 * - Member configs (`dotdot.json`): exposes + deps
 * - Root config (`dotdot-root.json`): repos + packages index
 */

import path from 'node:path'

import { FileSystem } from '@effect/platform'
import { Effect, Schema } from 'effect'

import {
  CONFIG_FILE_NAME,
  type DepConfig,
  GENERATED_CONFIG_FILE_NAME,
  type MemberConfig,
  MemberConfigSchema,
  type PackageIndexEntry,
  type RepoConfig,
  type RootConfig,
  RootConfigSchema,
} from './config.ts'

/** Error when config file is invalid */
export class ConfigError extends Schema.TaggedError<ConfigError>()('ConfigError', {
  path: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

/** Error when root config is out of sync with member configs */
export class ConfigOutOfSyncError extends Schema.TaggedError<ConfigOutOfSyncError>()(
  'ConfigOutOfSyncError',
  {
    message: Schema.String,
  },
) {}

/** Source of a root config file */
export type RootConfigSource = {
  /** Absolute path to the config file */
  path: string
  /** Directory containing the config file */
  dir: string
  /** This is the root workspace config */
  isRoot: true
  /** Parsed root config */
  config: RootConfig
}

/** Source of a member config file */
export type MemberConfigSource = {
  /** Absolute path to the config file */
  path: string
  /** Directory containing the config file (repo name) */
  dir: string
  /** Name of the repo (directory name) */
  repoName: string
  /** This is not the root workspace config */
  isRoot: false
  /** Parsed member config */
  config: MemberConfig
}


/** Load and parse a JSON config file (shared helper) */
const loadAndParseJson = (configPath: string) =>
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

    return { absolutePath, rawConfig }
  })

/** Load and parse a root config file (dotdot-root.json) */
export const loadRootConfigFile = (configPath: string) =>
  Effect.gen(function* () {
    const { absolutePath, rawConfig } = yield* loadAndParseJson(configPath)

    // Validate against root schema
    const config = yield* Schema.decodeUnknown(RootConfigSchema)(rawConfig).pipe(
      Effect.mapError(
        (cause) =>
          new ConfigError({
            path: absolutePath,
            message: `Invalid root config schema`,
            cause,
          }),
      ),
    )

    return config
  }).pipe(Effect.withSpan('loader/loadRootConfigFile'))

/** Load and parse a member config file (dotdot.json) */
export const loadMemberConfigFile = (configPath: string) =>
  Effect.gen(function* () {
    const { absolutePath, rawConfig } = yield* loadAndParseJson(configPath)

    // Validate against member schema
    const config = yield* Schema.decodeUnknown(MemberConfigSchema)(rawConfig).pipe(
      Effect.mapError(
        (cause) =>
          new ConfigError({
            path: absolutePath,
            message: `Invalid member config schema`,
            cause,
          }),
      ),
    )

    return config
  }).pipe(Effect.withSpan('loader/loadMemberConfigFile'))


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
      } satisfies RootConfigSource
    }

    const config = yield* loadRootConfigFile(configPath)
    return {
      path: configPath,
      dir: workspaceRoot,
      isRoot: true,
      config,
    } satisfies RootConfigSource
  }).pipe(Effect.withSpan('loader/loadRootConfig'))

/** Load member config from a repo directory (if it has one) */
export const loadMemberConfig = (repoDir: string) =>
  Effect.gen(function* () {
    const configPath = path.join(repoDir, CONFIG_FILE_NAME)
    const fs = yield* FileSystem.FileSystem
    const repoName = path.basename(repoDir)

    const exists = yield* fs.exists(configPath)
    if (!exists) {
      return null
    }

    const config = yield* loadMemberConfigFile(configPath)
    return {
      path: configPath,
      dir: repoDir,
      repoName,
      isRoot: false,
      config,
    } satisfies MemberConfigSource
  }).pipe(Effect.withSpan('loader/loadMemberConfig'))


/** Collect only member repo configs (not root) - used for sync */
export const collectMemberConfigs = (workspaceRoot: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const configs: MemberConfigSource[] = []

    const entries = yield* fs.readDirectory(workspaceRoot)
    for (const entry of entries) {
      if (entry.startsWith('.')) continue

      const entryPath = path.join(workspaceRoot, entry)
      const stat = yield* fs.stat(entryPath)
      if (stat.type !== 'Directory') continue

      const memberConfig = yield* loadMemberConfig(entryPath)
      if (memberConfig) {
        configs.push(memberConfig)
      }
    }

    return configs
  }).pipe(Effect.withSpan('loader/collectMemberConfigs'))

/** Result of merging member configs */
export type MergedConfig = {
  /** Flat map of all repos (from deps) */
  repos: Record<string, RepoConfig>
  /** Package index (from exposes, with repo attribution) */
  packages: Record<string, PackageIndexEntry>
  /** Set of repo names that have member configs (workspace members) */
  membersWithConfig: Set<string>
  /** Set of repo names declared as dependencies */
  declaredDeps: Set<string>
}

/** Merge member configs into aggregated repos + packages (first declaration wins) */
export const mergeMemberConfigs = (configs: MemberConfigSource[]): MergedConfig => {
  const repos: Record<string, RepoConfig> = {}
  const packages: Record<string, PackageIndexEntry> = {}
  const membersWithConfig = new Set<string>()
  const declaredDeps = new Set<string>()

  for (const source of configs) {
    // Track that this repo has a config (workspace member)
    membersWithConfig.add(source.repoName)

    // Collect deps into flat repos map
    if (source.config.deps) {
      for (const [name, depConfig] of Object.entries(source.config.deps)) {
        declaredDeps.add(name)
        if (!(name in repos)) {
          repos[name] = {
            url: depConfig.url,
            rev: depConfig.rev,
            install: depConfig.install,
          }
        }
      }
    }

    // Collect exposes into packages index (with repo attribution)
    if (source.config.exposes) {
      for (const [packageName, exposeConfig] of Object.entries(source.config.exposes)) {
        if (!(packageName in packages)) {
          packages[packageName] = {
            repo: source.repoName,
            path: exposeConfig.path,
            install: exposeConfig.install,
          }
        }
      }
    }
  }

  return { repos, packages, membersWithConfig, declaredDeps }
}


/** Check if root config is in sync with member configs
 * Only checks that repos declared in member configs' deps are present in root config.
 * Repos can exist in root config without being declared in member configs
 * (e.g. manually added or no member configs exist).
 */
export const checkConfigSync = (workspaceRoot: string) =>
  Effect.gen(function* () {
    const rootConfig = yield* loadRootConfig(workspaceRoot)
    const memberConfigs = yield* collectMemberConfigs(workspaceRoot)
    const merged = mergeMemberConfigs(memberConfigs)

    // Compare repos - check if root has all repos from member deps
    const rootRepoNames = new Set(Object.keys(rootConfig.config.repos))

    // Check for deps in members but not in root (these need to be synced)
    const missingInRoot: string[] = []
    for (const name of merged.declaredDeps) {
      if (!rootRepoNames.has(name)) {
        missingInRoot.push(name)
      }
    }

    if (missingInRoot.length > 0) {
      return yield* new ConfigOutOfSyncError({
        message: `Config out of sync. Deps declared in member configs but not in root: ${missingInRoot.join(', ')}. Run 'dotdot sync' to update.`,
      })
    }

    // Check for packages in members but not in root
    const rootPackageNames = new Set(Object.keys(rootConfig.config.packages ?? {}))
    const missingPackages: string[] = []
    for (const name of Object.keys(merged.packages)) {
      if (!rootPackageNames.has(name)) {
        missingPackages.push(name)
      }
    }

    if (missingPackages.length > 0) {
      return yield* new ConfigOutOfSyncError({
        message: `Config out of sync. Packages exposed in member configs but not in root: ${missingPackages.join(', ')}. Run 'dotdot sync' to update.`,
      })
    }

    return rootConfig
  }).pipe(Effect.withSpan('loader/checkConfigSync'))

/** Load root config and verify it's in sync with member configs */
export const loadRootConfigWithSyncCheck = (workspaceRoot: string) =>
  checkConfigSync(workspaceRoot).pipe(Effect.withSpan('loader/loadRootConfigWithSyncCheck'))
