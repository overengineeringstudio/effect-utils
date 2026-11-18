import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Exit } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import * as Git from '../core/git.ts'
import { createStoreFixture } from '../test-utils/store-setup.ts'
import { acquireDeletionLease, deletionLeasePath } from './store-deletion-lease.ts'
import { completePool, inspectPool } from './store-pool.ts'
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
    state: 'ready', chargeKnown: true, generation: 0, token: '', barrierToken: lease.token, owner: '', reason: '' }
  yield* withPoolState(f.storePath, (state, save) => Effect.flatMap(reservePoolSlot(state, slot), save),
    { maxSlots: 1, maxBytes: 1048576 })
  return { ...f, slot }
})

describe('native pool ownership safety', () => {
  it.effect('successful completion survives status with a lost provider identity', () =>
    Effect.gen(function* () {
      const { storePath, slot } = yield* fixture
      yield* withPoolState(storePath, (state, save) => save({
        ...state, slots: [{ ...slot, state: 'leased', token: 'task', generation: 1 }],
      }))
      yield* completePool(storePath, slot.id, 'task', 1)
      const fs = yield* FileSystem.FileSystem
      const lease = deletionLeasePath({ storeBasePath: storePath, ownerPath: slot.path })
      const record = yield* fs.readFileString(lease)
      yield* fs.writeFileString(lease, record.replace(`"pid":${process.pid}`, '"pid":2147483647'))
      const observed = yield* inspectPool(storePath)
      expect(observed.slots[0]?.state).toBe('completed')
      expect(yield* completePool(storePath, slot.id, 'stale', 1).pipe(Effect.exit)).toSatisfy(Exit.isFailure)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

[Showing lines 1-48 of 114. Use :49 to continue]
})
