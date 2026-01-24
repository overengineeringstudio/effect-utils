/**
 * Integration tests for dotdot status command
 */

import { FileSystem } from '@effect/platform'
import { Effect, Layer, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  ConfigOutOfSyncError,
  CurrentWorkingDirectory,
  RootConfigSchema,
  WorkspaceService,
} from '../lib/mod.ts'
import { createWorkspace, getGitRev, withTestCtx } from '../test-utils/mod.ts'
import { statusHandler } from './mod.ts'

/** Helper to provide WorkspaceService layer for testing */
const withWorkspaceService = (workspacePath: string) =>
  WorkspaceService.live.pipe(Layer.provide(CurrentWorkingDirectory.fromPath(workspacePath)))

describe('status command', () => {
  it('shows empty workspace', () =>
    withTestCtx(
      Effect.gen(function* () {
        const workspacePath = yield* createWorkspace({
          repos: [],
        })

        const result = yield* statusHandler.pipe(
          Effect.provide(withWorkspaceService(workspacePath)),
        )

        // Command should succeed (no error)
        expect(result).toBeUndefined()
      }),
    ))

  it('shows declared repos that exist', () =>
    withTestCtx(
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
          (yield* Schema.encode(Schema.parseJson(RootConfigSchema, { space: 2 }))({
            repos: {
              'repo-a': { url: 'git@github.com:test/repo-a.git', rev: rev },
            },
          })) + '\n'
        yield* fs.writeFileString(configPath, configContent)

        const result = yield* statusHandler.pipe(
          Effect.provide(withWorkspaceService(workspacePath)),
        )

        expect(result).toBeUndefined()
      }),
    ))

  it('shows declared repos that are missing', () =>
    withTestCtx(
      Effect.gen(function* () {
        const workspacePath = yield* createWorkspace({
          rootRepos: {
            'missing-repo': { url: 'git@github.com:test/missing-repo.git' },
          },
          repos: [], // Don't create the repo
        })

        const result = yield* statusHandler.pipe(
          Effect.provide(withWorkspaceService(workspacePath)),
        )

        expect(result).toBeUndefined()
      }),
    ))

  it('shows dirty repos', () =>
    withTestCtx(
      Effect.gen(function* () {
        const workspacePath = yield* createWorkspace({
          rootRepos: {
            'dirty-repo': { url: 'git@github.com:test/dirty-repo.git' },
          },
          repos: [{ name: 'dirty-repo', isGitRepo: true, isDirty: true }],
        })

        const result = yield* statusHandler.pipe(
          Effect.provide(withWorkspaceService(workspacePath)),
        )

        expect(result).toBeUndefined()
      }),
    ))

  it('shows repos declared in multiple configs', () =>
    withTestCtx(
      Effect.gen(function* () {
        const workspacePath = yield* createWorkspace({
          rootRepos: {
            'shared-repo': { url: 'git@github.com:test/shared-repo.git' },
            'repo-with-config': {
              url: 'git@github.com:test/repo-with-config.git',
            },
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

        const result = yield* statusHandler.pipe(
          Effect.provide(withWorkspaceService(workspacePath)),
        )

        expect(result).toBeUndefined()
      }),
    ))

  it('shows diverged revision', () =>
    withTestCtx(
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

        const result = yield* statusHandler.pipe(
          Effect.provide(withWorkspaceService(workspacePath)),
        )

        expect(result).toBeUndefined()
      }),
    ))

  it('fails when workspace member with dotdot.json is not in root config', () =>
    withTestCtx(
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
        const result = yield* statusHandler.pipe(
          Effect.provide(withWorkspaceService(workspacePath)),
          Effect.flip,
        )

        expect(result).toBeInstanceOf(ConfigOutOfSyncError)
        expect(result.message).toContain('untracked-member')
      }),
    ))
})
