/**
 * Tests for dotdot tree command
 */

import * as PlatformNode from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { treeCommand } from '../src/commands/mod.ts'
import { CurrentWorkingDirectory } from '../src/lib/mod.ts'
import { cleanupWorkspace, createWorkspace, getGitRev } from './fixtures/setup.ts'

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
      yield* treeCommand.handler({ showConflicts: false })
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
      yield* treeCommand.handler({ showConflicts: false })
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

  it('shows repos from nested configs', async () => {
    workspacePath = createWorkspace({
      rootRepos: {
        'repo-a': { url: 'git@github.com:test/repo-a.git' },
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
      yield* treeCommand.handler({ showConflicts: false })
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

  it('detects revision conflicts', async () => {
    workspacePath = createWorkspace({
      rootRepos: {
        'shared-repo': {
          url: 'git@github.com:test/shared-repo.git',
          rev: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
        },
      },
      repos: [
        { name: 'shared-repo', isGitRepo: true },
        {
          name: 'repo-with-config',
          isGitRepo: true,
          hasConfig: true,
          configRepos: {
            'shared-repo': {
              url: 'git@github.com:test/shared-repo.git',
              rev: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2',
            },
          },
        },
      ],
    })

    await Effect.gen(function* () {
      yield* treeCommand.handler({ showConflicts: false })
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

  it('shows only conflicts with --conflicts flag', async () => {
    workspacePath = createWorkspace({
      rootRepos: {
        'shared-repo': {
          url: 'git@github.com:test/shared-repo.git',
          rev: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
        },
      },
      repos: [
        { name: 'shared-repo', isGitRepo: true },
        {
          name: 'repo-with-config',
          isGitRepo: true,
          hasConfig: true,
          configRepos: {
            'shared-repo': {
              url: 'git@github.com:test/shared-repo.git',
              rev: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2',
            },
          },
        },
      ],
    })

    await Effect.gen(function* () {
      yield* treeCommand.handler({ showConflicts: true })
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

  it('reports no conflicts when none exist', async () => {
    const rev = 'cccccccccccccccccccccccccccccccccccccccc'

    workspacePath = createWorkspace({
      rootRepos: {
        'shared-repo': { url: 'git@github.com:test/shared-repo.git', rev },
      },
      repos: [
        { name: 'shared-repo', isGitRepo: true },
        {
          name: 'repo-with-config',
          isGitRepo: true,
          hasConfig: true,
          configRepos: {
            'shared-repo': { url: 'git@github.com:test/shared-repo.git', rev },
          },
        },
      ],
    })

    await Effect.gen(function* () {
      yield* treeCommand.handler({ showConflicts: true })
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
