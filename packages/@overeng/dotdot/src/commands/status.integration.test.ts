/**
 * Integration tests for dotdot status command
 */

import { FileSystem } from '@effect/platform'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { ConfigOutOfSyncError, CurrentWorkingDirectory } from '../lib/mod.ts'
import { createWorkspace, getGitRev, withTestCtx } from '../test-utils/mod.ts'
import { statusCommand } from './mod.ts'

describe('status command', () => {
  it('shows empty workspace', (test) =>
    withTestCtx(test)(
      Effect.gen(function* () {
        const workspacePath = yield* createWorkspace({
          repos: [],
        })

        const result = yield* statusCommand
          .handler({})
          .pipe(Effect.provide(CurrentWorkingDirectory.fromPath(workspacePath)))

        // Command should succeed (no error)
        expect(result).toBeUndefined()
      }),
    ))

  it('shows declared repos that exist', (test) =>
    withTestCtx(test)(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const workspacePath = yield* createWorkspace({
          rootRepos: {
            'repo-a': { url: 'git@github.com:test/repo-a.git' },
          },
          repos: [{ name: 'repo-a', isGitRepo: true }],
        })

        const rev = yield* getGitRev(`${workspacePath}/repo-a`)

        // Pin the actual rev in the root config
        const configPath = `${workspacePath}/dotdot-root.json`
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
        yield* fs.writeFileString(configPath, configContent)

        const result = yield* statusCommand
          .handler({})
          .pipe(Effect.provide(CurrentWorkingDirectory.fromPath(workspacePath)))

        expect(result).toBeUndefined()
      }),
    ))

  it('shows declared repos that are missing', (test) =>
    withTestCtx(test)(
      Effect.gen(function* () {
        const workspacePath = yield* createWorkspace({
          rootRepos: {
            'missing-repo': { url: 'git@github.com:test/missing-repo.git' },
          },
          repos: [], // Don't create the repo
        })

        const result = yield* statusCommand
          .handler({})
          .pipe(Effect.provide(CurrentWorkingDirectory.fromPath(workspacePath)))

        expect(result).toBeUndefined()
      }),
    ))

  it('shows dirty repos', (test) =>
    withTestCtx(test)(
      Effect.gen(function* () {
        const workspacePath = yield* createWorkspace({
          rootRepos: {
            'dirty-repo': { url: 'git@github.com:test/dirty-repo.git' },
          },
          repos: [{ name: 'dirty-repo', isGitRepo: true, isDirty: true }],
        })

        const result = yield* statusCommand
          .handler({})
          .pipe(Effect.provide(CurrentWorkingDirectory.fromPath(workspacePath)))

        expect(result).toBeUndefined()
      }),
    ))

  it('shows repos declared in multiple configs', (test) =>
    withTestCtx(test)(
      Effect.gen(function* () {
        const workspacePath = yield* createWorkspace({
          rootRepos: {
            'shared-repo': { url: 'git@github.com:test/shared-repo.git' },
          },
          repos: [
            { name: 'shared-repo', isGitRepo: true },
            {
              name: 'repo-with-config',
              isGitRepo: true,
              hasConfig: true,
              configDeps: {
                'shared-repo': { url: 'git@github.com:test/shared-repo.git' },
              },
            },
          ],
        })

        const result = yield* statusCommand
          .handler({})
          .pipe(Effect.provide(CurrentWorkingDirectory.fromPath(workspacePath)))

        expect(result).toBeUndefined()
      }),
    ))

  it('shows diverged revision', (test) =>
    withTestCtx(test)(
      Effect.gen(function* () {
        const workspacePath = yield* createWorkspace({
          rootRepos: {
            'diverged-repo': {
              url: 'git@github.com:test/diverged-repo.git',
              rev: 'abc1234567890',
            },
          },
          repos: [{ name: 'diverged-repo', isGitRepo: true }],
        })

        const result = yield* statusCommand
          .handler({})
          .pipe(Effect.provide(CurrentWorkingDirectory.fromPath(workspacePath)))

        expect(result).toBeUndefined()
      }),
    ))

  it('fails when workspace member with dotdot.json is not in root config', (test) =>
    withTestCtx(test)(
      Effect.gen(function* () {
        // Create workspace with a member that has dotdot.json but is NOT in root config
        const workspacePath = yield* createWorkspace({
          rootRepos: {}, // Empty - member not tracked
          repos: [
            {
              name: 'untracked-member',
              isGitRepo: true,
              hasConfig: true,
              remoteUrl: 'git@github.com:test/untracked-member.git',
              configDeps: {},
            },
          ],
        })

        // Status should fail with ConfigOutOfSyncError
        const result = yield* statusCommand
          .handler({})
          .pipe(Effect.provide(CurrentWorkingDirectory.fromPath(workspacePath)), Effect.flip)

        expect(result).toBeInstanceOf(ConfigOutOfSyncError)
        expect(result.message).toContain('untracked-member')
      }),
    ))
})
