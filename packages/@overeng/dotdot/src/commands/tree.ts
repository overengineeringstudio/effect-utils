/**
 * dotdot tree command
 *
 * Show dependency tree of repos
 */

import path from 'node:path'

import * as Cli from '@effect/cli'
import { Effect, Layer } from 'effect'

import { kv, styled, symbols } from '@overeng/cli-ui'

import { CurrentWorkingDirectory, type RepoInfo, WorkspaceService } from '../lib/mod.ts'

/** Format the tree output */
const formatTree = (repos: RepoInfo[]) =>
  Effect.gen(function* () {
    yield* Effect.log(styled.dim('repos:'))
    yield* Effect.log('')

    for (let i = 0; i < repos.length; i++) {
      const repo = repos[i]!
      const isLast = i === repos.length - 1
      const prefix = isLast ? symbols.treeLast : symbols.treeMiddle

      // Build status parts
      const parts: string[] = [styled.bold(repo.name)]

      // Revision info
      if (repo.pinnedRev) {
        parts.push(styled.dim(`@${repo.pinnedRev.slice(0, 7)}`))
      } else {
        parts.push(styled.dim('(no pin)'))
      }

      // Current rev if available
      if (repo.gitState) {
        parts.push(styled.dim(`(${repo.gitState.shortRev})`))
      }

      // Status indicators
      if (repo.gitState?.isDirty) {
        parts.push(styled.yellow(symbols.dirty))
      }

      // FS state issues
      if (repo.fsState._tag === 'missing') {
        parts.push(styled.red('[missing]'))
      } else if (repo.fsState._tag === 'not-git') {
        parts.push(styled.yellow('[not-git]'))
      }

      yield* Effect.log(`${prefix}${parts.join(' ')}`)
    }
  })

/** Tree command handler - separated for testability */
export const treeHandler = Effect.gen(function* () {
  const workspace = yield* WorkspaceService

  yield* Effect.log(kv('workspace', path.basename(workspace.root)))
  yield* Effect.log('')

  // Get all repos from workspace
  const repos = yield* workspace.scanRepos()

  if (repos.length === 0) {
    yield* Effect.log(styled.dim('no repos declared in config'))
    return
  }

  // Sort by name for consistent output
  repos.sort((a, b) => a.name.localeCompare(b.name))

  // Show tree
  yield* formatTree(repos)

  yield* Effect.log('')
  yield* Effect.log(styled.dim(`${repos.length} repos`))
}).pipe(Effect.withSpan('dotdot/tree'))

/** Tree command implementation.
 * Provides its own WorkspaceService.live layer - validates config is in sync before running. */
export const treeCommand = Cli.Command.make('tree', {}, () =>
  treeHandler.pipe(
    Effect.provide(WorkspaceService.live.pipe(Layer.provide(CurrentWorkingDirectory.live))),
    Effect.catchTag('ConfigOutOfSyncError', (e) =>
      Effect.logError(`${styled.red(symbols.cross)} ${styled.dim(e.message)}`),
    ),
  ),
)
