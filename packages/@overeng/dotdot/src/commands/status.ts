/**
 * dotdot status command
 *
 * Shows status of all repos in the workspace using WorkspaceService
 */

import * as Cli from '@effect/cli'
import { NodeFileSystem } from '@effect/platform-node'
import { Effect, Layer } from 'effect'

import {
  CurrentWorkingDirectory,
  isDangling,
  isDiverged,
  type RepoInfo,
  WorkspaceService,
} from '../lib/mod.ts'

/** Format a single repo status line */
const formatRepoLine = (repo: RepoInfo): string => {
  const parts: string[] = []

  if (repo.fsState._tag === 'missing') {
    parts.push('MISSING')
  } else if (repo.fsState._tag === 'not-git') {
    parts.push('NOT GIT')
  } else if (repo.gitState) {
    parts.push(`${repo.gitState.branch}@${repo.gitState.shortRev}`)

    if (repo.gitState.isDirty) {
      parts.push('*dirty*')
    }

    if (isDiverged(repo)) {
      parts.push(`[diverged from ${repo.pinnedRev?.slice(0, 7)}]`)
    } else if (!repo.pinnedRev) {
      parts.push('[no pin]')
    }
  }

  return `  ${repo.name}: ${parts.join(' ')}`
}

/** Format status output */
const formatStatus = (
  workspaceRoot: string,
  members: RepoInfo[],
  dependencies: RepoInfo[],
  dangling: RepoInfo[],
) =>
  Effect.gen(function* () {
    yield* Effect.log(`dotdot workspace: ${workspaceRoot}`)
    yield* Effect.log('')

    const total = members.length + dependencies.length + dangling.length
    if (total === 0) {
      yield* Effect.log('No repos found.')
      return
    }

    // Show members
    if (members.length > 0) {
      yield* Effect.log(`Members (${members.length}):`)
      for (const repo of members) {
        yield* Effect.log(formatRepoLine(repo))
      }
    }

    // Show dependencies
    if (dependencies.length > 0) {
      if (members.length > 0) yield* Effect.log('')
      yield* Effect.log(`Dependencies (${dependencies.length}):`)
      for (const repo of dependencies) {
        yield* Effect.log(formatRepoLine(repo))
      }
    }

    // Show dangling repos
    if (dangling.length > 0) {
      if (members.length > 0 || dependencies.length > 0) yield* Effect.log('')
      yield* Effect.log(`Dangling (${dangling.length}):`)
      for (const repo of dangling) {
        yield* Effect.log(formatRepoLine(repo))
      }
    }
  })

/** Status command handler - separated for testability */
export const statusHandler = Effect.gen(function* () {
  const workspace = yield* WorkspaceService

  // Scan all repos
  const allRepos = yield* workspace.scanRepos()

  // Partition by tracking type
  const members = allRepos.filter((r: RepoInfo) => r.tracking._tag === 'member')
  const dependencies = allRepos.filter((r: RepoInfo) => r.tracking._tag === 'dependency')
  const dangling = allRepos.filter(isDangling)

  // Format and output
  yield* formatStatus(workspace.root, members, dependencies, dangling)
}).pipe(Effect.withSpan('dotdot/status'))

/** Status command implementation */
export const statusCommand = Cli.Command.make('status', {}, () =>
  statusHandler.pipe(
    Effect.provide(
      WorkspaceService.live.pipe(
        Layer.provide(CurrentWorkingDirectory.live),
        Layer.provide(NodeFileSystem.layer),
      ),
    ),
    Effect.catchTag('ConfigOutOfSyncError', (e) => Effect.logError(e.message)),
  ),
)
