import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import { EffectPath } from '@overeng/effect-path'

import { MegarepoConfig } from '../core/config.ts'
import * as Git from '../core/git.ts'
import { createEmptyLockFile, createLockedMember, updateLockedMember } from '../core/lock.ts'
import { createStoreFixture } from '../test-utils/store-setup.ts'
import { fixStoreIssues, validateStoreMembers } from './store-hygiene.ts'
import { makeStoreLayer, Store } from './store.ts'

const makeFixture = Effect.gen(function* () {
  const fixture = yield* createStoreFixture([
    { host: 'github.com', owner: 'test', repo: 'repo', branches: ['main'], withRemote: true },
  ])
  const bare = fixture.bareRepoPaths['github.com/test/repo']!
  yield* Git.runCommand({
    cwd: bare,
    args: ['config', '--local', '--unset-all', 'remote.origin.fetch'],
  })
  const worktree = fixture.worktreePaths['github.com/test/repo#main']!
  const commit = yield* Git.getCurrentCommit(worktree)
  // The shared fixture uses detached worktrees; this fixture models a healthy branch worktree.
  yield* Git.runCommand({ cwd: bare, args: ['update-ref', 'refs/heads/main', commit] })
  yield* Git.runCommand({ cwd: worktree, args: ['symbolic-ref', 'HEAD', 'refs/heads/main'] })
  yield* Git.runCommand({ cwd: bare, args: ['update-ref', 'refs/remotes/origin/main', commit] })
  yield* Git.runCommand({ cwd: bare, args: ['update-ref', 'refs/heads/preserved', commit] })
  yield* Git.runCommand({ cwd: bare, args: ['update-ref', 'refs/tags/preserved', commit] })
  const config = new MegarepoConfig({ members: { repo: 'test/repo#main' } })
  const lockFile = updateLockedMember({
    lockFile: createEmptyLockFile(),
    memberName: 'repo',
    member: createLockedMember({ url: 'https://github.com/test/repo', ref: 'main', commit }),
  })
  const fs = yield* FileSystem.FileSystem
  const worktreeFile = EffectPath.ops.join(worktree, EffectPath.unsafe.relativeFile('local.txt'))
  yield* fs.writeFileString(worktreeFile, 'preserve uncommitted work\n')
  return { bare, worktreeFile, config, lockFile, fixture }
})

