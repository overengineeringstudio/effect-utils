import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Exit } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import { EffectPath } from '@overeng/effect-path'

import { acquireDeletionLease, adoptPersistentDeletionLease } from './store-deletion-lease.ts'
import {
  claimPoolGeneration,
  type PoolSlot,
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

describe('pool authoritative lifecycle', () => {
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
      expect(
        (yield* withPoolState({ base, use: (state) => Effect.succeed(state.slots[0]) }))?.generation,
      ).toBe(2)
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
      const leased = yield* claimPoolGeneration({ slot: ready, identity: 'installed', owner: 'task' })
      expect(leased.chargeKnown).toBe(false)
      const unknown = yield* reservePoolSlot({
        state: { ...state, slots: [leased] },
        slot,
      }).pipe(Effect.flip)
      expect(unknown.message).toContain('unknown')
      const remeasured = { ...leased, state: 'ready' as const, chargeKnown: true }
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
