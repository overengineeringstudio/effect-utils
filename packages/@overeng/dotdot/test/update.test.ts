/**
 * Tests for dotdot update command
 */

import fs from 'node:fs'
import path from 'node:path'

import * as PlatformNode from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { updateRevsCommand } from '../src/commands/mod.ts'
import { CurrentWorkingDirectory } from '../src/lib/mod.ts'
import {
  addCommit,
  cleanupWorkspace,
  createWorkspace,
  getGitRev,
  readConfig,
} from './fixtures/setup.ts'

describe('update command', () => {
  let workspacePath: string

  afterEach(() => {
    if (workspacePath) {
      cleanupWorkspace(workspacePath)
    }
  })

  it('updates pinned revision to current HEAD', async () => {
    workspacePath = createWorkspace({
      rootRepos: {
        'repo-a': { url: 'git@github.com:test/repo-a.git' },
      },
      repos: [{ name: 'repo-a', isGitRepo: true }],
    })

    const oldRev = getGitRev(path.join(workspacePath, 'repo-a'))

    // Update config with old rev
    const configPath = path.join(workspacePath, 'dotdot.json')
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          repos: {
            'repo-a': { url: 'git@github.com:test/repo-a.git', rev: oldRev },
          },
        },
        null,
        2,
      ) + '\n',
    )

    // Add new commit
    const newRev = addCommit(path.join(workspacePath, 'repo-a'), 'New commit')

    await Effect.gen(function* () {
      yield* updateRevsCommand.handler({ repos: [], dryRun: false })
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          PlatformNode.NodeContext.layer,
          CurrentWorkingDirectory.fromPath(workspacePath),
        ),
      ),
      Effect.runPromise,
    )

    // Check config was updated
    const config = readConfig(workspacePath)
    expect(config).toContain(`"rev": "${newRev}"`)
    expect(config).not.toContain(`"rev": "${oldRev}"`)
  })

  it('updates only specified repos', async () => {
    workspacePath = createWorkspace({
      rootRepos: {
        'repo-a': { url: 'git@github.com:test/repo-a.git' },
        'repo-b': { url: 'git@github.com:test/repo-b.git' },
      },
      repos: [
        { name: 'repo-a', isGitRepo: true },
        { name: 'repo-b', isGitRepo: true },
      ],
    })

    const oldRevA = getGitRev(path.join(workspacePath, 'repo-a'))
    const oldRevB = getGitRev(path.join(workspacePath, 'repo-b'))

    // Update config with old revs
    const configPath = path.join(workspacePath, 'dotdot.json')
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          repos: {
            'repo-a': { url: 'git@github.com:test/repo-a.git', rev: oldRevA },
            'repo-b': { url: 'git@github.com:test/repo-b.git', rev: oldRevB },
          },
        },
        null,
        2,
      ) + '\n',
    )

    // Add new commits to both
    const newRevA = addCommit(path.join(workspacePath, 'repo-a'), 'New commit A')
    addCommit(path.join(workspacePath, 'repo-b'), 'New commit B')

    // Only update repo-a
    await Effect.gen(function* () {
      yield* updateRevsCommand.handler({ repos: ['repo-a'], dryRun: false })
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          PlatformNode.NodeContext.layer,
          CurrentWorkingDirectory.fromPath(workspacePath),
        ),
      ),
      Effect.runPromise,
    )

    // Check only repo-a was updated
    const config = readConfig(workspacePath)
    expect(config).toContain(`"rev": "${newRevA}"`)
    expect(config).toContain(`"rev": "${oldRevB}"`) // B should still have old rev
  })

  it('dry run does not modify config', async () => {
    workspacePath = createWorkspace({
      rootRepos: {
        'repo-a': { url: 'git@github.com:test/repo-a.git' },
      },
      repos: [{ name: 'repo-a', isGitRepo: true }],
    })

    const oldRev = getGitRev(path.join(workspacePath, 'repo-a'))

    const configPath = path.join(workspacePath, 'dotdot.json')
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          repos: {
            'repo-a': { url: 'git@github.com:test/repo-a.git', rev: oldRev },
          },
        },
        null,
        2,
      ) + '\n',
    )

    // Add new commit
    addCommit(path.join(workspacePath, 'repo-a'), 'New commit')

    await Effect.gen(function* () {
      yield* updateRevsCommand.handler({ repos: [], dryRun: true })
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          PlatformNode.NodeContext.layer,
          CurrentWorkingDirectory.fromPath(workspacePath),
        ),
      ),
      Effect.runPromise,
    )

    // Check config was NOT updated
    const config = readConfig(workspacePath)
    expect(config).toContain(`"rev": "${oldRev}"`)
  })

  it('skips repos that do not exist', async () => {
    workspacePath = createWorkspace({
      rootRepos: {
        'missing-repo': { url: 'git@github.com:test/missing-repo.git' },
      },
      repos: [],
    })

    // Should complete without error
    await Effect.gen(function* () {
      yield* updateRevsCommand.handler({ repos: [], dryRun: false })
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

  it('reports unchanged when rev matches', async () => {
    workspacePath = createWorkspace({
      rootRepos: {
        'repo-a': { url: 'git@github.com:test/repo-a.git' },
      },
      repos: [{ name: 'repo-a', isGitRepo: true }],
    })

    const currentRev = getGitRev(path.join(workspacePath, 'repo-a'))

    const configPath = path.join(workspacePath, 'dotdot.json')
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          repos: {
            'repo-a': {
              url: 'git@github.com:test/repo-a.git',
              rev: currentRev,
            },
          },
        },
        null,
        2,
      ) + '\n',
    )

    // Should complete without error, reporting unchanged
    await Effect.gen(function* () {
      yield* updateRevsCommand.handler({ repos: [], dryRun: false })
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