describe('bare store fetch refspec hygiene', () => {
  it.effect('detects and repairs only missing config, preserving refs and linked worktrees', () =>
    Effect.gen(function* () {
      const { bare, worktreeFile, config, lockFile, fixture } = yield* makeFixture
      yield* Effect.gen(function* () {
        const store = yield* Store
        const fs = yield* FileSystem.FileSystem
        const validate = validateStoreMembers({ memberNames: ['repo'], config, lockFile, store })
        const refsBefore = yield* Git.runCommand({ cwd: bare, args: ['for-each-ref'] })
        const worktreesBefore = yield* Git.runCommand({
          cwd: bare,
          args: ['worktree', 'list', '--porcelain'],
        })
        const configBefore = yield* fs.readFileString(`${bare}config`)
        expect(yield* Git.hasBareOriginFetchRefspec({ repoPath: bare })).toBe(false)
        const issues = (yield* validate).filter((issue) => issue.type === 'missing_fetch_refspec')
        expect(issues).toHaveLength(1)
        expect(issues[0]?.fix).toContain('mr store fix')
        expect((yield* fixStoreIssues({ issues, store, dryRun: true }))[0]?.status).toBe('skipped')
        expect(yield* fs.readFileString(`${bare}config`)).toBe(configBefore)
        expect((yield* fixStoreIssues({ issues, store }))[0]?.status).toBe('fixed')
        expect(
          yield* Git.runCommand({
            cwd: bare,
            args: ['config', '--local', '--get-all', 'remote.origin.fetch'],
          }),
        ).toBe(Git.bareOriginFetchRefspec)
        expect((yield* validate).filter((issue) => issue.type === 'missing_fetch_refspec')).toEqual(
          [],
        )
        const repairedConfig = yield* fs.readFileString(`${bare}config`)
        expect((yield* fixStoreIssues({ issues, store }))[0]?.status).toBe('skipped')
        expect(yield* fs.readFileString(`${bare}config`)).toBe(repairedConfig)
        expect(yield* Git.runCommand({ cwd: bare, args: ['for-each-ref'] })).toBe(refsBefore)
        expect(
          yield* Git.runCommand({ cwd: bare, args: ['worktree', 'list', '--porcelain'] }),
        ).toBe(worktreesBefore)
        expect(yield* fs.readFileString(worktreeFile)).toBe('preserve uncommitted work\n')
      }).pipe(Effect.provide(makeStoreLayer({ basePath: fixture.storePath })))
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('reports no hygiene issues for a healthy store', () =>
    Effect.gen(function* () {
      const { bare, worktreeFile, config, lockFile, fixture } = yield* makeFixture
      const fs = yield* FileSystem.FileSystem
      yield* fs.remove(worktreeFile)
      yield* Git.runCommand({
        cwd: bare,
        args: ['config', '--local', 'remote.origin.fetch', Git.bareOriginFetchRefspec],
      })
      yield* Effect.gen(function* () {
        const store = yield* Store
        expect(
          yield* validateStoreMembers({
            memberNames: ['repo'],
            config,
            lockFile,
            store,
          }),
        ).toEqual([])
      }).pipe(Effect.provide(makeStoreLayer({ basePath: fixture.storePath })))
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect(
    'reports missing origin and refuses config-only repair without inventing a remote',
    () =>
      Effect.gen(function* () {
        const { bare, config, lockFile, fixture } = yield* makeFixture
        const fs = yield* FileSystem.FileSystem
        yield* Git.runCommand({
          cwd: bare,
          args: ['config', '--local', '--unset-all', 'remote.origin.url'],
        })
        const before = yield* fs.readFileString(`${bare}config`)
        const refsBefore = yield* Git.runCommand({ cwd: bare, args: ['for-each-ref'] })
        const worktreesBefore = yield* Git.runCommand({
          cwd: bare,
          args: ['worktree', 'list', '--porcelain'],
        })
        yield* Effect.gen(function* () {
          const store = yield* Store
          const issues = yield* validateStoreMembers({
            memberNames: ['repo'],
            config,
            lockFile,
            store,
          })
          expect(issues.filter((issue) => issue.type === 'missing_origin')).toHaveLength(1)
          expect(issues.some((issue) => issue.type === 'missing_fetch_refspec')).toBe(false)
          expect((yield* fixStoreIssues({ issues, store }))[0]?.status).toBe('skipped')
        }).pipe(Effect.provide(makeStoreLayer({ basePath: fixture.storePath })))
        const error = yield* Git.repairBareOriginFetchRefspec({ repoPath: bare }).pipe(Effect.flip)
        expect(error._tag).toBe('BareOriginMissingError')
        expect(yield* fs.readFileString(`${bare}config`)).toBe(before)
        expect(yield* Git.runCommand({ cwd: bare, args: ['for-each-ref'] })).toBe(refsBefore)
        expect(
          yield* Git.runCommand({ cwd: bare, args: ['worktree', 'list', '--porcelain'] }),
        ).toBe(worktreesBefore)
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('preserves existing custom and multivalued fetch configuration', () =>
    Effect.gen(function* () {
      const { bare } = yield* makeFixture
      const fs = yield* FileSystem.FileSystem
      for (const refspec of [
        '+refs/heads/main:refs/remotes/origin/main',
        '+refs/tags/*:refs/tags/*',
      ]) {
        yield* Git.runCommand({
          cwd: bare,
          args: ['config', '--local', '--add', 'remote.origin.fetch', refspec],
        })
      }
      const before = yield* fs.readFileString(`${bare}config`)
      expect(yield* Git.hasBareOriginFetchRefspec({ repoPath: bare })).toBe(true)
      expect(yield* Git.repairBareOriginFetchRefspec({ repoPath: bare })).toBe(false)
      expect(yield* fs.readFileString(`${bare}config`)).toBe(before)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )
})
