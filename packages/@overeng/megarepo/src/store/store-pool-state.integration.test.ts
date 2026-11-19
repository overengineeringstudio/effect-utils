import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Exit, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import { EffectPath } from '@overeng/effect-path'

import { acquireDeletionLease, adoptPersistentDeletionLease } from './store-deletion-lease.ts'
import {
  beginPoolRetarget,
  claimPoolGeneration,
  consumePoolReservation,
  finishPoolRetarget,
  type PoolSlot,
  requirePoolLease,
  reservePoolGeneration,
  reservePoolSlot,
  withPoolState,
} from './store-pool-state.ts'
import { inspectPool } from './store-pool.ts'

const historicalSlot = {
  id: 'slot',
  path: '/source/pool/slot',
  bare: '/source/.bare',
  commit: 'a'.repeat(40),
  identity: 'installed',
  charge: 64,
  generation: 1,
  state: 'leased' as const,
  token: 'claim',
  barrierToken: 'barrier',
  owner: 'task',
  reason: '',
  chargeKnown: true,
}
const slot: PoolSlot = { ...historicalSlot, sourceHistory: [historicalSlot.commit] }

describe('pool authoritative lifecycle', () => {
  it.effect('persists an unborn bounded reservation unchanged across actual inspection', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const base = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
      const reserved = yield* withPoolState({
        base,
        limits: { maxSlots: 1, maxBytes: 64 },
        use: (state, save) =>
          reservePoolGeneration({ state, bare: `${base}.bare`, commit: slot.commit, charge: 64 })
            .pipe(Effect.tap(save)),
      })
      const unborn = reserved.slots[0]!
      expect(unborn.state).toBe('reserved')
      expect(unborn.reservation).toMatch(/^[0-9a-f-]{36}$/u)
      expect(unborn.owner).toBe('')
      expect(yield* fs.exists(unborn.path)).toBe(false)
      expect((yield* inspectPool(base)).slots[0]).toEqual(unborn)
      const reopened = yield* withPoolState({ base, use: Effect.succeed })
      expect(reopened.slots[0]).toEqual(unborn)
      const full = yield* reservePoolGeneration({
        state: reopened, bare: `${base}other.git`, commit: slot.commit, charge: 1,
      }).pipe(Effect.flip)
      expect(full.message).toContain('capacity')
      const bytes = yield* fs.readFileString(`${base}.state/pool/state.json`)
      const invalid = yield* withPoolState({
        base,
        use: (state, save) => save({
          ...state, slots: [{ ...unborn, reservation: undefined }],
        }),
      }).pipe(Effect.exit)
      expect(Exit.isFailure(invalid)).toBe(true)
      expect(yield* fs.readFileString(`${base}.state/pool/state.json`)).toBe(bytes)
      const incompatible = { ...reopened, futureProof: true }
      const unknownWriter = yield* withPoolState({
        base, use: (_state, save) => save(incompatible),
      }).pipe(Effect.exit)
      expect(Exit.isFailure(unknownWriter)).toBe(true)
      expect(yield* fs.readFileString(`${base}.state/pool/state.json`)).toBe(bytes)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('consumes one exact reservation epoch atomically and never resumes preparation', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const base = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
      const state = yield* withPoolState({
        base,
        limits: { maxSlots: 2, maxBytes: 128 },
        use: (state, save) =>
          reservePoolGeneration({ state, bare: `${base}.bare`, commit: slot.commit, charge: 64 })
            .pipe(Effect.tap(save)),
      })
      const reserved = state.slots[0]!
      const receipt = {
        id: reserved.id, reservation: reserved.reservation!, generation: reserved.generation,
        bare: reserved.bare, commit: reserved.commit, charge: reserved.charge,
      }
      for (const mismatch of [
        { id: 'other' }, { reservation: 'stale' }, { generation: 1 },
        { bare: `${base}other.git` }, { commit: 'b'.repeat(40) }, { charge: 65 },
      ]) {
        const rejected = yield* consumePoolReservation({
          slot: reserved, ...receipt, ...mismatch,
        }).pipe(Effect.exit)
        expect(Exit.isFailure(rejected)).toBe(true)
      }
      const consume = withPoolState({
        base,
        use: (state, save) => consumePoolReservation({ slot: state.slots[0]!, ...receipt })
          .pipe(Effect.tap((next) => save({ ...state, slots: [next] }))),
      }).pipe(Effect.exit)
      const results = yield* Effect.all([consume, consume], { concurrency: 2 })
      expect(results.filter(Exit.isSuccess)).toHaveLength(1)
      const prepared = yield* withPoolState({ base, use: (state) => Effect.succeed(state.slots[0]!) })
      expect(prepared).toMatchObject({
        state: 'preparing', generation: 1, chargeKnown: false, reservation: undefined,
      })
      const retained = yield* inspectPool(base)
      expect(retained.slots[0]).toMatchObject({ state: 'quarantined', chargeKnown: false })
      expect(Exit.isFailure(yield* consumePoolReservation({
        slot: retained.slots[0]!, ...receipt,
      }).pipe(Effect.exit))).toBe(true)
      expect((yield* reservePoolGeneration({
        state: retained, bare: `${base}other.git`, commit: slot.commit, charge: 64,
      }).pipe(Effect.flip)).message).toContain('unknown')
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('quarantines unexpected reservation paths without adopting or deleting their bytes', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const base = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
      const state = yield* withPoolState({
        base,
        limits: { maxSlots: 1, maxBytes: 64 },
        use: (state, save) =>
          reservePoolGeneration({ state, bare: `${base}.bare`, commit: slot.commit, charge: 64 })
            .pipe(Effect.tap(save)),
      })
      const reserved = state.slots[0]!
      yield* fs.makeDirectory(reserved.path, { recursive: true })
      yield* fs.writeFileString(`${reserved.path}/unowned`, 'retain')
      const inspected = yield* inspectPool(base)
      expect(inspected.slots[0]).toMatchObject({
        id: reserved.id, state: 'quarantined', chargeKnown: false, reservation: undefined,
      })
      expect(yield* fs.readFileString(`${reserved.path}/unowned`)).toBe('retain')
      const reopened = yield* withPoolState({ base, use: Effect.succeed })
      expect(reopened).toEqual(inspected)
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
      const state = { version: 2 as const, maxSlots: 10, maxBytes: 100, slots: [ready] }
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

  it.effect('converts every historical lifecycle and unknown charge without dropping fences', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const base = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
      const states = ['preparing', 'ready', 'leased', 'completed', 'quarantined'] as const
      const records = states.flatMap((state) =>
        [undefined, false, true].map((chargeKnown, index) => ({
          ...historicalSlot,
          id: `${state}-${index}`,
          path: `/source/pool/${state}-${index}`,
          state,
          chargeKnown,
        })),
      )
      yield* fs.makeDirectory(`${base}.state/pool`, { recursive: true })
      yield* fs.writeFileString(
        `${base}.state/pool/state.json`,
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          version: 1,
          maxSlots: 16,
          maxBytes: 1024,
          slots: records,
        }),
      )
      const converted = yield* withPoolState({ base, use: (state) => Effect.succeed(state) })
      expect(converted.version).toBe(2)
      expect(converted.slots).toEqual(
        records.map((record) => ({ ...record, sourceHistory: [record.commit] })),
      )
      expect(yield* withPoolState({ base, use: (state) => Effect.succeed(state) })).toEqual(converted)
      const bytes = yield* fs.readFileString(`${base}.state/pool/state.json`)
      expect(bytes).toContain('"version":2')
      expect(
        yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Struct({ version: Schema.Literal(1) })),
        )(bytes).pipe(Effect.exit),
      ).toSatisfy(Exit.isFailure)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('fences retarget intent epochs and retains failed unknown preparation', () =>
    Effect.gen(function* () {
      const ready = { ...slot, state: 'ready' as const }
      const begin = {
        slot: ready,
        generation: ready.generation,
        identity: ready.identity,
        commit: 'b'.repeat(40),
        owner: 'retarget-task',
      }
      for (const state of ['leased', 'completed', 'preparing', 'quarantined'] as const)
        expect(
          yield* beginPoolRetarget({ ...begin, slot: { ...ready, state } }).pipe(Effect.exit),
        ).toSatisfy(Exit.isFailure)
      for (const chargeKnown of [false, undefined])
        expect(
          yield* beginPoolRetarget({ ...begin, slot: { ...ready, chargeKnown } }).pipe(Effect.exit),
        ).toSatisfy(Exit.isFailure)
      expect(
        yield* beginPoolRetarget({ ...begin, generation: 0 }).pipe(Effect.exit),
      ).toSatisfy(Exit.isFailure)
      const intent = yield* beginPoolRetarget(begin)
      expect(intent).toMatchObject({
        state: 'preparing',
        identity: '',
        token: '',
        chargeKnown: false,
        generation: 2,
        barrierToken: slot.barrierToken,
      })
      expect(intent.sourceHistory).toEqual([slot.commit, begin.commit])
      expect(
        yield* requirePoolLease({ slot: intent, token: slot.token, generation: 1 }).pipe(Effect.exit),
      ).toSatisfy(Exit.isFailure)
      const finish = {
        slot: intent,
        generation: intent.generation,
        token: intent.retarget!.token,
        result: { _tag: 'Prepared' as const, identity: 'new-install', charge: 96 },
      }
      for (const stale of [{ generation: 1 }, { token: 'stale' }])
        expect(yield* finishPoolRetarget({ ...finish, ...stale }).pipe(Effect.exit)).toSatisfy(
          Exit.isFailure,
        )
      const failed = yield* finishPoolRetarget({
        ...finish,
        result: { _tag: 'Failed', reason: 'doctor failed' },
      })
      expect(failed).toMatchObject({ state: 'quarantined', chargeKnown: false, identity: '' })
      expect(failed.retarget).toEqual(intent.retarget)
      expect(
        yield* finishPoolRetarget({ ...finish, slot: failed }).pipe(Effect.exit),
      ).toSatisfy(Exit.isFailure)
      const prepared = yield* finishPoolRetarget(finish)
      expect(prepared).toMatchObject({
        state: 'ready',
        chargeKnown: true,
        identity: 'new-install',
        charge: 96,
        generation: 2,
      })
      expect(prepared.retarget).toBeUndefined()
      const next = yield* beginPoolRetarget({
        ...begin,
        slot: prepared,
        generation: 2,
        identity: 'new-install',
        commit: 'c'.repeat(40),
      })
      expect(next.generation).toBe(3)
      expect(next.sourceHistory).toEqual([slot.commit, begin.commit, 'c'.repeat(40)])
    }),
  )

  it.effect('durably retains a failed retarget intent and its unknown charge after reopening', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const base = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
      yield* withPoolState({
        base,
        limits: { maxSlots: 1, maxBytes: 64 },
        use: (state, save) => save({ ...state, slots: [{ ...slot, state: 'ready' }] }),
      })
      const retained = yield* withPoolState({
        base,
        use: (state, save) =>
          Effect.gen(function* () {
            const intent = yield* beginPoolRetarget({
              slot: state.slots[0]!,
              generation: 1,
              identity: slot.identity,
              commit: 'b'.repeat(40),
              owner: 'retarget-task',
            })
            yield* save({ ...state, slots: [intent] })
            const failed = yield* finishPoolRetarget({
              slot: intent,
              generation: intent.generation,
              token: intent.retarget!.token,
              result: { _tag: 'Failed', reason: 'preparation interrupted' },
            })
            yield* save({ ...state, slots: [failed] })
            return failed
          }),
      })
      const reopened = yield* withPoolState({ base, use: (state) => Effect.succeed(state) })
      expect(reopened.slots).toEqual([retained])
      const blocked = yield* withPoolState({
        base,
        use: (state) => reservePoolSlot({ state, slot: { ...slot, id: 'other' } }),
      }).pipe(Effect.flip)
      expect(blocked.message).toContain('unknown')
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('retains unknown fences and rejects inconsistent writes before replacing authority', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const base = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
      const path = `${base}.state/pool/state.json`
      yield* fs.makeDirectory(`${base}.state/pool`, { recursive: true })
      for (const version of [1, 2]) {
        const oldSlot = version === 1 ? historicalSlot : slot
        const bytes = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          version,
          maxSlots: 1,
          maxBytes: 64,
          slots: [{ ...oldSlot, unknownFence: 'retained' }],
        })
        yield* fs.writeFileString(path, bytes)
        expect(
          yield* withPoolState({ base, use: () => Effect.void }).pipe(Effect.exit),
        ).toSatisfy(Exit.isFailure)
        expect(yield* fs.readFileString(path)).toBe(bytes)
      }
      const bytes = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        version: 2,
        maxSlots: 1,
        maxBytes: 64,
        slots: [slot],
      })
      yield* fs.writeFileString(path, bytes)
      const commit = 'b'.repeat(40)
      const invalid: PoolSlot = {
        ...slot,
        commit,
        sourceHistory: [slot.commit, commit],
        state: 'preparing',
        generation: 2,
        token: '',
        identity: '',
        chargeKnown: true,
        retarget: { from: slot.commit, to: commit, token: 'intent' },
      }
      expect(
        yield* withPoolState({
          base,
          use: (state, save) => save({ ...state, slots: [invalid] }),
        }).pipe(Effect.exit),
      ).toSatisfy(Exit.isFailure)
      expect(yield* fs.readFileString(path)).toBe(bytes)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )
})
