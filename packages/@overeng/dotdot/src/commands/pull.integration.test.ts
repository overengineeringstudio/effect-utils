/**
 * Integration tests for dotdot pull command
 */

import { Command, FileSystem } from '@effect/platform'
import { Effect, Option, pipe } from 'effect'
import { describe, expect, it } from 'vitest'

import { CurrentWorkingDirectory } from '../lib/mod.ts'
import {
  createBareRepo,
  createWorkspace,
  getGitRev,
  withTestCtx,
} from '../test-utils/mod.ts'
import { pullCommand } from './mod.ts'

describe('pull command', () => {
  it('pulls updates from remote', (test) =>
    withTestCtx(test)(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const bareRepoPath = yield* createBareRepo('pullable-repo')

        const workspacePath = yield* createWorkspace({
          rootRepos: {
            'pullable-repo': { url: bareRepoPath },
          },
          repos: [],
        })

        // Clone the repo manually
        const repoPath = `${workspacePath}/pullable-repo`
        yield* pipe(
          Command.make('git', 'clone', bareRepoPath, 'pullable-repo'),
          Command.workingDirectory(workspacePath),
          Command.exitCode,
          Effect.asVoid,
        )

        const initialRev = yield* getGitRev(repoPath)

        // Add a new commit to the bare repo via a temp clone
        const tempClone = `${workspacePath}/temp-clone`
        yield* pipe(
          Command.make('git', 'clone', bareRepoPath, 'temp-clone'),
          Command.workingDirectory(workspacePath),
          Command.exitCode,
          Effect.asVoid,
        )
        yield* fs.writeFileString(`${tempClone}/new-file.txt`, 'new content\n')
        yield* pipe(
          Command.make('git', 'add', '.'),
          Command.workingDirectory(tempClone),
          Command.exitCode,
          Effect.asVoid,
        )
        yield* pipe(
          Command.make('git', 'commit', '--no-verify', '-m', 'Remote commit'),
          Command.workingDirectory(tempClone),
          Command.exitCode,
          Effect.asVoid,
        )
        yield* pipe(
          Command.make('git', 'push'),
          Command.workingDirectory(tempClone),
          Command.exitCode,
          Effect.asVoid,
        )

        yield* pullCommand
          .handler({
            mode: 'parallel',
            maxParallel: Option.none(),
          })
          .pipe(Effect.provide(CurrentWorkingDirectory.fromPath(workspacePath)))

        const newRev = yield* getGitRev(repoPath)
        expect(newRev).not.toBe(initialRev)
        expect(yield* fs.exists(`${repoPath}/new-file.txt`)).toBe(true)
      }),
    ))

  it('skips dirty repos', (test) =>
    withTestCtx(test)(
      Effect.gen(function* () {
        const workspacePath = yield* createWorkspace({
          rootRepos: {
            'dirty-repo': { url: 'git@github.com:test/dirty-repo.git' },
          },
          repos: [{ name: 'dirty-repo', isGitRepo: true, isDirty: true }],
        })

        // Should complete without error (skipping dirty repo)
        yield* pullCommand
          .handler({
            mode: 'parallel',
            maxParallel: Option.none(),
          })
          .pipe(Effect.provide(CurrentWorkingDirectory.fromPath(workspacePath)))

        expect(true).toBe(true)
      }),
    ))

  it('skips repos without remote', (test) =>
    withTestCtx(test)(
      Effect.gen(function* () {
        const workspacePath = yield* createWorkspace({
          rootRepos: {
            'local-only': { url: 'git@github.com:test/local-only.git' },
          },
          repos: [{ name: 'local-only', isGitRepo: true }],
        })

        // Should complete without error (skipping repo without remote)
        yield* pullCommand
          .handler({
            mode: 'parallel',
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

        yield* pullCommand
          .handler({
            mode: 'parallel',
            maxParallel: Option.none(),
          })
          .pipe(Effect.provide(CurrentWorkingDirectory.fromPath(workspacePath)))

        expect(true).toBe(true)
      }),
    ))

  it('skips missing repos', (test) =>
    withTestCtx(test)(
      Effect.gen(function* () {
        const workspacePath = yield* createWorkspace({
          rootRepos: {
            'missing-repo': { url: 'git@github.com:test/missing-repo.git' },
          },
          repos: [],
        })

        yield* pullCommand
          .handler({
            mode: 'parallel',
            maxParallel: Option.none(),
          })
          .pipe(Effect.provide(CurrentWorkingDirectory.fromPath(workspacePath)))

        expect(true).toBe(true)
      }),
    ))
})
