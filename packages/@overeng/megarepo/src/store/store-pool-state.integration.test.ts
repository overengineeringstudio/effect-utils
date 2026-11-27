import { dirname, join } from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Cause, Effect, Exit, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import { EffectPath } from '@overeng/effect-path'
import { Vitest } from '@overeng/utils-dev/node-vitest'

import { acquireDeletionLease, adoptPersistentDeletionLease } from './store-deletion-lease.ts'
import { type DeletionIdentity } from './store-pinned-deletion.ts'
import { runPoolCommand } from './store-pool-install.ts'
import {
  beginPoolClaim,
  finishPoolClaim,
  PoolError,
  type PoolActor,
  type PoolState,
  type PoolSlot,
  readPoolProvenance,
  requirePoolLease,
  reserveFreshPoolRoot,
  reservePoolSlot,
  withPoolState,
} from './store-pool-state.ts'

const slot: PoolSlot = {
  id: 'slot',
  path: '/source/pool/slot',
  bare: '/source/.bare',
  commit: 'a'.repeat(40),
  identity: 'installed',
  charge: 64,
  generation: 1,
  state: 'leased',
  token: 'claim',
  barrierToken: 'barrier',
  owner: 'task',
  reason: '',
  chargeKnown: true,
}
// Synthetic recorded metadata only: no chain, actor or candidate here is a fresh native/process/seat proof.
const actor: PoolActor = { hostId: 'metadata-host', bootId: 'metadata-boot', pid: 1, startTime: 'metadata-start' }
const metadataChain = (path: string): DeletionIdentity => {
  const parts = path.split('/').filter((part) => part !== '')
  return ['/', ...parts.map((_, index) => `/${parts.slice(0, index + 1).join('/')}`)].map((path, index) => {
    const entry: DeletionIdentity[number] = { _tag: 'Inode', path, mountId: '1', dev: '1', ino: String(index + 1) }
    return entry
  })
}
const metadataReadyFromFresh = (fresh: PoolSlot): PoolSlot => ({
  ...fresh, state: 'ready', generation: 1, identity: 'installed', chargeKnown: true,
  token: '', owner: '', barrierToken: 'metadata-barrier',
  physicalBirth: { bootId: actor.bootId, root: metadataChain(fresh.path),
    gitAdmin: metadataChain(join(fresh.bare, 'worktrees', fresh.id)) },
  lifecycle: { birth: { generation: 1, actor, state: 'terminal', outcome: 'success' } },
})
const metadataId = '223e4567-e89b-42d3-a456-426614174000'
const metadataPath = join(dirname(slot.bare), 'pool', metadataId)
const readySlot = metadataReadyFromFresh({ ...slot, id: metadataId, path: metadataPath,
  executionRoot: { origin: 'fresh-reserved-uuid', path: metadataPath, authored: false } })

const withPoolTestCtx = Vitest.makeWithTestCtx({ makeLayer: () => NodeServices.layer })
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

