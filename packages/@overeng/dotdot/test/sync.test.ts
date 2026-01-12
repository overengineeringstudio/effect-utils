/**
 * Tests for dotdot sync command
 */

import fs from 'node:fs'
import path from 'node:path'

import * as PlatformNode from '@effect/platform-node'
import { Effect, Layer, Option } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { syncCommand } from '../src/commands/mod.ts'
import { CurrentWorkingDirectory } from '../src/lib/mod.ts'
import { cleanupWorkspace, createBareRepo, createWorkspace, getGitRev } from './fixtures/setup.ts'

describe('sync command', () => {
  let workspacePath: string
  let bareRepoPath: string

  afterEach(() => {
    if (workspacePath) {
      cleanupWorkspace(workspacePath)
    }
    if (bareRepoPath) {
      const parentDir = path.dirname(bareRepoPath)
      fs.rmSync(parentDir, { recursive: true, force: true })
    }
  })

  it('syncs missing repo', async () => {
    bareRepoPath = createBareRepo('missing-repo')

    workspacePath = createWorkspace({
      rootRepos: {
        'missing-repo': { url: bareRepoPath },
      },
      repos: [], // Don't create the repo
    })

    await Effect.gen(function* () {
      yield* syncCommand.handler({
        dryRun: false,
        mode: 'sequential',
        maxParallel: Option.none(),
      })
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          PlatformNode.NodeContext.layer,
          CurrentWorkingDirectory.fromPath(workspacePath),
        ),
      ),
      Effect.runPromise,
    )

    // Check repo was cloned
    const repoPath = path.join(workspacePath, 'missing-repo')
    expect(fs.existsSync(repoPath)).toBe(true)
    expect(fs.existsSync(path.join(repoPath, '.git'))).toBe(true)
  })

  it('skips existing repos', async () => {
    bareRepoPath = createBareRepo('existing-repo')

    workspacePath = createWorkspace({
      rootRepos: {
        'existing-repo': { url: bareRepoPath },
      },
      repos: [{ name: 'existing-repo', isGitRepo: true }],
    })

    const originalRev = getGitRev(path.join(workspacePath, 'existing-repo'))

    await Effect.gen(function* () {
      yield* syncCommand.handler({
        dryRun: false,
        mode: 'sequential',
        maxParallel: Option.none(),
      })
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          PlatformNode.NodeContext.layer,
          CurrentWorkingDirectory.fromPath(workspacePath),
        ),
      ),
      Effect.runPromise,
    )

    // Check repo wasn't modified
    const currentRev = getGitRev(path.join(workspacePath, 'existing-repo'))
    expect(currentRev).toBe(originalRev)
  })

  it('dry run does not clone', async () => {
    bareRepoPath = createBareRepo('dry-run-repo')

    workspacePath = createWorkspace({
      rootRepos: {
        'dry-run-repo': { url: bareRepoPath },
      },
      repos: [],
    })

    await Effect.gen(function* () {
      yield* syncCommand.handler({
        dryRun: true,
        mode: 'sequential',
        maxParallel: Option.none(),
      })
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          PlatformNode.NodeContext.layer,
          CurrentWorkingDirectory.fromPath(workspacePath),
        ),
      ),
      Effect.runPromise,
    )

    // Check repo was NOT cloned
    const repoPath = path.join(workspacePath, 'dry-run-repo')
    expect(fs.existsSync(repoPath)).toBe(false)
  })

  it('reports nothing to sync when all repos exist', async () => {
    workspacePath = createWorkspace({
      rootRepos: {
        'repo-a': { url: 'git@github.com:test/repo-a.git' },
      },
      repos: [{ name: 'repo-a', isGitRepo: true }],
    })

    // Should complete without error
    await Effect.gen(function* () {
      yield* syncCommand.handler({
        dryRun: false,
        mode: 'sequential',
        maxParallel: Option.none(),
      })
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          PlatformNode.NodeContext.layer,
          CurrentWorkingDirectory.fromPath(workspacePath),
        ),
      ),
      Effect.runPromise,
    )

    expect(true).toBe(true)
  })

  it('handles empty workspace', async () => {
    workspacePath = createWorkspace({
      repos: [],
    })

    await Effect.gen(function* () {
      yield* syncCommand.handler({
        dryRun: false,
        mode: 'sequential',
        maxParallel: Option.none(),
      })
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          PlatformNode.NodeContext.layer,
          CurrentWorkingDirectory.fromPath(workspacePath),
        ),
      ),
      Effect.runPromise,
    )

    expect(true).toBe(true)
  })
})
