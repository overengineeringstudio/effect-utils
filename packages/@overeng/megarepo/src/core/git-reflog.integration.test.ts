import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import * as Git from './git.ts'

process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_SYSTEM = '/dev/null'

const makeFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.makeTempDirectoryScoped()
  const source = `${root}/source`
  const bare = `${root}/store.git`
  yield* fs.makeDirectory(source)
  yield* Git.runCommand({ cwd: source, args: ['init', '-b', 'main'] })
  yield* Git.runCommand({
    cwd: source,
    args: [
      '-c',
      'user.name=Test User',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-m',
      'initial',
    ],
  })
  yield* Git.cloneBare({ url: source, targetPath: bare })
  return { source, bare }
})

const readLogging = (repoPath: string) =>
  Git.runCommand({
    cwd: repoPath,
    args: ['config', '--local', '--get', 'core.logAllRefUpdates'],
  })

const expectFetchedReflog = (repoPath: string) =>
  Effect.gen(function* () {
    const commit = yield* Git.runCommand({ cwd: repoPath, args: ['rev-parse', 'main'] })
    const reflog = yield* Git.runCommand({
      cwd: repoPath,
      args: ['reflog', 'show', '--format=%H', 'refs/remotes/origin/main'],
    })
    expect(reflog.split('\n')).toContain(commit)
  })

describe('bare store reflogs', () => {
  it.effect('enables reflogs on clone and records a later branch update', () =>
    Effect.gen(function* () {
      const { bare } = yield* makeFixture
      expect(yield* readLogging(bare)).toBe('true')
      yield* Git.fetchBare({ repoPath: bare })
      yield* expectFetchedReflog(bare)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('enables missing local reflog configuration before fetching existing stores', () =>
    Effect.gen(function* () {
      const { bare } = yield* makeFixture
      yield* Git.runCommand({
        cwd: bare,
        args: ['config', '--local', '--unset-all', 'core.logAllRefUpdates'],
      })
      yield* Git.fetchBare({ repoPath: bare })
      expect(yield* readLogging(bare)).toBe('true')
      yield* expectFetchedReflog(bare)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  for (const value of ['false', 'always', 'ALWAYS']) {
    it.effect(
      `fetch ${value === 'false' ? 'enables disabled reflogs' : `preserves ${value}`}`,
      () =>
        Effect.gen(function* () {
          const { bare } = yield* makeFixture
          yield* Git.runCommand({
            cwd: bare,
            args: ['config', '--local', 'core.logAllRefUpdates', value],
          })
          yield* Git.fetchBare({ repoPath: bare })
          expect(yield* readLogging(bare)).toBe(value === 'false' ? 'true' : value)
          yield* expectFetchedReflog(bare)
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    )
  }
})