describe('pool provenance observation', () => {
  it.effect('keeps an absent ledger absent without initializing directories or leases', (test) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const base = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
      expect(yield* readPoolProvenance({ base })).toEqual({
        _tag: 'Absent',
        observations: [],
        disposition: 'HOLD',
        authorizesRemoval: false,
      })
      expect(yield* fs.readDirectory(base)).toEqual([])
    }).pipe(withPoolTestCtx(test)),
  )

  it.effect('observes every state without rewriting records or exporting capabilities', (test) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const base = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
      const states: PoolSlot['state'][] = [
        'preparing',
        'ready',
        'leased',
        'completed',
        'quarantined',
        'claiming',
      ]
      const slots = states.map((state, index) => ({
        bare: slot.bare,
        commit: slot.commit,
        identity: slot.identity,
        charge: slot.charge,
        generation: slot.generation,
        reason: slot.reason,
        chargeKnown: slot.chargeKnown,
        id: String(index),
        path: `${base}/${index}`,
        state,
        owner: state === 'ready' ? '' : 'task-label-not-seat',
        token: state === 'ready' ? '' : `secret-claim-${index}`,
        barrierToken: `secret-barrier-${index}`,
      }))
      yield* withPoolState({
        base,
        limits: { maxSlots: states.length, maxBytes: slot.charge * states.length },
        use: (state, save) => save({ ...state, slots }),
      })
      const path = `${base}/.state/pool/state.json`
      const before = yield* fs.readFileString(path)
      const info = yield* fs.stat(path)
      const entries = yield* fs.readDirectory(`${base}/.state/pool`)
      const snapshot = yield* readPoolProvenance({ base })
      expect(snapshot._tag).toBe('Observed')
      expect(snapshot.observations).toHaveLength(states.length)
      expect(snapshot.observations[1]?.recordedReadyUnclaimed).toBe(true)
      for (const observation of snapshot.observations) {
        expect(observation.disposition).toBe('HOLD')
        expect(observation.authorizesRemoval).toBe(false)
        for (const evidence of [
          observation.ownerActivity,
          observation.seatActivity,
          observation.terminalClaim,
          observation.terminalBirth,
          observation.terminalRetarget,
          observation.executionProvenance,
        ])
          expect(evidence).toEqual({ _tag: 'Missing', reason: 'not-recorded-in-pool-v1' })
      }
      expect(encodeJson(snapshot)).not.toContain('secret-claim-')
      expect(encodeJson(snapshot)).not.toContain('secret-barrier-')
      expect(yield* fs.readFileString(path)).toBe(before)
      const after = yield* fs.stat(path)
      expect(after.ino).toEqual(info.ino)
      expect(after.mtime).toEqual(info.mtime)
      expect(yield* fs.readDirectory(`${base}/.state/pool`)).toEqual(entries)
    }).pipe(withPoolTestCtx(test)),
  )

  it.effect('rejects malformed, unsupported and invalid records without repairing them', (test) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const base = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
      yield* fs.makeDirectory(`${base}/.state/pool`, { recursive: true })
      const path = `${base}/.state/pool/state.json`
      const sentinel = 'private-pool-capability-property'
      for (const contents of [
        '{',
        encodeJson({ version: 2, maxSlots: 1, maxBytes: 64, slots: [] }),
        encodeJson({
          version: 1,
          maxSlots: 1,
          maxBytes: 64,
          slots: [{ ...slot, generation: -1 }],
        }),
        encodeJson({
          version: 1,
          maxSlots: 1,
          maxBytes: 64,
          slots: [
            {
              ...slot,
              generation: { [sentinel]: sentinel },
              token: sentinel,
              barrierToken: sentinel,
            },
          ],
        }),
      ]) {
        yield* fs.writeFileString(path, contents)
        const result = yield* readPoolProvenance({ base }).pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result) === true) {
          const pretty = Cause.pretty(result.cause)
          const json = encodeJson(result.cause)
          expect(pretty).toContain('Pool provenance unavailable; removal remains HOLD')
          expect(pretty).not.toContain(sentinel)
          expect(json).not.toContain(sentinel)
          expect(json).toContain('PoolError')
          expect(json).not.toContain('SchemaError')
        }
        expect(yield* fs.readFileString(path)).toBe(contents)
        expect(yield* fs.readDirectory(`${base}/.state/pool`)).toEqual(['state.json'])
      }
    }).pipe(withPoolTestCtx(test)),
  )
})

