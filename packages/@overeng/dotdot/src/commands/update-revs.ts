/**
 * dotdot update-revs command
 *
 * Update pinned revisions to current HEAD
 */

import path from 'node:path'

import * as Cli from '@effect/cli'
import { FileSystem } from '@effect/platform'
import { Effect, Schema } from 'effect'

import {
  CONFIG_FILE_NAME,
  type ConfigSource,
  CurrentWorkingDirectory,
  collectAllConfigs,
  type DotdotConfig,
  findWorkspaceRoot,
  Git,
  loadConfigFile,
  updateRepoRev,
} from '../lib/mod.ts'

/** Error during update operation */
export class UpdateRevsError extends Schema.TaggedError<UpdateRevsError>()('UpdateRevsError', {
  repo: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

/** Result of updating a single repo */
type UpdateResult = {
  name: string
  status: 'updated' | 'unchanged' | 'skipped' | 'failed'
  oldRev?: string | undefined
  newRev?: string | undefined
  message?: string | undefined
}

/** Find which config file declares a repo */
const findDeclaringConfig = (
  configs: ConfigSource[],
  repoName: string,
): ConfigSource | undefined => {
  // Prefer root config
  const rootConfig = configs.find((c) => c.isRoot && c.config.repos[repoName])
  if (rootConfig) return rootConfig

  // Otherwise find first config that declares it
  return configs.find((c) => c.config.repos[repoName])
}

/** Update-revs command implementation */
export const updateRevsCommand = Cli.Command.make(
  'update-revs',
  {
    repos: Cli.Args.text({ name: 'repos' }).pipe(
      Cli.Args.withDescription('Repos to update (defaults to all)'),
      Cli.Args.repeated,
    ),
    dryRun: Cli.Options.boolean('dry-run').pipe(
      Cli.Options.withDescription('Show what would be done without making changes'),
      Cli.Options.withDefault(false),
    ),
  },
  ({ repos, dryRun }) =>
    Effect.gen(function* () {
      const cwd = yield* CurrentWorkingDirectory
      const fs = yield* FileSystem.FileSystem

      // Find workspace root
      const workspaceRoot = yield* findWorkspaceRoot(cwd)

      yield* Effect.log(`dotdot workspace: ${workspaceRoot}`)

      // Collect all configs
      const configs = yield* collectAllConfigs(workspaceRoot)

      // Collect all declared repos
      const declaredRepos = new Map<
        string,
        {
          config: ConfigSource
          repoConfig: (typeof configs)[0]['config']['repos'][string]
        }
      >()
      for (const source of configs) {
        for (const [name, repoConfig] of Object.entries(source.config.repos)) {
          if (!declaredRepos.has(name)) {
            const declaringConfig = findDeclaringConfig(configs, name)
            if (declaringConfig) {
              declaredRepos.set(name, { config: declaringConfig, repoConfig })
            }
          }
        }
      }

      // Filter to specified repos if any
      const reposToUpdate =
        repos.length > 0
          ? Array.from(declaredRepos.entries()).filter(([name]) => repos.includes(name))
          : Array.from(declaredRepos.entries())

      if (reposToUpdate.length === 0) {
        if (repos.length > 0) {
          yield* Effect.log(`No matching repos found for: ${repos.join(', ')}`)
        } else {
          yield* Effect.log('No repos declared in config')
        }
        return
      }

      yield* Effect.log(`Updating ${reposToUpdate.length} repo(s)...`)
      yield* Effect.log('')

      if (dryRun) {
        yield* Effect.log('Dry run - no changes will be made')
        yield* Effect.log('')
      }

      const results: UpdateResult[] = []

      // Track which config files need to be reloaded after modification
      const modifiedConfigs = new Map<string, DotdotConfig>()

      for (const [name, { config: declaringConfig, repoConfig }] of reposToUpdate) {
        const repoPath = path.join(workspaceRoot, name)

        // Check if repo exists
        const exists = yield* fs.exists(repoPath)
        if (!exists) {
          results.push({
            name,
            status: 'skipped',
            message: 'Directory does not exist',
          })
          yield* Effect.log(`  ${name}: skipped (directory does not exist)`)
          continue
        }

        // Check if it's a git repo
        const isGitRepo = yield* Git.isGitRepo(repoPath)
        if (!isGitRepo) {
          results.push({ name, status: 'skipped', message: 'Not a git repo' })
          yield* Effect.log(`  ${name}: skipped (not a git repo)`)
          continue
        }

        // Get current revision
        const currentRev = yield* Git.getCurrentRev(repoPath)
        const oldRev = repoConfig.rev

        if (currentRev === oldRev) {
          results.push({
            name,
            status: 'unchanged',
            oldRev,
            newRev: currentRev,
          })
          yield* Effect.log(`  ${name}: unchanged (${currentRev.slice(0, 7)})`)
          continue
        }

        if (dryRun) {
          yield* Effect.log(
            `  ${name}: would update ${oldRev?.slice(0, 7) ?? '(none)'} → ${currentRev.slice(0, 7)}`,
          )
          results.push({ name, status: 'updated', oldRev, newRev: currentRev })
          continue
        }

        // Get or reload the config for this file
        let configToModify = modifiedConfigs.get(declaringConfig.path)
        if (!configToModify) {
          configToModify = yield* loadConfigFile(declaringConfig.path)
          modifiedConfigs.set(declaringConfig.path, configToModify)
        }

        // Update the rev
        const newConfig = yield* updateRepoRev(
          declaringConfig.path,
          name,
          currentRev,
          configToModify,
        )
        modifiedConfigs.set(declaringConfig.path, newConfig)

        results.push({ name, status: 'updated', oldRev, newRev: currentRev })
        yield* Effect.log(
          `  ${name}: updated ${oldRev?.slice(0, 7) ?? '(none)'} → ${currentRev.slice(0, 7)}`,
        )
      }

      yield* Effect.log('')

      const updated = results.filter((r) => r.status === 'updated').length
      const unchanged = results.filter((r) => r.status === 'unchanged').length
      const skipped = results.filter((r) => r.status === 'skipped').length

      const summary: string[] = []
      if (updated > 0) summary.push(`${updated} updated`)
      if (unchanged > 0) summary.push(`${unchanged} unchanged`)
      if (skipped > 0) summary.push(`${skipped} skipped`)

      yield* Effect.log(`Done: ${summary.join(', ')}`)
    }).pipe(Effect.withSpan('dotdot/update-revs')),
)
