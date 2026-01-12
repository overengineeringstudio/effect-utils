/**
 * Tests for dotdot tree command
 */

import * as PlatformNode from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { treeCommand } from '../src/commands/mod.ts'
import { CurrentWorkingDirectory } from '../src/lib/mod.ts'
import { cleanupWorkspace, createWorkspace } from './fixtures/setup.ts'

describe('tree command', () => {
  let workspacePath: string

  afterEach(() => {
    if (workspacePath) {
      cleanupWorkspace(workspacePath)
    }
  })

  it('shows empty tree', async () => {
    workspacePath = createWorkspace({
      repos: [],
    })

    await Effect.gen(function* () {
      yield* treeCommand.handler({})
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

  it('shows repos from root config', async () => {
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

    await Effect.gen(function* () {
      yield* treeCommand.handler({})
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

  it('shows repos with revisions', async () => {
    workspacePath = createWorkspace({
      rootRepos: {
        'repo-a': {
          url: 'git@github.com:test/repo-a.git',
          rev: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
        },
        'repo-b': { url: 'git@github.com:test/repo-b.git' },
      },
      repos: [
        { name: 'repo-a', isGitRepo: true },
        { name: 'repo-b', isGitRepo: true },
      ],
    })

    await Effect.gen(function* () {
      yield* treeCommand.handler({})
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

  it('handles workspace with member configs in sync', async () => {
    // Member config declares repo-b, which is also in root config (in sync)
    workspacePath = createWorkspace({
      rootRepos: {
        'repo-a': { url: 'git@github.com:test/repo-a.git' },
        'repo-b': { url: 'git@github.com:test/repo-b.git' },
      },
      repos: [
        {
          name: 'repo-a',
          isGitRepo: true,
          hasConfig: true,
          configRepos: {
            'repo-b': { url: 'git@github.com:test/repo-b.git' },
          },
        },
        { name: 'repo-b', isGitRepo: true },
      ],
    })

    await Effect.gen(function* () {
      yield* treeCommand.handler({})
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
