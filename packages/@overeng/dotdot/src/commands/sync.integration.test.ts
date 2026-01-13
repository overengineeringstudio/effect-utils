/**
 * Integration tests for dotdot sync command
 */

import { FileSystem } from '@effect/platform'
import { Effect, Option } from 'effect'
import { describe, expect, it } from 'vitest'

import { CurrentWorkingDirectory } from '../lib/mod.ts'
import { createBareRepo, createWorkspace, getGitRev, withTestCtx } from '../test-utils/mod.ts'
import { syncCommand } from './mod.ts'

describe('sync command', () => {
  it('syncs missing repo', (test) =>
    withTestCtx(test)(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const bareRepoPath = yield* createBareRepo('missing-repo')

        const workspacePath = yield* createWorkspace({
          rootRepos: {
            'missing-repo': { url: bareRepoPath },
          },
          repos: [], // Don't create the repo
        })

        yield* syncCommand
          .handler({
            workspacePath: Option.none(),
            dryRun: false,
            mode: 'sequential',
            maxParallel: Option.none(),
          })
          .pipe(Effect.provide(CurrentWorkingDirectory.fromPath(workspacePath)))

        // Check repo was cloned
        const repoPath = `${workspacePath}/missing-repo`
        expect(yield* fs.exists(repoPath)).toBe(true)
        expect(yield* fs.exists(`${repoPath}/.git`)).toBe(true)
      }),
    ))

  it('skips existing repos', (test) =>
    withTestCtx(test)(
      Effect.gen(function* () {
        const bareRepoPath = yield* createBareRepo('existing-repo')

        const workspacePath = yield* createWorkspace({
          rootRepos: {
            'existing-repo': { url: bareRepoPath },
          },
          repos: [{ name: 'existing-repo', isGitRepo: true }],
        })

        const originalRev = yield* getGitRev(`${workspacePath}/existing-repo`)

        yield* syncCommand
          .handler({
            workspacePath: Option.none(),
            dryRun: false,
            mode: 'sequential',
            maxParallel: Option.none(),
          })
          .pipe(Effect.provide(CurrentWorkingDirectory.fromPath(workspacePath)))

        // Check repo wasn't modified
        const currentRev = yield* getGitRev(`${workspacePath}/existing-repo`)
        expect(currentRev).toBe(originalRev)
      }),
    ))

  it('dry run does not clone', (test) =>
    withTestCtx(test)(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const bareRepoPath = yield* createBareRepo('dry-run-repo')

        const workspacePath = yield* createWorkspace({
          rootRepos: {
            'dry-run-repo': { url: bareRepoPath },
          },
          repos: [],
        })

        yield* syncCommand
          .handler({
            workspacePath: Option.none(),
            dryRun: true,
            mode: 'sequential',
            maxParallel: Option.none(),
          })
          .pipe(Effect.provide(CurrentWorkingDirectory.fromPath(workspacePath)))

        // Check repo was NOT cloned
        const repoPath = `${workspacePath}/dry-run-repo`
        expect(yield* fs.exists(repoPath)).toBe(false)
      }),
    ))

  it('reports nothing to sync when all repos exist', (test) =>
    withTestCtx(test)(
      Effect.gen(function* () {
        const workspacePath = yield* createWorkspace({
          rootRepos: {
            'repo-a': { url: 'git@github.com:test/repo-a.git' },
          },
          repos: [{ name: 'repo-a', isGitRepo: true }],
        })

        // Should complete without error
        yield* syncCommand
          .handler({
            workspacePath: Option.none(),
            dryRun: false,
            mode: 'sequential',
            maxParallel: Option.none(),
          })
          .pipe(Effect.provide(CurrentWorkingDirectory.fromPath(workspacePath)))

        expect(true).toBe(true)
      }),
    ))

  it('handles empty workspace', (test) =>
    withTestCtx(test)(
      Effect.gen(function* () {
        const workspacePath = yield* createWorkspace({
          repos: [],
        })

        yield* syncCommand
          .handler({
            workspacePath: Option.none(),
            dryRun: false,
            mode: 'sequential',
            maxParallel: Option.none(),
          })
          .pipe(Effect.provide(CurrentWorkingDirectory.fromPath(workspacePath)))

        expect(true).toBe(true)
      }),
    ))

  it('adds workspace members with dotdot.json to root config', (test) =>
    withTestCtx(test)(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem

        // Create a workspace with a "consumer" member that has dotdot.json but no exposes
        // This simulates a project like schickling.dev that only has deps
        const workspacePath = yield* createWorkspace({
          rootRepos: {}, // Start with empty root config
          repos: [
            {
              name: 'consumer-project',
              isGitRepo: true,
              hasConfig: true,
              remoteUrl: 'git@github.com:test/consumer-project.git',
              configDeps: {}, // Pure consumer, no deps for simplicity
            },
          ],
        })

        yield* syncCommand
          .handler({
            workspacePath: Option.none(),
            dryRun: false,
            mode: 'sequential',
            maxParallel: Option.none(),
          })
          .pipe(Effect.provide(CurrentWorkingDirectory.fromPath(workspacePath)))

        // Verify consumer-project was added to root config
        const configContent = yield* fs.readFileString(`${workspacePath}/dotdot-root.json`)
        const config = JSON.parse(configContent) as { repos: Record<string, { url: string }> }
        expect(config.repos).toHaveProperty('consumer-project')
        const consumerRepo = config.repos['consumer-project']
        if (consumerRepo === undefined) {
          return yield* Effect.die('Expected consumer-project to be added to root config')
        }
        expect(consumerRepo.url).toBe('git@github.com:test/consumer-project.git')
      }),
    ))
})
