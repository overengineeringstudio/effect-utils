/**
 * Integration tests for dotdot update-revs command
 */

import { FileSystem } from '@effect/platform'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { CurrentWorkingDirectory } from '../lib/mod.ts'
import {
  addCommit,
  createWorkspace,
  getGitRev,
  readConfig,
  withTestCtx,
} from '../test-utils/mod.ts'
import { updateRevsCommand } from './mod.ts'

describe('update-revs command', () => {
  it('updates pinned revision to current HEAD', (test) =>
    withTestCtx(test)(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const workspacePath = yield* createWorkspace({
          rootRepos: {
            'repo-a': { url: 'git@github.com:test/repo-a.git' },
          },
          repos: [{ name: 'repo-a', isGitRepo: true }],
        })

        const oldRev = yield* getGitRev(`${workspacePath}/repo-a`)

        // Update config with old rev
        const configPath = `${workspacePath}/dotdot-root.json`
        yield* fs.writeFileString(
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
        const newRev = yield* addCommit(`${workspacePath}/repo-a`, 'New commit')

        yield* updateRevsCommand
          .handler({ repos: [], dryRun: false })
          .pipe(Effect.provide(CurrentWorkingDirectory.fromPath(workspacePath)))

        // Check config was updated
        const config = yield* readConfig(workspacePath)
        expect(config).toContain(`"rev": "${newRev}"`)
        expect(config).not.toContain(`"rev": "${oldRev}"`)
      }),
    ))

  it('updates only specified repos', { timeout: 15000 }, (test) =>
    withTestCtx(test)(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const workspacePath = yield* createWorkspace({
          rootRepos: {
            'repo-a': { url: 'git@github.com:test/repo-a.git' },
            'repo-b': { url: 'git@github.com:test/repo-b.git' },
          },
          repos: [
            { name: 'repo-a', isGitRepo: true },
            { name: 'repo-b', isGitRepo: true },
          ],
        })

        const oldRevA = yield* getGitRev(`${workspacePath}/repo-a`)
        const oldRevB = yield* getGitRev(`${workspacePath}/repo-b`)

        // Update config with old revs
        const configPath = `${workspacePath}/dotdot-root.json`
        yield* fs.writeFileString(
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
        const newRevA = yield* addCommit(`${workspacePath}/repo-a`, 'New commit A')
        yield* addCommit(`${workspacePath}/repo-b`, 'New commit B')

        // Only update repo-a
        yield* updateRevsCommand
          .handler({ repos: ['repo-a'], dryRun: false })
          .pipe(Effect.provide(CurrentWorkingDirectory.fromPath(workspacePath)))

        // Check only repo-a was updated
        const config = yield* readConfig(workspacePath)
        expect(config).toContain(`"rev": "${newRevA}"`)
        expect(config).toContain(`"rev": "${oldRevB}"`) // B should still have old rev
      }),
    ),
  )

  it('dry run does not modify config', (test) =>
    withTestCtx(test)(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const workspacePath = yield* createWorkspace({
          rootRepos: {
            'repo-a': { url: 'git@github.com:test/repo-a.git' },
          },
          repos: [{ name: 'repo-a', isGitRepo: true }],
        })

        const oldRev = yield* getGitRev(`${workspacePath}/repo-a`)

        const configPath = `${workspacePath}/dotdot-root.json`
        yield* fs.writeFileString(
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
        yield* addCommit(`${workspacePath}/repo-a`, 'New commit')

        yield* updateRevsCommand
          .handler({ repos: [], dryRun: true })
          .pipe(Effect.provide(CurrentWorkingDirectory.fromPath(workspacePath)))

        // Check config was NOT updated
        const config = yield* readConfig(workspacePath)
        expect(config).toContain(`"rev": "${oldRev}"`)
      }),
    ))

  it('skips repos that do not exist', (test) =>
    withTestCtx(test)(
      Effect.gen(function* () {
        const workspacePath = yield* createWorkspace({
          rootRepos: {
            'missing-repo': { url: 'git@github.com:test/missing-repo.git' },
          },
          repos: [],
        })

        // Should complete without error
        yield* updateRevsCommand
          .handler({ repos: [], dryRun: false })
          .pipe(Effect.provide(CurrentWorkingDirectory.fromPath(workspacePath)))

        expect(true).toBe(true)
      }),
    ))

  it('reports unchanged when rev matches', (test) =>
    withTestCtx(test)(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const workspacePath = yield* createWorkspace({
          rootRepos: {
            'repo-a': { url: 'git@github.com:test/repo-a.git' },
          },
          repos: [{ name: 'repo-a', isGitRepo: true }],
        })

        const currentRev = yield* getGitRev(`${workspacePath}/repo-a`)

        const configPath = `${workspacePath}/dotdot-root.json`
        yield* fs.writeFileString(
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
        yield* updateRevsCommand
          .handler({ repos: [], dryRun: false })
          .pipe(Effect.provide(CurrentWorkingDirectory.fromPath(workspacePath)))

        expect(true).toBe(true)
      }),
    ))
})
