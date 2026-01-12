/**
 * dotdot status command
 *
 * Shows status of all repos in the workspace
 */

import path from 'node:path'

import * as Cli from '@effect/cli'
import { FileSystem } from '@effect/platform'
import { Array as A, Effect } from 'effect'

import {
  ConfigOutOfSyncError,
  CurrentWorkingDirectory,
  findWorkspaceRoot,
  Git,
  loadRootConfigWithSyncCheck,
  type RepoConfig,
} from '../lib/mod.ts'

/** Status of a single repo */
type RepoStatus = {
  name: string
  /** Path relative to workspace root */
  path: string
  /** Whether the repo directory exists */
  exists: boolean
  /** Whether it's a git repo */
  isGitRepo: boolean
  /** Current HEAD revision */
  currentRev?: string | undefined
  /** Short revision (7 chars) */
  shortRev?: string | undefined
  /** Current branch */
  branch?: string | undefined
  /** Whether working tree is dirty */
  isDirty?: boolean | undefined
  /** Pinned revision from config (from schema: string | undefined) */
  pinnedRev?: string | undefined
  /** Whether current rev matches pinned rev */
  revisionMatch?: 'ok' | 'diverged' | 'no-pin' | undefined
  /** Config for this repo */
  config?: RepoConfig | undefined
}

/** Collect all declared repos from root config */
const collectDeclaredRepos = (repos: Record<string, RepoConfig>) => {
  const result = new Map<string, { config: RepoConfig }>()

  for (const [name, config] of Object.entries(repos)) {
    result.set(name, { config })
  }

  return result
}

/** Get status for a single repo */
const getRepoStatus = (workspaceRoot: string, name: string, info: { config: RepoConfig }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const repoPath = path.join(workspaceRoot, name)

    const status: RepoStatus = {
      name,
      path: name,
      exists: false,
      isGitRepo: false,
      config: info.config,
      pinnedRev: info.config.rev,
    }

    // Check if directory exists
    status.exists = yield* fs.exists(repoPath)
    if (!status.exists) {
      return status
    }

    // Check if it's a git repo
    status.isGitRepo = yield* Git.isGitRepo(repoPath)
    if (!status.isGitRepo) {
      return status
    }

    // Get git info
    status.currentRev = yield* Git.getCurrentRev(repoPath)
    status.shortRev = yield* Git.getShortRev(repoPath)
    status.branch = yield* Git.getCurrentBranch(repoPath)
    status.isDirty = yield* Git.isDirty(repoPath)

    // Check revision match
    if (!status.pinnedRev) {
      status.revisionMatch = 'no-pin'
    } else if (
      status.currentRev === status.pinnedRev ||
      status.currentRev?.startsWith(status.pinnedRev)
    ) {
      status.revisionMatch = 'ok'
    } else {
      status.revisionMatch = 'diverged'
    }

    return status
  })

/** Format status output */
const formatStatus = (workspaceRoot: string, statuses: RepoStatus[]) =>
  Effect.gen(function* () {
    yield* Effect.log(`dotdot workspace: ${workspaceRoot}`)
    yield* Effect.log('')

    if (statuses.length === 0) {
      yield* Effect.log('No repos found.')
      return
    }

    yield* Effect.log(`Declared repos (${statuses.length}):`)
    for (const status of statuses) {
      const parts: string[] = []

      if (!status.exists) {
        parts.push('MISSING')
      } else if (!status.isGitRepo) {
        parts.push('NOT GIT')
      } else {
        // Branch and rev
        parts.push(`${status.branch}@${status.shortRev}`)

        // Dirty indicator
        if (status.isDirty) {
          parts.push('*dirty*')
        }

        // Revision match
        if (status.revisionMatch === 'diverged') {
          parts.push(`[diverged from ${status.pinnedRev?.slice(0, 7)}]`)
        } else if (status.revisionMatch === 'no-pin') {
          parts.push('[no pin]')
        }
      }

      yield* Effect.log(`  ${status.name}: ${parts.join(' ')}`)
    }
  })

/** Status command implementation */
export const statusCommand = Cli.Command.make('status', {}, () =>
  Effect.gen(function* () {
    const cwd = yield* CurrentWorkingDirectory

    // Find workspace root
    const workspaceRoot = yield* findWorkspaceRoot(cwd)

    // Load root config and verify sync
    const rootConfig = yield* loadRootConfigWithSyncCheck(workspaceRoot).pipe(
      Effect.catchTag('ConfigOutOfSyncError', (e) =>
        Effect.gen(function* () {
          yield* Effect.logError(e.message)
          return yield* Effect.fail(e)
        }),
      ),
    )

    // Get declared repos from root config
    const declaredRepos = collectDeclaredRepos(rootConfig.config.repos)

    // Get status for each declared repo
    const statuses = yield* Effect.all(
      A.fromIterable(declaredRepos.entries()).map(([name, info]) =>
        getRepoStatus(workspaceRoot, name, info),
      ),
      { concurrency: 'unbounded' },
    )

    // Format and output
    yield* formatStatus(workspaceRoot, statuses)
  }).pipe(Effect.withSpan('dotdot/status')),
)
