import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Cause, Effect, Exit, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import { EffectPath } from '@overeng/effect-path'
import { Vitest } from '@overeng/utils-dev/node-vitest'

import { acquireDeletionLease, adoptPersistentDeletionLease } from './store-deletion-lease.ts'
import { runPoolCommand } from './store-pool-install.ts'
import {
  claimPoolGeneration,
  type PoolSlot,
  readPoolProvenance,
  requirePoolLease,
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
        limits: { maxSlots: 5, maxBytes: 320 },
        use: (state, save) => save({ ...state, slots }),
      })
      const path = `${base}/.state/pool/state.json`
      const before = yield* fs.readFileString(path)
      const info = yield* fs.stat(path)
      const entries = yield* fs.readDirectory(`${base}/.state/pool`)
      const snapshot = yield* readPoolProvenance({ base })
      expect(snapshot._tag).toBe('Observed')
      expect(snapshot.observations).toHaveLength(5)
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
        use: (state, save) => save({ ...state, slots: [{ ...slot, state: 'ready' }] }),
        limits: { maxSlots: 1, maxBytes: 64 },
      })
      const claim = withPoolState({
        base,
        use: (state, save) =>
          claimPoolGeneration({
            slot: state.slots[0]!,
            identity: 'installed',
            owner: 'task',
          }).pipe(Effect.tap((next) => save({ ...state, slots: [next] }))),
      }).pipe(Effect.exit)
      const results = yield* Effect.all([claim, claim], { concurrency: 2 })
      expect(results.filter(Exit.isSuccess)).toHaveLength(1)
      const claimed = yield* withPoolState({ base, use: (state) => Effect.succeed(state.slots[0]) })
      expect(claimed?.generation).toBe(2)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
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
      const ready = { ...slot, state: 'ready' as const }
      const state = { version: 1 as const, maxSlots: 10, maxBytes: 100, slots: [ready] }
      const failure = yield* reservePoolSlot({
        state,
        slot: { ...slot, id: 'next', bare: '/other/.bare' },
      }).pipe(Effect.flip)
      expect(failure.message).toContain('capacity')
      const held = yield* claimPoolGeneration({ slot: ready, identity: 'installed', owner: 'task' })
      expect(held.chargeKnown).toBe(false)
      const unknown = yield* reservePoolSlot({
        state: { ...state, slots: [held] },
        slot,
      }).pipe(Effect.flip)
      expect(unknown.message).toContain('unknown')
      const remeasured = { ...held, state: 'ready' as const, chargeKnown: true }
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
