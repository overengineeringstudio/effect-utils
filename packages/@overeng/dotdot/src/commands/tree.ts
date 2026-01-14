/**
 * dotdot tree command
 *
 * Show dependency tree of repos
 */

import * as Cli from '@effect/cli'
import { Effect } from 'effect'

import { type RepoInfo, WorkspaceService } from '../lib/mod.ts'

/** Format the tree output */
const formatTree = (repos: RepoInfo[]) =>
  Effect.gen(function* () {
    yield* Effect.log('Repos:')
    yield* Effect.log('')

    for (let i = 0; i < repos.length; i++) {
      const repo = repos[i]!
      const isLast = i === repos.length - 1
      const prefix = isLast ? '└── ' : '├── '

      // Build status indicator
      const fsStatus =
        repo.fsState._tag === 'missing'
          ? ' [missing]'
          : repo.fsState._tag === 'not-git'
            ? ' [not-git]'
            : ''

      const revInfo = repo.pinnedRev ? ` @ ${repo.pinnedRev.slice(0, 7)}` : ' (no pin)'
      const currentRev = repo.gitState ? ` (${repo.gitState.shortRev})` : ''
      const dirtyFlag = repo.gitState?.isDirty ? ' *' : ''

      yield* Effect.log(`${prefix}${repo.name}${revInfo}${currentRev}${dirtyFlag}${fsStatus}`)
    }
  })

/** Tree command implementation */
export const treeCommand = Cli.Command.make('tree', {}, () =>
  Effect.gen(function* () {
    const workspace = yield* WorkspaceService

    yield* Effect.log(`dotdot workspace: ${workspace.root}`)
    yield* Effect.log('')

    // Get all repos from workspace
    const repos = yield* workspace.scanRepos()

    if (repos.length === 0) {
      yield* Effect.log('No repos declared in config')
      return
    }

    // Sort by name for consistent output
    repos.sort((a, b) => a.name.localeCompare(b.name))

    // Show tree
    yield* formatTree(repos)

    yield* Effect.log('')
    yield* Effect.log(`Total: ${repos.length} repo(s)`)
  }).pipe(Effect.withSpan('dotdot/tree')),
)
