/**
 * dotdot pull command
 *
 * Pull all repos from their remotes
 */

import * as Cli from '@effect/cli'
import { Effect, Layer, Option, Schema } from 'effect'

import {
  type BaseResult,
  buildSummary,
  CurrentWorkingDirectory,
  type ExecutionMode,
  executeForAll,
  existsAsGitRepo,
  Git,
  type RepoInfo,
  WorkspaceService,
} from '../lib/mod.ts'

/** Error during pull operation */
export class PullError extends Schema.TaggedError<PullError>()('PullError', {
  repo: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

/** Result of pulling a single repo */
type PullResult = BaseResult<'pulled' | 'skipped' | 'failed'> & {
  diverged?: boolean
}

const PullStatusLabels = {
  pulled: 'pulled',
  skipped: 'skipped',
  failed: 'failed',
} as const

/** Pull a single repo */
const pullRepo = (repo: RepoInfo) =>
  Effect.gen(function* () {
    const { name, path: repoPath, gitState, pinnedRev } = repo

    // Should already be filtered, but guard anyway
    if (!gitState) {
      return { name, status: 'skipped', message: 'Not a git repo' } satisfies PullResult
    }

    // Check if on a branch (not detached HEAD)
    if (gitState.branch === 'HEAD') {
      return { name, status: 'skipped', message: 'Detached HEAD' } satisfies PullResult
    }

    // Check if dirty
    if (gitState.isDirty) {
      return {
        name,
        status: 'skipped',
        message: 'Working tree has uncommitted changes',
      } satisfies PullResult
    }

    // Pull
    yield* Git.pull(repoPath)

    // Check if now diverged from pinned rev
    let diverged = false
    if (pinnedRev) {
      const currentRev = yield* Git.getCurrentRev(repoPath)
      diverged = !currentRev.startsWith(pinnedRev) && currentRev !== pinnedRev
    }

    return {
      name,
      status: 'pulled',
      message: diverged ? 'Pulled (now diverged from pinned revision)' : 'Pulled',
      diverged,
    } satisfies PullResult
  }).pipe(
    Effect.catchAll((error) =>
      Effect.succeed({
        name: repo.name,
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      } satisfies PullResult),
    ),
  )

/** Pull command handler - separated for testability */
export const pullHandler = ({
  mode,
  maxParallel,
}: {
  mode: ExecutionMode
  maxParallel: Option.Option<number>
}) =>
  Effect.gen(function* () {
    const workspace = yield* WorkspaceService

    yield* Effect.log(`dotdot workspace: ${workspace.root}`)

    // Get all repos and filter to those that exist as git repos
    const allRepos = yield* workspace.scanRepos()
    const repos = allRepos.filter(existsAsGitRepo)

    if (repos.length === 0) {
      yield* Effect.log('No repos to pull')
      return
    }

    yield* Effect.log(`Pulling ${repos.length} repo(s)...`)
    yield* Effect.log(`Execution mode: ${mode}`)
    yield* Effect.log('')

    const results = yield* executeForAll({
      items: repos,
      fn: (repo) =>
        Effect.gen(function* () {
          yield* Effect.log(`Pulling ${repo.name}...`)
          const result = yield* pullRepo(repo)

          const statusIcon =
            result.status === 'pulled'
              ? result.diverged
                ? '!'
                : '+'
              : result.status === 'failed'
                ? 'x'
                : '-'
          yield* Effect.log(`  ${statusIcon} ${result.message ?? result.status}`)
          return result
        }),
      options: { mode, maxParallel: Option.getOrUndefined(maxParallel) },
    })

    yield* Effect.log('')

    const summary = buildSummary({ results, statusLabels: PullStatusLabels })
    const divergedCount = results.filter((r) => 'diverged' in r && r.diverged === true).length
    const divergedSuffix = divergedCount > 0 ? `, ${divergedCount} diverged` : ''
    yield* Effect.log(`Done: ${summary}${divergedSuffix}`)

    if (divergedCount > 0) {
      yield* Effect.log('')
      yield* Effect.log('Warning: Some repos are now diverged from their pinned revisions.')
      yield* Effect.log(
        'Run `dotdot update-revs` to update pins, or `dotdot sync` to reset to pinned revisions.',
      )
    }
  }).pipe(Effect.withSpan('dotdot/pull'))

/** Pull command implementation.
 * Provides its own WorkspaceService.live layer - validates config is in sync before running. */
export const pullCommand = Cli.Command.make(
  'pull',
  {
    mode: Cli.Options.choice('mode', ['parallel', 'sequential'] as const).pipe(
      Cli.Options.withDescription('Execution mode: parallel or sequential'),
      Cli.Options.withDefault('parallel' as ExecutionMode),
    ),
    maxParallel: Cli.Options.integer('max-parallel').pipe(
      Cli.Options.withDescription('Maximum parallel operations (only for parallel mode)'),
      Cli.Options.optional,
    ),
  },
  (args) =>
    pullHandler(args).pipe(
      Effect.provide(WorkspaceService.live.pipe(Layer.provide(CurrentWorkingDirectory.live))),
      Effect.catchTag('ConfigOutOfSyncError', (e) => Effect.logError(e.message)),
    ),
)
