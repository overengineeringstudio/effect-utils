import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Exit, Option } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import * as Git from '../core/git.ts'
import { createStoreFixture } from '../test-utils/store-setup.ts'
import { acquireDeletionLease, deletionLeasePath } from './store-deletion-lease.ts'
import { type PoolSlot, reservePoolSlot, withPoolState } from './store-pool-state.ts'
import { claimPool, completePool, inspectPool, quarantinePool, releasePool } from './store-pool.ts'

const fixture = Effect.gen(function* () {
  const f = yield* createStoreFixture([
    { host: 'github.com', owner: 'test-owner', repo: 'pool-test', branches: ['main'] },
  ])
  const bare = f.bareRepoPaths['github.com/test-owner/pool-test']!
  const commit = yield* Git.getCurrentCommit(
    f.worktreePaths['github.com/test-owner/pool-test#main']!,
  )
  const path = `${bare.replace(/\/\.bare\/?$/u, '')}/pool/native`
  const lease = yield* acquireDeletionLease({
    storeBasePath: f.storePath,
    ownerPath: path,
    now: 1,
    persistent: true,
  })
  yield* Git.ensureBareRefLogging({ repoPath: bare })
  yield* Git.createWorktreeDetached({
    repoPath: bare,
    worktreePath: path,
    commit,
    lockReason: 'mr-pool:native:preparing',
  })
  const slot: PoolSlot = {
    id: 'native',
    path,
    bare,
    commit,
    identity: 'receipt',
    charge: 1048576,
    state: 'ready',
    chargeKnown: true,
    generation: 0,
    token: '',
    barrierToken: lease.token,
    owner: '',
    reason: '',
  }
  yield* withPoolState(
    f.storePath,
    (state, save) => Effect.flatMap(reservePoolSlot(state, slot), save),
    { maxSlots: 1, maxBytes: 1048576 },
  )
  return { ...f, slot }
})

describe('native pool ownership safety', () => {
  it.effect('successful completion survives status with a lost provider identity', () =>
    Effect.gen(function* () {
      const { storePath, slot } = yield* fixture
      yield* withPoolState(storePath, (state, save) =>
        save({
          ...state,
          slots: [{ ...slot, state: 'leased', token: 'task', generation: 1 }],
        }),
      )
      yield* completePool(storePath, slot.id, 'task', 1)
      const fs = yield* FileSystem.FileSystem
      const lease = deletionLeasePath({ storeBasePath: storePath, ownerPath: slot.path })
      const record = yield* fs.readFileString(lease)
      yield* fs.writeFileString(lease, record.replace(`"pid":${process.pid}`, '"pid":2147483647'))
      const observed = yield* inspectPool(storePath)
      expect(observed.slots[0]?.state).toBe('completed')
      expect(yield* completePool(storePath, slot.id, 'stale', 1).pipe(Effect.exit)).toSatisfy(
        Exit.isFailure,
      )
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect(
    'charges retained partial output even when the preparation reservation was too small',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, slot } = yield* fixture
        yield* fs.writeFileString(`${slot.path}/partial-install`, 'x'.repeat(16384))
        yield* withPoolState(storePath, (state, save) =>
          save({
            ...state,
            slots: [
              { ...slot, charge: 1, token: 'partial', state: 'preparing', chargeKnown: false },
            ],
          }),
        )
        yield* quarantinePool(storePath, slot.id, 'partial', 'install failed')
        const state = yield* withPoolState(storePath, (state) => Effect.succeed(state))
        expect(state.slots[0]?.state).toBe('quarantined')
        expect(state.slots[0]!.charge).toBeGreaterThan(16384)
        expect(yield* fs.readFileString(`${slot.path}/partial-install`)).toHaveLength(16384)
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('registers detached with a native Git lock which refuses ordinary removal', () =>
    Effect.gen(function* () {
      const { slot } = yield* fixture
      const entry = (yield* Git.listWorktrees(slot.bare)).find((item) => item.path === slot.path)
      expect(Option.getOrUndefined(entry!.lockReason)).toBe('mr-pool:native:preparing')
      expect(Option.isNone(entry!.branch)).toBe(true)
      expect(
        yield* Git.removeWorktree({ repoPath: slot.bare, worktreePath: slot.path }).pipe(
          Effect.exit,
        ),
      ).toSatisfy(Exit.isFailure)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('never resets dirty source during claim and retains it in quarantine', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const { storePath, slot } = yield* fixture
      yield* fs.writeFileString(`${slot.path}/unpublished.txt`, 'user work')
      expect(
        yield* claimPool({ base: storePath, identity: 'receipt', owner: 'test' }).pipe(Effect.exit),
      ).toSatisfy(Exit.isFailure)
      expect(yield* fs.readFileString(`${slot.path}/unpublished.txt`)).toBe('user work')
      const state = yield* withPoolState(storePath, (state) => Effect.succeed(state))
      expect(state.slots[0]?.state).toBe('quarantined')
      expect(
        yield* claimPool({ base: storePath, identity: 'receipt', owner: 'next' }).pipe(Effect.exit),
      ).toSatisfy(Exit.isFailure)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('retains committed work even after HEAD is moved back to its source commit', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const { storePath, slot } = yield* fixture
      yield* fs.writeFileString(`${slot.path}/authored.txt`, 'commit')
      yield* Git.runCommand({ cwd: slot.path, args: ['add', 'authored.txt'] })
      yield* Git.runCommand({
        cwd: slot.path,
        args: [
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.com',
          'commit',
          '--no-gpg-sign',
          '--no-verify',
          '-m',
          'authored',
        ],
      })
      yield* Git.runCommand({ cwd: slot.path, args: ['checkout', '--detach', slot.commit] })
      const failure = yield* claimPool({
        base: storePath,
        identity: 'receipt',
        owner: 'test',
      }).pipe(Effect.flip)
      expect(String(failure)).toContain('history retained')
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('a stale release cannot drain, mutate or return another generation', () =>
    Effect.gen(function* () {
      const { storePath, slot } = yield* fixture
      const failure = yield* releasePool({
        base: storePath,
        id: slot.id,
        token: 'stale',
        generation: 1,
      }).pipe(Effect.flip)
      expect(String(failure)).toContain('Stale')
      expect(
        (yield* withPoolState(storePath, (state) => Effect.succeed(state.slots[0])))?.state,
      ).toBe('ready')
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )
})
