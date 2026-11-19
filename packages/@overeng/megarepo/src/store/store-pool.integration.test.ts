import { dirname } from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Cause, Clock, Effect, Exit, Option } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import * as Git from '../core/git.ts'
import { createStoreFixture } from '../test-utils/store-setup.ts'
import { acquireDeletionLease, deletionLeasePath, readCurrentDeletionLeaseProvider } from './store-deletion-lease.ts'
import { readWorktreeReferencesInUse } from './store-inuse.ts'
import { poolBytes } from './store-pool-install.ts'
import { withPoolRetirement } from './store-pool-retirement.ts'
import {
  beginPoolRetarget,
  claimPoolGeneration,
  consumePoolReservation,
  finishPoolRetarget,
  PoolError,
  type PoolActivityEvent,
  type PoolSlot,
  requireDisposablePoolRoot,
  readPoolState,
  withPoolState,
} from './store-pool-state.ts'
import {
  authorPoolRoot,
  claimPool,
  completePool,
  inspectPool,
  prewarmPool,
  quarantinePool,
  releasePool,
  reservePool,
} from './store-pool.ts'

const fixture = Effect.gen(function* () {
  const f = yield* createStoreFixture([
    { host: 'github.com', owner: 'test-owner', repo: 'pool-test', branches: ['main'] },
  ])
  const bare = f.bareRepoPaths['github.com/test-owner/pool-test']!
  const commit = yield* Git.getCurrentCommit(
    f.worktreePaths['github.com/test-owner/pool-test#main']!,
  )
  const reserved = yield* reservePool({
    base: f.storePath, bare, commit, charge: 1048576, maxSlots: 1, maxBytes: 1048576,
  })
  const preparing = yield* consumePoolReservation({
    slot: reserved, id: reserved.id, reservation: reserved.reservation!,
    generation: reserved.generation, bare: reserved.bare, commit, charge: reserved.charge,
  })
  yield* withPoolState({
    base: f.storePath,
    use: (state, save) => save({
      ...state, slots: state.slots.map((item) => item.id === preparing.id ? preparing : item),
    }),
  })
  const path = preparing.path
  const lease = yield* acquireDeletionLease({
    storeBasePath: f.storePath,
    ownerPath: path,
    now: 1,
    persistent: true,
  })
  yield* withPoolState({
    base: f.storePath,
    use: (state, save) => save({
      ...state, slots: state.slots.map((item) =>
        item.id === preparing.id ? { ...preparing, barrierToken: lease.token } : item),
    }),
  })
  yield* Git.ensureBareRefLogging({ repoPath: bare })
  yield* Git.createWorktreeDetached({
    repoPath: bare,
    worktreePath: path,
    commit,
    lockReason: `mr-pool:${preparing.id}:preparing`,
  })
  // Native protection only: this fixture intentionally has no qualified install or birth activity.
  const slot: PoolSlot = {
    id: preparing.id,
    path,
    bare,
    commit,
    sourceHistory: [commit],
    executionRoot: preparing.executionRoot,
    identity: 'receipt',
    charge: 1048576,
    state: 'ready',
    chargeKnown: true,
    generation: preparing.generation,
    token: '',
    barrierToken: lease.token,
    owner: '',
    reason: '',
  }
  yield* withPoolState({
    base: f.storePath,
    use: (state, save) => save({
      ...state, slots: state.slots.map((item) => item.id === slot.id ? slot : item),
    }),
    limits: { maxSlots: 1, maxBytes: 1048576 },
  })
  return { ...f, slot }
})

const reservationFixture = (missingCommit = false) =>
  Effect.gen(function* () {
    const f = yield* createStoreFixture([
      { host: 'github.com', owner: 'test-owner', repo: 'pool-reserve', branches: ['main'] },
    ])
    const bare = f.bareRepoPaths['github.com/test-owner/pool-reserve']!
    const commit =
      missingCommit === true
        ? 'f'.repeat(40)
        : yield* Git.getCurrentCommit(f.worktreePaths['github.com/test-owner/pool-reserve#main']!)
    const reserved = yield* reservePool({
      base: f.storePath,
      bare,
      commit,
      charge: 1048576,
      maxSlots: 1,
      maxBytes: 1048576,
    })
    const receipt = {
      base: f.storePath,
      bare: reserved.bare,
      commit,
      charge: reserved.charge,
      id: reserved.id,
      reservation: reserved.reservation!,
      generation: reserved.generation,
    }
    return { ...f, reserved, receipt }
  })

