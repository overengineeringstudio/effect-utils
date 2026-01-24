/**
 * dotdot pull command
 *
 * Pull all repos from their remotes
 */

import path from 'node:path'

import * as Cli from '@effect/cli'
import { Effect, Layer, Option, Schema } from 'effect'

import { kv, styled, symbols } from '@overeng/cli-ui'

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
      return {
        name,
        status: 'skipped',
        message: 'Not a git repo',
      } satisfies PullResult
    }

    // Check if on a branch (not detached HEAD)
    if (gitState.branch === 'HEAD') {
      return {
        name,
        status: 'skipped',
        message: 'Detached HEAD',
      } satisfies PullResult
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
export const pullHandler = Effect.fn('dotdot/pull')(function* ({
  mode,
  maxParallel,
}: {
  mode: ExecutionMode
  maxParallel: Option.Option<number>
}) {
  const workspace = yield* WorkspaceService

  yield* Effect.log(kv('workspace', path.basename(workspace.root)))

  // Get all repos and filter to those that exist as git repos
  const allRepos = yield* workspace.scanRepos()
  const repos = allRepos.filter(existsAsGitRepo)

  if (repos.length === 0) {
    yield* Effect.log(styled.dim('no repos to pull'))
    return
  }

  yield* Effect.log(styled.dim(`${repos.length} repos ${symbols.dot} ${mode} mode`))
  yield* Effect.log('')

  const results = yield* executeForAll({
    items: repos,
    fn: (repo) =>
      Effect.gen(function* () {
        yield* Effect.log(`${styled.dim('pulling')} ${styled.bold(repo.name)}`)
        const result = yield* pullRepo(repo)

        const statusIcon =
          result.status === 'pulled'
            ? result.diverged
              ? styled.yellow(symbols.warning)
              : styled.green(symbols.check)
            : result.status === 'failed'
              ? styled.red(symbols.cross)
              : styled.dim(symbols.dot)
        yield* Effect.log(`  ${statusIcon} ${styled.dim(result.message ?? result.status)}`)
        return result
      }),
    options: { mode, maxParallel: Option.getOrUndefined(maxParallel) },
  })

  yield* Effect.log('')

  const summary = buildSummary({ results, statusLabels: PullStatusLabels })
  const divergedCount = results.filter((r) => 'diverged' in r && r.diverged === true).length
  const divergedSuffix =
    divergedCount > 0 ? `, ${styled.yellow(String(divergedCount))} diverged` : ''
  yield* Effect.log(styled.dim(`done: ${summary}${divergedSuffix}`))

  if (divergedCount > 0) {
    yield* Effect.log('')
    yield* Effect.logWarning('some repos are now diverged from their pinned revisions')
    yield* Effect.log(
      styled.dim('run `dotdot update-revs` to update pins, or `dotdot sync` to reset'),
    )
  }
})

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
      Effect.catchTag('ConfigOutOfSyncError', (e) =>
        Effect.logError(`${styled.red(symbols.cross)} ${styled.dim(e.message)}`),
      ),
    ),
)
