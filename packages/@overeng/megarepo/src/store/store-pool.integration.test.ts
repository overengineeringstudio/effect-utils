import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Exit, Option } from 'effect'
import { expect } from 'vitest'

import * as Git from '../core/git.ts'
import { createStoreFixture } from '../test-utils/store-setup.ts'
import { acquireDeletionLease } from './store-deletion-lease.ts'
import { type PoolSlot, reservePoolSlot, withPoolState } from './store-pool-state.ts'

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
  yield* withPoolState({
    base: f.storePath,
    use: (state, save) => Effect.flatMap(reservePoolSlot({ state, slot }), save),
    limits: { maxSlots: 1, maxBytes: 1048576 },
  })
  return { ...f, slot }
})

describe('native pool ownership safety', () => {
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
})
