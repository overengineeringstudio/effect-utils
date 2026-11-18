import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Exit, Option } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import * as Git from '../core/git.ts'
import { createStoreFixture } from '../test-utils/store-setup.ts'
import { acquireDeletionLease } from './store-deletion-lease.ts'
import { claimPool, releasePool } from './store-pool.ts'
import { type PoolSlot, reservePoolSlot, withPoolState } from './store-pool-state.ts'

const fixture = Effect.gen(function* () {
  const f = yield* createStoreFixture([
    { host: 'github.com', owner: 'test-owner', repo: 'pool-test', branches: ['main'] },
  ])
  const bare = f.bareRepoPaths['github.com/test-owner/pool-test']!
  const commit = yield* Git.getCurrentCommit(f.worktreePaths['github.com/test-owner/pool-test#main']!)
  const path = `${bare.replace(/\/\.bare\/?$/u, '')}/pool/native`
  const lease = yield* acquireDeletionLease({ storeBasePath: f.storePath, ownerPath: path,
    now: 1, persistent: true })
  yield* Git.ensureBareRefLogging({ repoPath: bare })
  yield* Git.createWorktreeDetached({ repoPath: bare, worktreePath: path, commit,
    lockReason: 'mr-pool:native:preparing' })
  const slot: PoolSlot = { id: 'native', path, bare, commit, identity: 'receipt', charge: 1048576,
    state: 'ready', generation: 0, token: '', barrierToken: lease.token, owner: '', reason: '' }
  yield* withPoolState(f.storePath, (state, save) => Effect.flatMap(reservePoolSlot(state, slot), save),
    { maxSlots: 1, maxBytes: 1048576 })
  return { ...f, slot }
})

describe('native pool ownership safety', () => {
  it.effect('registers detached with a native Git lock which refuses ordinary removal', () =>
    Effect.gen(function* () {
      const { slot } = yield* fixture
      const entry = (yield* Git.listWorktrees(slot.bare)).find((item) => item.path === slot.path)
      expect(Option.getOrUndefined(entry!.lockReason)).toBe('mr-pool:native:preparing')
      expect(Option.isNone(entry!.branch)).toBe(true)
      expect(yield* Git.removeWorktree({ repoPath: slot.bare, worktreePath: slot.path }).pipe(Effect.exit))
        .toSatisfy(Exit.isFailure)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('never resets dirty source during claim and retains it in quarantine', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const { storePath, slot } = yield* fixture
      yield* fs.writeFileString(`${slot.path}/unpublished.txt`, 'user work')
      expect(yield* claimPool({ base: storePath, identity: 'receipt', owner: 'test' }).pipe(Effect.exit))
        .toSatisfy(Exit.isFailure)
      expect(yield* fs.readFileString(`${slot.path}/unpublished.txt`)).toBe('user work')
      const state = yield* withPoolState(storePath, (state) => Effect.succeed(state))
      expect(state.slots[0]?.state).toBe('quarantined')
      expect(yield* claimPool({ base: storePath, identity: 'receipt', owner: 'next' }).pipe(Effect.exit))
        .toSatisfy(Exit.isFailure)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('retains committed work even after HEAD is moved back to its source commit', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const { storePath, slot } = yield* fixture
      yield* fs.writeFileString(`${slot.path}/authored.txt`, 'commit')
      yield* Git.runCommand({ cwd: slot.path, args: ['add', 'authored.txt'] })
      yield* Git.runCommand({ cwd: slot.path, args: ['-c', 'user.name=Test', '-c', 'user.email=test@example.com',
        'commit', '--no-gpg-sign', '--no-verify', '-m', 'authored'] })
      yield* Git.runCommand({ cwd: slot.path, args: ['checkout', '--detach', slot.commit] })
      const failure = yield* claimPool({ base: storePath, identity: 'receipt', owner: 'test' }).pipe(Effect.flip)
      expect(String(failure)).toContain('history retained')
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('a stale release cannot drain, mutate or return another generation', () =>
    Effect.gen(function* () {
      const { storePath, slot } = yield* fixture
      const failure = yield* releasePool({ base: storePath, id: slot.id, token: 'stale', generation: 1 }).pipe(Effect.flip)
      expect(String(failure)).toContain('Stale')
      expect((yield* withPoolState(storePath, (state) => Effect.succeed(state.slots[0])))?.state).toBe('ready')
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )
})
