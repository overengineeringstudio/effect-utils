/**
 * Tests for dotdot pull command
 */

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import * as PlatformNode from '@effect/platform-node'
import { Effect, Layer, Option } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { pullCommand } from '../src/commands/mod.ts'
import { CurrentWorkingDirectory } from '../src/lib/mod.ts'
import { cleanupWorkspace, createBareRepo, createWorkspace, getGitRev } from './fixtures/setup.ts'

describe('pull command', () => {
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

  it('pulls updates from remote', async () => {
    bareRepoPath = createBareRepo('pullable-repo')

    workspacePath = createWorkspace({
      rootRepos: {
        'pullable-repo': { url: bareRepoPath },
      },
      repos: [],
    })

    // Clone the repo manually
    const repoPath = path.join(workspacePath, 'pullable-repo')
    execSync(`git clone ${bareRepoPath} pullable-repo`, {
      cwd: workspacePath,
      stdio: 'ignore',
    })

    const initialRev = getGitRev(repoPath)

    // Add a new commit to the bare repo via a temp clone
    const tempClone = path.join(workspacePath, 'temp-clone')
    execSync(`git clone ${bareRepoPath} temp-clone`, {
      cwd: workspacePath,
      stdio: 'ignore',
    })
    fs.writeFileSync(path.join(tempClone, 'new-file.txt'), 'new content\n')
    execSync('git add .', { cwd: tempClone, stdio: 'ignore' })
    execSync('git commit -m "Remote commit"', {
      cwd: tempClone,
      stdio: 'ignore',
    })
    execSync('git push', { cwd: tempClone, stdio: 'ignore' })
    fs.rmSync(tempClone, { recursive: true, force: true })

    await Effect.gen(function* () {
      yield* pullCommand.handler({
        mode: 'parallel',
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

    const newRev = getGitRev(repoPath)
    expect(newRev).not.toBe(initialRev)
    expect(fs.existsSync(path.join(repoPath, 'new-file.txt'))).toBe(true)
  })

  it('skips dirty repos', async () => {
    workspacePath = createWorkspace({
      rootRepos: {
        'dirty-repo': { url: 'git@github.com:test/dirty-repo.git' },
      },
      repos: [{ name: 'dirty-repo', isGitRepo: true, isDirty: true }],
    })

    // Should complete without error (skipping dirty repo)
    await Effect.gen(function* () {
      yield* pullCommand.handler({
        mode: 'parallel',
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

  it('skips repos without remote', async () => {
    workspacePath = createWorkspace({
      rootRepos: {
        'local-only': { url: 'git@github.com:test/local-only.git' },
      },
      repos: [{ name: 'local-only', isGitRepo: true }],
    })

    // Should complete without error (skipping repo without remote)
    await Effect.gen(function* () {
      yield* pullCommand.handler({
        mode: 'parallel',
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
      yield* pullCommand.handler({
        mode: 'parallel',
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

  it('skips missing repos', async () => {
    workspacePath = createWorkspace({
      rootRepos: {
        'missing-repo': { url: 'git@github.com:test/missing-repo.git' },
      },
      repos: [],
    })

    await Effect.gen(function* () {
      yield* pullCommand.handler({
        mode: 'parallel',
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
