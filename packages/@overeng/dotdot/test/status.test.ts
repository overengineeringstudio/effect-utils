/**
 * Tests for dotdot status command
 */

import * as PlatformNode from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { statusCommand } from '../src/commands/mod.ts'
import { CurrentWorkingDirectory } from '../src/lib/mod.ts'
import { cleanupWorkspace, createWorkspace, getGitRev } from './fixtures/setup.ts'

describe('status command', () => {
  let workspacePath: string

  afterEach(() => {
    if (workspacePath) {
      cleanupWorkspace(workspacePath)
    }
  })

  it('shows empty workspace', async () => {
    workspacePath = createWorkspace({
      repos: [],
    })

    const result = await Effect.gen(function* () {
      yield* statusCommand.handler({})
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          PlatformNode.NodeContext.layer,
          CurrentWorkingDirectory.fromPath(workspacePath),
        ),
      ),
      Effect.runPromise,
    )

    // Command should succeed (no error)
    expect(result).toBeUndefined()
  })

  it('shows declared repos that exist', async () => {
    workspacePath = createWorkspace({
      rootRepos: {
        'repo-a': { url: 'git@github.com:test/repo-a.git' },
      },
      repos: [{ name: 'repo-a', isGitRepo: true }],
    })

    const rev = getGitRev(`${workspacePath}/repo-a`)

    // Pin the actual rev in the config
    const fs = await import('node:fs')
    const configPath = `${workspacePath}/dotdot.json`
    const configContent =
      JSON.stringify(
        {
          repos: {
            'repo-a': { url: 'git@github.com:test/repo-a.git', rev: rev },
          },
        },
        null,
        2,
      ) + '\n'
    fs.writeFileSync(configPath, configContent)

    const result = await Effect.gen(function* () {
      yield* statusCommand.handler({})
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          PlatformNode.NodeContext.layer,
          CurrentWorkingDirectory.fromPath(workspacePath),
        ),
      ),
      Effect.runPromise,
    )

    expect(result).toBeUndefined()
  })

  it('shows declared repos that are missing', async () => {
    workspacePath = createWorkspace({
      rootRepos: {
        'missing-repo': { url: 'git@github.com:test/missing-repo.git' },
      },
      repos: [], // Don't create the repo
    })

    const result = await Effect.gen(function* () {
      yield* statusCommand.handler({})
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          PlatformNode.NodeContext.layer,
          CurrentWorkingDirectory.fromPath(workspacePath),
        ),
      ),
      Effect.runPromise,
    )

    expect(result).toBeUndefined()
  })

  it('shows dirty repos', async () => {
    workspacePath = createWorkspace({
      rootRepos: {
        'dirty-repo': { url: 'git@github.com:test/dirty-repo.git' },
      },
      repos: [{ name: 'dirty-repo', isGitRepo: true, isDirty: true }],
    })

    const result = await Effect.gen(function* () {
      yield* statusCommand.handler({})
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          PlatformNode.NodeContext.layer,
          CurrentWorkingDirectory.fromPath(workspacePath),
        ),
      ),
      Effect.runPromise,
    )

    expect(result).toBeUndefined()
  })

  it('shows repos declared in multiple configs', async () => {
    workspacePath = createWorkspace({
      rootRepos: {
        'shared-repo': { url: 'git@github.com:test/shared-repo.git' },
      },
      repos: [
        { name: 'shared-repo', isGitRepo: true },
        {
          name: 'repo-with-config',
          isGitRepo: true,
          hasConfig: true,
          configRepos: {
            'shared-repo': { url: 'git@github.com:test/shared-repo.git' },
          },
        },
      ],
    })

    const result = await Effect.gen(function* () {
      yield* statusCommand.handler({})
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          PlatformNode.NodeContext.layer,
          CurrentWorkingDirectory.fromPath(workspacePath),
        ),
      ),
      Effect.runPromise,
    )

    expect(result).toBeUndefined()
  })

  it('shows diverged revision', async () => {
    workspacePath = createWorkspace({
      rootRepos: {
        'diverged-repo': {
          url: 'git@github.com:test/diverged-repo.git',
          rev: 'abc1234567890',
        },
      },
      repos: [{ name: 'diverged-repo', isGitRepo: true }],
    })

    const result = await Effect.gen(function* () {
      yield* statusCommand.handler({})
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          PlatformNode.NodeContext.layer,
          CurrentWorkingDirectory.fromPath(workspacePath),
        ),
      ),
      Effect.runPromise,
    )

    expect(result).toBeUndefined()
  })
})