describe('pool authoritative lifecycle', () => {
  it.effect('runs the declared libc utility without an ambient command search path', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const getconf = process.env.MR_GETCONF_BIN
      if (getconf === undefined)
        return yield* Effect.die(new Error('The normal task must declare MR_GETCONF_BIN'))
      const output = yield* runPoolCommand({
        cwd: yield* fs.makeTempDirectoryScoped(),
        command: getconf,
        args: ['LONG_BIT'],
        env: { PATH: '' },
      })
      expect(output.trim()).toMatch(/^(32|64)$/)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('publishes exactly one atomic claim for a ready generation', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const base = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
      yield* withPoolState({
        base,
        use: (state, save) => save({ ...state, slots: [readySlot] }),
        limits: { maxSlots: 1, maxBytes: 64 },
      })
      const claim = withPoolState({
        base,
        use: (state, save) => Effect.gen(function* () {
          const intent = yield* beginPoolClaim({ slot: state.slots[0]!, identity: 'installed', owner: 'task' })
          yield* save({ ...state, slots: [intent] })
          return intent
        }),
      }).pipe(Effect.flatMap((intent) => withPoolState({
        base, use: (state, save) => finishPoolClaim({ state, intent, identity: 'installed', owner: 'task', actor })
          .pipe(Effect.tap((next) => save({ ...state, slots: [next] }))),
      })), Effect.exit)
      const results = yield* Effect.all([claim, claim], { concurrency: 2 })
      expect(results.filter(Exit.isSuccess)).toHaveLength(1)
      const claimed = yield* withPoolState({ base, use: (state) => Effect.succeed(state.slots[0]) })
      expect(claimed?.generation).toBe(2)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )
  it.effect('reserves distinct metadata records without physical execution or fabricated ROOT acquisition', (test) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const base = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
      const firstReservation = yield* reserveFreshPoolRoot({
        state: { version: 1, maxSlots: 2, maxBytes: 128, slots: [] }, bare: `${base}.bare`, commit: slot.commit, charge: 64,
      })
      const secondReservation = yield* reserveFreshPoolRoot({
        state: firstReservation.state, bare: `${base}.bare`, commit: slot.commit, charge: 64,
      })
      const first = metadataReadyFromFresh(firstReservation.slot)
      const second = metadataReadyFromFresh(secondReservation.slot)
      yield* withPoolState({
        base,
        limits: { maxSlots: 2, maxBytes: 128 },
        use: (state, save) => save({ ...state, slots: [first, second] }),
      })
      const reserve = withPoolState({
        base,
        use: (state, save) => Effect.gen(function* () {
          const selected = state.slots.find((candidate) => candidate.state === 'ready')
          if (selected === undefined)
            return yield* new PoolError({ message: 'No ready metadata candidate; HOLD' })
          const intent = yield* beginPoolClaim({ slot: selected, identity: 'installed', owner: 'task' })
          yield* save({ ...state, slots: state.slots.map((candidate) => candidate.id === intent.id ? intent : candidate) })
          return intent
        }),
      })
      const a = yield* reserve
      const b = yield* reserve
      expect(a.id).not.toBe(b.id)
      expect(a.token).not.toBe(b.token)
      for (const intent of [a, b]) {
        expect(intent.state).toBe('claiming')
        expect(intent.generation).toBe(readySlot.generation + 1)
        expect(intent.chargeKnown).toBe(false)
        expect(intent.token).not.toBe('')
        expect(yield* requirePoolLease({
          slot: intent, token: intent.token, generation: intent.generation,
        }).pipe(Effect.exit)).toSatisfy(Exit.isFailure)
      }
      const persisted = yield* withPoolState({ base, use: (state) => Effect.succeed(state) })
      expect(persisted.slots).toEqual([a, b])
      expect(yield* reservePoolSlot({
        state: persisted, slot: { ...readySlot, id: 'third', path: `${base}pool/third` },
      }).pipe(Effect.flip)).toMatchObject({ message: expect.stringContaining('unknown') })
      const snapshot = yield* readPoolProvenance({ base })
      expect(snapshot.observations).toHaveLength(2)
      for (const observation of snapshot.observations) {
        expect(observation.recordedState).toBe('claiming')
        expect(observation.recordedReadyUnclaimed).toBe(false)
        expect(observation.disposition).toBe('HOLD')
        expect(observation.authorizesRemoval).toBe(false)
      }
      expect(yield* fs.exists(`${base}pool`)).toBe(false)
    }).pipe(withPoolTestCtx(test)),
  )

  it.effect('accepts only the exact reserved snapshot without minting a second generation or token', () =>
    Effect.gen(function* () {
      const intent = yield* beginPoolClaim({ slot: readySlot, identity: 'installed', owner: 'task' })
      const state: PoolState = { version: 1, maxSlots: 1, maxBytes: 64, slots: [intent] }
      const accepted = yield* finishPoolClaim({ state, intent, identity: 'installed', owner: 'task', actor })
      expect(accepted).toEqual({ ...intent, state: 'leased',
        lifecycle: { ...intent.lifecycle, claim: { generation: intent.generation, actor, state: 'active' } } })
      expect(intent.state).toBe('claiming')
      yield* requirePoolLease({ slot: accepted, token: intent.token, generation: intent.generation })
      for (const delta of [
        { token: 'different' },
        { generation: intent.generation + 1 },
        { owner: 'different' },
        { identity: 'different' },
        { state: 'quarantined' as const },
        { barrierToken: 'different' },
        { commit: 'b'.repeat(40) },
      ]) {
        expect(yield* finishPoolClaim({
          state: { ...state, slots: [{ ...intent, ...delta }] },
          intent, identity: 'installed', owner: 'task', actor,
        }).pipe(Effect.exit)).toSatisfy(Exit.isFailure)
      }
      for (const request of [
        { identity: 'different', owner: 'task' },
        { identity: 'installed', owner: 'different' },
        { identity: 'installed', owner: '' },
      ]) {
        expect(yield* finishPoolClaim({ state, intent, ...request, actor }).pipe(Effect.exit))
          .toSatisfy(Exit.isFailure)
      }
      for (const invalid of [readySlot, { ...intent, token: '' }]) {
        expect(yield* finishPoolClaim({
          state: { ...state, slots: [invalid] },
          intent: invalid, identity: 'installed', owner: 'task', actor,
        }).pipe(Effect.exit)).toSatisfy(Exit.isFailure)
      }
    }),
  )

  it.effect('records a new process leader without confusing the creator or owner label with seat authority', () =>
    Effect.gen(function* () {
      const intent = yield* beginPoolClaim({ slot: readySlot, identity: 'installed', owner: 'metadata-task-label' })
      const state: PoolState = { version: 1, maxSlots: 1, maxBytes: 64, slots: [intent] }
      const nextActor: PoolActor = { ...actor, pid: 2, startTime: 'next-metadata-generation' }
      const accepted = yield* finishPoolClaim({ state, intent, identity: 'installed', owner: 'metadata-task-label', actor: nextActor })
      expect(accepted.lifecycle?.claim).toEqual({ generation: intent.generation, actor: nextActor, state: 'active' })
      expect(accepted.lifecycle?.birth).toEqual(intent.lifecycle?.birth)
      expect(accepted.physicalBirth).toEqual(intent.physicalBirth)
      expect(accepted.barrierToken).toBe(intent.barrierToken)
      expect(accepted.charge).toBe(intent.charge)
      expect(accepted.chargeKnown).toBe(false)
      expect(intent.lifecycle?.claim).toBeUndefined()
      for (const invalid of [
        { ...actor, pid: 0 }, { ...actor, pid: 1.5 }, { ...actor, startTime: '' },
        { ...actor, hostId: 'other-host' }, { ...actor, bootId: 'other-boot' },
      ])
        expect(yield* finishPoolClaim({ state, intent, identity: 'installed', owner: 'metadata-task-label', actor: invalid })
          .pipe(Effect.exit)).toSatisfy(Exit.isFailure)
    }),
  )

  it.effect('holds unknown birth, active prior operations and malformed saved claim phases', () =>
    Effect.gen(function* () {
      const intent = yield* beginPoolClaim({ slot: readySlot, identity: 'installed', owner: 'task' })
      const birth = intent.physicalBirth
      if (birth === undefined) return yield* Effect.die('Metadata fixture omitted recorded physical birth')
      const candidates: PoolSlot[] = [
        { ...intent, physicalBirth: undefined },
        { ...intent, lifecycle: {} },
        { ...intent, chargeKnown: true },
        { ...intent, lifecycle: { ...intent.lifecycle, birth: { generation: 1, actor, state: 'active' } } },
        { ...intent, lifecycle: { ...intent.lifecycle, claim: { generation: intent.generation, actor, state: 'active' } } },
        { ...intent, lifecycle: { ...intent.lifecycle, retarget: { generation: 1, actor, state: 'active' } } },
        { ...intent, physicalBirth: { ...birth, bootId: 'other-boot' } },
      ]
      for (const invalid of candidates) {
        const state: PoolState = { version: 1, maxSlots: 1, maxBytes: 64, slots: [invalid] }
        expect(yield* finishPoolClaim({ state, intent: invalid, identity: 'installed', owner: 'task', actor })
          .pipe(Effect.exit)).toSatisfy(Exit.isFailure)
      }
    }),
  )

  it.effect('refuses claimed-ready records, empty owners and unsafe generation increments', () =>
    Effect.gen(function* () {
      const candidates: ReadonlyArray<PoolSlot> = [
        slot,
        { ...readySlot, state: 'claiming' },
        { ...readySlot, token: 'unreleased' },
        { ...readySlot, owner: 'unreleased' },
        ...[-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]
          .map((generation) => ({ ...readySlot, generation })),
      ]
      for (const candidate of candidates) {
        expect(yield* beginPoolClaim({
          slot: candidate, identity: 'installed', owner: 'task',
        }).pipe(Effect.exit)).toSatisfy(Exit.isFailure)
      }
      expect(yield* beginPoolClaim({
        slot: readySlot, identity: 'installed', owner: '',
      }).pipe(Effect.exit)).toSatisfy(Exit.isFailure)
    }),
  )


  it.effect('counts all generations including retained quarantine against host capacity', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const base = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
      yield* withPoolState({
        base,
        use: (state, save) =>
          Effect.flatMap(reservePoolSlot({ state, slot: { ...slot, state: 'quarantined' } }), save),
        limits: { maxSlots: 1, maxBytes: 128 },
      })
      const rejected = yield* withPoolState({
        base,
        use: (state) => reservePoolSlot({ state, slot: { ...slot, id: 'other' } }),
      }).pipe(Effect.flip)
      expect(rejected.message).toContain('capacity')
      const loaded = yield* withPoolState({ base, use: (state) => Effect.succeed(state) })
      expect(loaded.slots[0]?.state).toBe('quarantined')
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('charges bytes across repositories, not per seat or source revision', () =>
    Effect.gen(function* () {
      const ready = readySlot
      const state = { version: 1 as const, maxSlots: 10, maxBytes: 100, slots: [ready] }
      const failure = yield* reservePoolSlot({
        state,
        slot: { ...slot, id: 'next', bare: '/other/.bare' },
      }).pipe(Effect.flip)
      expect(failure.message).toContain('capacity')
      const intent = yield* beginPoolClaim({ slot: ready, identity: 'installed', owner: 'task' })
      const held = yield* finishPoolClaim({ state: { ...state, slots: [intent] }, intent, identity: 'installed', owner: 'task', actor })
      expect(held.chargeKnown).toBe(false)
      const unknown = yield* reservePoolSlot({
        state: { ...state, slots: [held] },
        slot,
      }).pipe(Effect.flip)
      expect(unknown.message).toContain('unknown')
      const remeasured = { ...held, state: 'ready' as const, chargeKnown: true, token: '', owner: '' }
      expect(
        (yield* reservePoolSlot({
          state: { ...state, slots: [remeasured] },
          slot: { ...slot, id: 'next', charge: 36 },
        })).slots,
      ).toHaveLength(2)
      const historical = yield* reservePoolSlot({
        state: { ...state, slots: [{ ...slot, chargeKnown: undefined }] },
        slot,
      }).pipe(Effect.flip)
      expect(historical.message).toContain('unknown')
    }),
  )

  it.effect('rejects stale generations, wrong owners and dirty/quarantined leases', () =>
    Effect.gen(function* () {
      yield* requirePoolLease({ slot, token: 'claim', generation: 1 })
      for (const candidate of [
        { token: 'claim', generation: 0, state: 'leased' as const },
        { token: 'other', generation: 1, state: 'leased' as const },
        { token: 'claim', generation: 1, state: 'quarantined' as const },
      ]) {
        expect(
          yield* requirePoolLease({
            slot: { ...slot, state: candidate.state },
            token: candidate.token,
            generation: candidate.generation,
          }).pipe(Effect.exit),
        ).toSatisfy(Exit.isFailure)
      }
    }),
  )

  it.effect('does not recover a persistent barrier when its recorded provider is dead', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const base = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
      const owner = `${base}pool-root`
      const lease = yield* acquireDeletionLease({
        storeBasePath: base,
        ownerPath: owner,
        now: 1,
        persistent: true,
      })
      const record = yield* fs.readFileString(lease.leasePath)
      // Rewrite just the lifetime in real authoritative bytes, emulating provider loss.
      yield* fs.writeFileString(
        lease.leasePath,
        record.replace(`"pid":${process.pid}`, '"pid":2147483647'),
      )
      expect(
        yield* acquireDeletionLease({ storeBasePath: base, ownerPath: owner, now: 2 }).pipe(
          Effect.exit,
        ),
      ).toSatisfy(Exit.isFailure)
      yield* adoptPersistentDeletionLease(lease)
      expect(yield* fs.readFileString(lease.leasePath)).toContain(`"pid":${process.pid}`)
      expect(
        yield* adoptPersistentDeletionLease({ ...lease, token: 'wrong' }).pipe(Effect.exit),
      ).toSatisfy(Exit.isFailure)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('refuses unknown state versions rather than treating the pool as empty', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const base = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
      yield* fs.makeDirectory(`${base}.state/pool`, { recursive: true })
      yield* fs.writeFileString(`${base}.state/pool/state.json`, '{"version":99}')
      expect(
        yield* withPoolState({
          base,
          use: () => Effect.void,
          limits: { maxSlots: 1, maxBytes: 1 },
        }).pipe(Effect.exit),
      ).toSatisfy(Exit.isFailure)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )
})