describe('native pool ownership safety', () => {
  it.effect('reserves without birth and refuses stale preparation without consuming the nonce', () =>
    Effect.gen(function* () {
      const f = yield* reservationFixture()
      const fs = yield* FileSystem.FileSystem
      expect(yield* fs.exists(f.reserved.path)).toBe(false)
      expect((yield* inspectPool(f.storePath)).slots[0]).toEqual(f.reserved)
      const stale = yield* prewarmPool({ ...f.receipt, reservation: 'stale' }).pipe(Effect.exit)
      expect(Exit.isFailure(stale)).toBe(true)
      expect((yield* inspectPool(f.storePath)).slots[0]).toEqual(f.reserved)
      expect(yield* fs.exists(f.reserved.path)).toBe(false)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('refuses fresh authority over unknown roots, stale native registrations or durable barriers', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      for (const scenario of [
        'unregistered-root', 'stale-native', 'persistent-barrier', 'unknown-lease',
        'persistent-staging', 'unknown-staging',
      ]) {
        const f = yield* createStoreFixture([
          { host: 'github.com', owner: 'test-owner', repo: 'pool-old', branches: ['main'] },
          { host: 'github.com', owner: 'test-owner', repo: 'pool-fresh', branches: ['main'] },
        ])
        const oldBare = f.bareRepoPaths['github.com/test-owner/pool-old']!
        const bare = f.bareRepoPaths['github.com/test-owner/pool-fresh']!
        const commit = yield* Git.getCurrentCommit(f.worktreePaths['github.com/test-owner/pool-fresh#main']!)
        const namespace = `${oldBare.replace(/\/\.bare\/?$/u, '')}/pool`
        const orphan = `${namespace}/orphan`
        let marker: string | undefined
        let leaseSnapshot: { path: string; bytes: string } | undefined
        if (scenario === 'unregistered-root' || scenario === 'stale-native') {
          if (scenario === 'stale-native') yield* Git.createWorktreeDetached({
            repoPath: oldBare, worktreePath: orphan, lockReason: 'mr-pool:orphan:preparing',
            commit: yield* Git.getCurrentCommit(f.worktreePaths['github.com/test-owner/pool-old#main']!),
          })
          else yield* fs.makeDirectory(orphan, { recursive: true })
          marker = `${orphan}/preserved`
          yield* fs.writeFileString(marker, 'keep unknown work')
          if (scenario === 'stale-native') {
            const retained = `${f.storePath}retained-pool`
            yield* fs.rename(namespace, retained)
            marker = `${retained}/orphan/preserved`
          }
        } else {
          const lease = yield* acquireDeletionLease({
            storeBasePath: f.storePath, ownerPath: orphan, now: 1,
            persistent: scenario === 'persistent-barrier' || scenario === 'persistent-staging',
          })
          const path = scenario.endsWith('staging') === true
            ? `${lease.leasePath}.${lease.token}.staging` : lease.leasePath
          if (path !== lease.leasePath) yield* fs.rename(lease.leasePath, path)
          let bytes = yield* fs.readFileString(path)
          if (scenario === 'unknown-lease' || scenario === 'unknown-staging') {
            const unsupported = bytes.replace('"version":1', '"version":3')
            expect(unsupported).not.toBe(bytes)
            bytes = unsupported
            yield* fs.writeFileString(path, bytes)
          }
          leaseSnapshot = { path, bytes }
        }
        const result = yield* reservePool({
          base: f.storePath, bare, commit, charge: 1048576, maxSlots: 1, maxBytes: 1048576,
        }).pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        expect(yield* fs.exists(`${f.storePath}.state/pool/state.json`)).toBe(false)
        expect(yield* fs.exists(`${bare.replace(/\/\.bare\/?$/u, '')}/pool`)).toBe(false)
        if (marker !== undefined) expect(yield* fs.readFileString(marker)).toBe('keep unknown work')
        if (leaseSnapshot !== undefined)
          expect(yield* fs.readFileString(leaseSnapshot.path)).toBe(leaseSnapshot.bytes)
        if (scenario === 'stale-native' && Exit.isFailure(result) === true) {
          expect(Cause.pretty(result.cause)).toContain('native pool registrations retained')
          expect(yield* fs.exists(namespace)).toBe(false)
        }
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('retains real native work and barriers when an existing authoritative ledger is lost', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const f = yield* fixture
      const ledger = `${f.storePath}.state/pool/state.json`
      const lease = deletionLeasePath({ storeBasePath: f.storePath, ownerPath: f.slot.path })
      const barrierBytes = yield* fs.readFileString(lease)
      yield* fs.writeFileString(`${f.slot.path}/preserved`, 'keep unpublished work')
      yield* fs.remove(ledger)
      const rejected = yield* reservePool({
        base: f.storePath, bare: f.slot.bare, commit: f.slot.commit,
        charge: f.slot.charge, maxSlots: 1, maxBytes: f.slot.charge,
      }).pipe(Effect.exit)
      expect(Exit.isFailure(rejected)).toBe(true)
      expect(yield* fs.exists(ledger)).toBe(false)
      expect(yield* fs.readFileString(`${f.slot.path}/preserved`)).toBe('keep unpublished work')
      expect(yield* fs.readFileString(lease)).toBe(barrierBytes)
      const native = (yield* Git.listWorktrees(f.slot.bare)).find((entry) => entry.path === f.slot.path)
      expect(Option.getOrUndefined(native!.lockReason)).toBe(`mr-pool:${f.slot.id}:preparing`)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('retains native data and barriers on refusal, stale ownership or incomplete exact-admin removal', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const provider = yield* readCurrentDeletionLeaseProvider
      for (const mode of ['reported-failure', 'missing-removal', 'admin-retained', 'stale-binding'] as const) {
        const f = yield* fixture
        // Historical schema input only, not a successful install or qualified birth.
        const ready: PoolSlot = { ...f.slot, activity: {
          generation: f.slot.generation, commit: f.slot.commit, identity: f.slot.identity, phase: 'birth-ready',
          event: {
            observedAtUtc: '2026-11-19T12:00:00.000Z',
            provider: { pid: 123, uid: 456, processStartTime: '789' },
            ownerLabel: '', ownerLabelOrigin: 'none',
          },
        } }
        yield* withPoolState({ base: f.storePath, use: (state, save) =>
          save({ ...state, slots: [ready] }) })
        yield* fs.writeFileString(`${ready.path}/preserved`, 'never delete this unqualified fixture')
        let called = false
        let capturedAdmin: string | undefined
        const result = yield* withPoolRetirement({
          base: f.storePath, expected: ready,
          remove: ({ target, assertCurrent }) => Effect.gen(function* () {
            called = true
            yield* assertCurrent
            capturedAdmin = target.adminDir
            const current = yield* readPoolState({ base: f.storePath })
            expect(JSON.stringify(target)).not.toContain(current.slots[0]!.retirement!.nonce)
            expect(target.id).toBe(ready.id)
            expect(target.generation).toBe(ready.generation)
            expect(target.adminDir.startsWith('/')).toBe(true)
            expect(JSON.stringify(target)).not.toContain(ready.barrierToken)
            if (mode === 'reported-failure')
              return yield* new PoolError({ message: 'intentional admission refusal' })
            if (mode === 'admin-retained') {
              yield* fs.rename(ready.path, `${ready.path}-retained`)
              yield* fs.writeFileString(`${target.adminDir}/HEAD`, 'invalid-head\n')
            }
            if (mode === 'stale-binding') {
              yield* fs.writeFileString(`${f.storePath}/.state/pool/state.json`, JSON.stringify({
                ...current, slots: current.slots.map((item) => item.id === ready.id
                  ? { ...item, retirement: { ...item.retirement!, nonce: 'newer-intent-sentinel' } } : item),
              }))
              yield* assertCurrent
            }
          }),
        }).pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        expect(called).toBe(provider.processStartTime !== undefined)
        if (called === true && mode === 'reported-failure' && Exit.isFailure(result) === true)
          expect(Cause.pretty(result.cause)).toContain('intentional admission refusal')
        const retained = yield* withPoolState({
          base: f.storePath, use: (state) => Effect.succeed(state.slots[0]!),
        })
        expect(retained.generation).toBe(ready.generation + 1)
        expect(retained.retirement?.status).toBe(mode === 'stale-binding' && called === true ? 'pending' : 'failed')
        if (mode === 'stale-binding' && called === true)
          expect(retained.retirement?.nonce).toBe('newer-intent-sentinel')
        expect(retained.chargeKnown).toBe(false)
        const dataPath = mode === 'admin-retained' && called === true ? `${ready.path}-retained` : ready.path
        expect(yield* fs.readFileString(`${dataPath}/preserved`)).toBe('never delete this unqualified fixture')
        expect(yield* fs.exists(deletionLeasePath({ storeBasePath: f.storePath, ownerPath: ready.path }))).toBe(true)
        if (mode === 'admin-retained' && called === true) {
          expect(yield* fs.readFileString(`${capturedAdmin!}/locked`)).toContain(`mr-pool:${ready.id}:preparing`)
        } else {
          const native = (yield* Git.listWorktrees(ready.bare)).find((item) => item.path === ready.path)
          expect(Option.getOrUndefined(native!.lockReason)).toBe(`mr-pool:${ready.id}:preparing`)
        }
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('refuses occupied reservation paths and preserves their actual bytes', () =>
    Effect.gen(function* () {
      const f = yield* reservationFixture()
      const fs = yield* FileSystem.FileSystem
      yield* fs.makeDirectory(f.reserved.path, { recursive: true })
      yield* fs.writeFileString(`${f.reserved.path}/unowned`, 'keep')
      const rejected = yield* prewarmPool(f.receipt).pipe(Effect.exit)
      expect(Exit.isFailure(rejected)).toBe(true)
      const state = yield* withPoolState({ base: f.storePath, use: Effect.succeed })
      expect(state.slots[0]).toMatchObject({
        state: 'quarantined', chargeKnown: false, reservation: undefined,
      })
      expect(yield* fs.readFileString(`${f.reserved.path}/unowned`)).toBe('keep')
      expect(Exit.isFailure(yield* prewarmPool(f.receipt).pipe(Effect.exit))).toBe(true)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('retains a failed native creation with consumed nonce and unknown charge', () =>
    Effect.gen(function* () {
      const f = yield* reservationFixture(true)
      const fs = yield* FileSystem.FileSystem
      const failed = yield* prewarmPool(f.receipt).pipe(Effect.exit)
      expect(Exit.isFailure(failed)).toBe(true)
      const state = yield* withPoolState({ base: f.storePath, use: Effect.succeed })
      expect(state.slots[0]).toMatchObject({
        state: 'quarantined', chargeKnown: false, generation: 1, reservation: undefined,
      })
      expect(state.slots[0]?.barrierToken).not.toBe('')
      expect(yield* fs.exists(f.reserved.path)).toBe(true)
      expect(state.slots[0]?.initialPreparation).toEqual({
        generation: 1, commit: f.receipt.commit,
      })
      expect(state.slots[0]?.activity).toMatchObject({
        phase: 'birth-failed', generation: 1, commit: f.receipt.commit, identity: '',
        event: { ownerLabel: '', ownerLabelOrigin: 'none', provider: { pid: process.pid } },
      })
      const inspected = yield* inspectPool(f.storePath)
      expect(inspected.slots[0]).toMatchObject({
        state: 'quarantined', chargeKnown: false, initialPreparation: state.slots[0]?.initialPreparation,
      })
      expect(inspected.slots[0]?.activity).toEqual(state.slots[0]?.activity)
      expect(yield* withPoolState({ base: f.storePath, use: Effect.succeed })).toEqual(inspected)
      expect(Exit.isFailure(yield* prewarmPool(f.receipt).pipe(Effect.exit))).toBe(true)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('creating a separate canonical edit root leaves the fresh physical source unchanged', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const { storePath, slot } = yield* fixture
      const destination = `${dirname(slot.bare)}/refs/heads/edit-topic`
      yield* Git.createWorktree({
        repoPath: slot.bare, worktreePath: destination, branch: 'edit-topic',
        createBranch: true, startPoint: slot.commit,
      })
      yield* fs.writeFileString(`${destination}/authored`, 'canonical edit')
      const retained = (yield* readPoolState(storePath)).slots[0]!
      expect(retained).toEqual(slot)
      yield* requireDisposablePoolRoot(retained)
      expect(yield* Git.getCurrentCommit(slot.path)).toBe(slot.commit)
      expect(yield* fs.exists(`${slot.path}/authored`)).toBe(false)
      expect(retained.path).not.toBe(destination)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('marks an in-place authoring root before handoff and never resets its ignored data', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const { storePath, slot } = yield* fixture
      yield* withPoolState({
        base: storePath,
        use: (state, save) => save({
          ...state, slots: [{ ...slot, state: 'leased', token: 'author', chargeKnown: false }],
        }),
      })
      const receipt = { base: storePath, id: slot.id, token: 'author', generation: slot.generation }
      yield* authorPoolRoot(receipt)
      expect((yield* readPoolState(storePath)).slots[0]?.executionRoot?.authored).toBe(true)
      yield* fs.writeFileString(`${slot.bare}/info/exclude`, '/authored-ignored/\n')
      yield* fs.makeDirectory(`${slot.path}/authored-ignored`)
      yield* fs.writeFileString(`${slot.path}/authored-ignored/keep`, 'authored data')
      yield* completePool(receipt)
      const failure = yield* releasePool(receipt).pipe(Effect.flip)
      expect(String(failure)).toContain('Authored or unproven pool root retained')
      expect(yield* fs.readFileString(`${slot.path}/authored-ignored/keep`)).toBe('authored data')
      expect((yield* readPoolState(storePath)).slots[0]).toMatchObject({
        state: 'quarantined', executionRoot: { authored: true }, barrierToken: slot.barrierToken,
      })
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

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
      expect(observed.slots[0]?.activity).toMatchObject({
        phase: 'claim-completed', claimed: undefined, completed: undefined,
        event: { ownerLabelOrigin: 'legacy-record', provider: { pid: process.pid } },
      })
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
      const retained = (yield* withPoolState({ base: storePath, use: Effect.succeed })).slots[0]!
      expect(retained.activity).toMatchObject({
        phase: 'release-failed', claimed: undefined, completed: undefined,
        event: { ownerLabelOrigin: 'legacy-record', provider: { pid: process.pid } },
      })
      expect(retained.barrierToken).toBe(slot.barrierToken)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('preserves seeded claim provenance through actual completion and failed-provider transitions', () =>
    Effect.gen(function* () {
      const { storePath, slot } = yield* fixture
      const leased = yield* claimPoolGeneration({ slot, identity: slot.identity, owner: 'fixture-label' })
      const event: PoolActivityEvent = {
        observedAtUtc: new Date(yield* Clock.currentTimeMillis).toISOString(),
        provider: yield* readCurrentDeletionLeaseProvider,
        ownerLabel: leased.owner, ownerLabelOrigin: 'claim-argument',
      }
      yield* withPoolState({
        base: storePath,
        use: (state, save) => save({ ...state, slots: [{
          ...leased,
          activity: {
            generation: leased.generation, commit: leased.commit, identity: leased.identity,
            phase: 'claim-active', event, claimed: event,
          },
        }] }),
      })
      yield* completePool({ base: storePath, id: leased.id, token: leased.token, generation: leased.generation })
      const completed = (yield* withPoolState({ base: storePath, use: Effect.succeed })).slots[0]!
      expect(completed.activity?.phase).toBe('claim-completed')
      expect(completed.activity?.claimed).toEqual(event)
      expect(completed.activity?.completed).toEqual(completed.activity?.event)
      expect(completed.activity?.event.provider.pid).toBe(process.pid)
      expect(completed.activity?.event.ownerLabelOrigin).toBe('claim-argument')
      for (const bearer of [leased.token, leased.barrierToken]) {
        expect(JSON.stringify(completed.activity)).not.toContain(bearer)
      }
      yield* quarantinePool({ base: storePath, id: leased.id, token: leased.token, reason: 'provider reported failure' })
      const failed = (yield* withPoolState({ base: storePath, use: Effect.succeed })).slots[0]!
      expect(failed.activity?.phase).toBe('claim-failed')
      expect(failed.activity?.claimed).toEqual(event)
      expect(failed.activity?.completed).toEqual(completed.activity?.completed)
      expect(failed.activity?.event.provider.pid).toBe(process.pid)
      expect(failed.token).toBe(leased.token)
      expect(failed.barrierToken).toBe(leased.barrierToken)
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
      expect(Option.getOrUndefined(entry!.lockReason)).toBe(`mr-pool:${slot.id}:preparing`)
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
