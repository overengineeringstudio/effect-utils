import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Exit, Option } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import * as Git from '../core/git.ts'
import { createStoreFixture } from '../test-utils/store-setup.ts'
import { acquireDeletionLease, deletionLeasePath } from './store-deletion-lease.ts'
import { readWorktreeReferencesInUse } from './store-inuse.ts'
import { poolBytes } from './store-pool-install.ts'
import {
  beginPoolRetarget,
  finishPoolRetarget,
  type PoolSlot,
  reservePoolSlot,
  withPoolState,
} from './store-pool-state.ts'
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
    sourceHistory: [commit],
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
  yield* withPoolState({
    base: f.storePath,
    use: (state, save) => Effect.flatMap(reservePoolSlot({ state, slot }), save),
    limits: { maxSlots: 1, maxBytes: 1048576 },
  })
  return { ...f, slot }
})

describe('native pool ownership safety', () => {
  it.effect('status preserves live and completed ownership through release authorization', () =>
    Effect.gen(function* () {
      const { storePath, slot } = yield* fixture
      yield* withPoolState({
        base: storePath,
        use: (state, save) =>
          save({
            ...state,
            slots: [{ ...slot, state: 'leased', token: 'task', generation: 1, chargeKnown: false }],
          }),
      })
      const live = yield* inspectPool(storePath)
      expect(live.slots[0]?.state).toBe('leased')
      expect(live.slots[0]?.chargeKnown).toBe(false)
      yield* completePool({ base: storePath, id: slot.id, token: 'task', generation: 1 })
      const fs = yield* FileSystem.FileSystem
      const lease = deletionLeasePath({ storeBasePath: storePath, ownerPath: slot.path })
      const record = yield* fs.readFileString(lease)
      yield* fs.writeFileString(lease, record.replace(`"pid":${process.pid}`, '"pid":2147483647'))
      const observed = yield* inspectPool(storePath)
      expect(observed.slots[0]?.state).toBe('completed')
      expect(observed.slots[0]?.chargeKnown).toBe(false)
      expect(observed.slots[0]?.token).toBe('task')
      expect(observed.slots[0]?.generation).toBe(1)
      expect(
        yield* completePool({ base: storePath, id: slot.id, token: 'stale', generation: 1 }).pipe(
          Effect.exit,
        ),
      ).toSatisfy(Exit.isFailure)
      // This real fixture has no prepared install; release must pass ownership first.
      const refused = yield* releasePool({
        base: storePath,
        id: slot.id,
        token: 'task',
        generation: 1,
      }).pipe(Effect.flip)
      expect(String(refused)).not.toContain('Stale or non-leased pool generation')
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect(
    'charges retained partial output even when the preparation reservation was too small',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, slot } = yield* fixture
        yield* fs.writeFileString(`${slot.path}/partial-install`, 'x'.repeat(16384))
        yield* fs.writeFileString(`${slot.path}/sparse-install`, '')
        yield* fs.truncate(`${slot.path}/sparse-install`, 16 * 1024 * 1024)
        yield* withPoolState({
          base: storePath,
          use: (state, save) =>
            save({
              ...state,
              slots: [
                { ...slot, charge: 1, token: 'partial', state: 'preparing', chargeKnown: false },
              ],
            }),
        })
        yield* quarantinePool({
          base: storePath,
          id: slot.id,
          token: 'partial',
          reason: 'install failed',
        })
        const state = yield* withPoolState({
          base: storePath,
          use: (state) => Effect.succeed(state),
        })
        expect(state.slots[0]?.state).toBe('quarantined')
        expect(state.slots[0]!.charge).toBeGreaterThan(16 * 1024 * 1024 + 16384)
        expect(yield* fs.readFileString(`${slot.path}/partial-install`)).toHaveLength(16384)
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('a missing root does not clear accounting for retained open files', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const { storePath, slot } = yield* fixture
      yield* fs.writeFileString(`${slot.path}/retained`, 'held')
      const file = yield* fs.open(`${slot.path}/retained`, { flag: 'r' })
      yield* withPoolState({
        base: storePath,
        use: (state, save) =>
          save({
            ...state,
            slots: [{ ...slot, token: 'lost', state: 'completed', chargeKnown: false }],
          }),
      })
      // External pathname loss does not release the real open file description.
      yield* fs.remove(slot.path, { recursive: true })
      const state = yield* inspectPool(storePath)
      expect(state.slots[0]?.state).toBe('quarantined')
      expect(state.slots[0]?.chargeKnown).toBe(false)
      const retained = new Uint8Array(4)
      expect(yield* file.read(retained)).toBe(4)
      expect(new TextDecoder().decode(retained)).toBe('held')
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
      const state = yield* withPoolState({ base: storePath, use: (state) => Effect.succeed(state) })
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
      const preserved = yield* withPoolState({
        base: storePath,
        use: (state) => Effect.succeed(state.slots[0]),
      })
      expect(preserved?.state).toBe('ready')
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('inspection retains preparing and failed intents without poisoning a free root ledger', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      for (const failure of [false, true]) {
        const { storePath, slot } = yield* fixture
        expect(yield* fs.exists(slot.path)).toBe(true)
        expect(yield* poolBytes(slot.path)).toBeGreaterThan(0)
        const proof = yield* readWorktreeReferencesInUse({
          worktreePath: slot.path,
          scope: 'gc-owner',
        })
        expect(proof._tag).toBe('free')
        const intent = yield* beginPoolRetarget({
          slot,
          generation: slot.generation,
          identity: slot.identity,
          commit: 'b'.repeat(40),
          owner: 'retarget-task',
        })
        const record =
          failure === true
            ? yield* finishPoolRetarget({
                slot: intent,
                generation: intent.generation,
                token: intent.retarget!.token,
                result: { _tag: 'Failed', reason: 'doctor failed' },
              })
            : intent
        yield* withPoolState({
          base: storePath,
          use: (state, save) => save({ ...state, slots: [record] }),
        })
        const inspected = yield* inspectPool(storePath)
        expect(inspected.slots[0]).toMatchObject({
          state: 'quarantined',
          chargeKnown: false,
          identity: '',
          generation: intent.generation,
          barrierToken: slot.barrierToken,
          retarget: intent.retarget,
        })
        const reopened = yield* withPoolState({
          base: storePath,
          use: (state) => Effect.succeed(state),
        })
        expect(reopened).toEqual(inspected)
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )
})
