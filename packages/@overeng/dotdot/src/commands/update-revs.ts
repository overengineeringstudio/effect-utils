/**
 * dotdot update-revs command
 *
 * Update pinned revisions to current HEAD
 */

import path from 'node:path'

import * as Cli from '@effect/cli'
import { Effect, Schema } from 'effect'

import {
  type BaseResult,
  buildSummary,
  existsAsGitRepo,
  GENERATED_CONFIG_FILE_NAME,
  type RepoInfo,
  type RootConfig,
  loadRootConfigFile,
  updateRepoRev,
  WorkspaceService,
} from '../lib/mod.ts'

/** Error during update operation */
export class UpdateRevsError extends Schema.TaggedError<UpdateRevsError>()('UpdateRevsError', {
  repo: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

/** Result of updating a single repo */
type UpdateResult = BaseResult<'updated' | 'unchanged' | 'skipped' | 'failed'> & {
  oldRev?: string
  newRev?: string
}

const UpdateStatusLabels = {
  updated: 'updated',
  unchanged: 'unchanged',
  skipped: 'skipped',
  failed: 'failed',
} as const

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
      const workspace = yield* WorkspaceService
      const rootConfigPath = path.join(workspace.root, GENERATED_CONFIG_FILE_NAME)

      yield* Effect.log(`dotdot workspace: ${workspace.root}`)

      // Get all repos from workspace
      const allRepos = yield* workspace.scanRepos()

      // Filter to specified repos if any, and only existing git repos
      const reposToUpdate: RepoInfo[] =
        repos.length > 0
          ? allRepos.filter((r) => repos.includes(r.name) && existsAsGitRepo(r))
          : allRepos.filter(existsAsGitRepo)

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

      // Track the current config state for sequential updates
      let currentConfig: RootConfig | undefined

      for (const repo of reposToUpdate) {
        const { name, pinnedRev, gitState } = repo

        // Should be filtered already, but guard anyway
        if (!gitState) {
          results.push({ name, status: 'skipped', message: 'Not a git repo' })
          yield* Effect.log(`  ${name}: skipped (not a git repo)`)
          continue
        }

        const currentRev = gitState.rev
        const oldRev = pinnedRev

        if (currentRev === oldRev) {
          results.push({
            name,
            status: 'unchanged',
            ...(oldRev !== undefined && { oldRev }),
            newRev: currentRev,
          })
          yield* Effect.log(`  ${name}: unchanged (${currentRev.slice(0, 7)})`)
          continue
        }

        if (dryRun) {
          yield* Effect.log(
            `  ${name}: would update ${oldRev?.slice(0, 7) ?? '(none)'} → ${currentRev.slice(0, 7)}`,
          )
          results.push({
            name,
            status: 'updated',
            ...(oldRev !== undefined && { oldRev }),
            newRev: currentRev,
          })
          continue
        }

        // Load config if not already loaded
        if (!currentConfig) {
          currentConfig = yield* loadRootConfigFile(rootConfigPath)
        }

        // Update the rev
        currentConfig = yield* updateRepoRev({
          configPath: rootConfigPath,
          name,
          rev: currentRev,
          existingConfig: currentConfig,
        })

        results.push({
          name,
          status: 'updated',
          ...(oldRev !== undefined && { oldRev }),
          newRev: currentRev,
        })
        yield* Effect.log(
          `  ${name}: updated ${oldRev?.slice(0, 7) ?? '(none)'} → ${currentRev.slice(0, 7)}`,
        )
      }

      yield* Effect.log('')

      const summary = buildSummary({ results, statusLabels: UpdateStatusLabels })
      yield* Effect.log(`Done: ${summary}`)
    }).pipe(Effect.withSpan('dotdot/update-revs')),
)
