/**
 * dotdot tree command
 *
 * Show dependency tree of repos
 */

import * as Cli from '@effect/cli'
import { Effect } from 'effect'

import {
  CurrentWorkingDirectory,
  findWorkspaceRoot,
  loadRootConfigWithSyncCheck,
  type RepoConfig,
} from '../lib/mod.ts'

/** Format the tree output */
const formatTree = (repos: [string, RepoConfig][]) =>
  Effect.gen(function* () {
    yield* Effect.log('Repos:')
    yield* Effect.log('')

    for (let i = 0; i < repos.length; i++) {
      const [name, config] = repos[i]!
      const isLast = i === repos.length - 1
      const prefix = isLast ? '└── ' : '├── '
      const revInfo = config.rev ? ` @ ${config.rev.slice(0, 7)}` : ' (no pin)'
      yield* Effect.log(`${prefix}${name}${revInfo}`)
    }
  })

/** Tree command implementation */
export const treeCommand = Cli.Command.make('tree', {}, () =>
  Effect.gen(function* () {
    const cwd = yield* CurrentWorkingDirectory

    // Find workspace root
    const workspaceRoot = yield* findWorkspaceRoot(cwd)

    yield* Effect.log(`dotdot workspace: ${workspaceRoot}`)
    yield* Effect.log('')

    // Load root config and verify sync
    const rootConfig = yield* loadRootConfigWithSyncCheck(workspaceRoot)

    // Get repos from root config
    const repos = Object.entries(rootConfig.config.repos)

    if (repos.length === 0) {
      yield* Effect.log('No repos declared in config')
      return
    }

    // Show tree
    yield* formatTree(repos)

    yield* Effect.log('')
    yield* Effect.log(`Total: ${repos.length} repo(s)`)
  }).pipe(Effect.withSpan('dotdot/tree')),
)
