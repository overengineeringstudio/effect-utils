import { dirname, join } from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Cause, Effect, Exit, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import { EffectPath } from '@overeng/effect-path'
import { Vitest } from '@overeng/utils-dev/node-vitest'

import { acquireDeletionLease, adoptPersistentDeletionLease } from './store-deletion-lease.ts'
import { captureDeletionIdentity, type DeletionIdentity } from './store-pinned-deletion.ts'
import { runPoolCommand } from './store-pool-install.ts'
import {
  beginPoolPreparation,
  finishPoolPreparation,
  markPoolRootAuthored,
  reserveFreshPoolRoot,
  requireDisposablePoolRoot,
  bindPoolPhysicalBirth,
  beginPoolClaim,
  finishPoolClaim,
  PoolError,
  type PoolActor,
  type PoolLifecycle,
  PoolOperation,
  PoolPhysicalBirth,
  PoolSlot,
  type PoolState,
  readPoolProvenance,
  requirePoolLease,
  requirePoolPhysicalBirth,
  requirePoolSlotSnapshot,
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
const metadataActor: PoolActor = {
  hostId: 'metadata-host',
  bootId: 'metadata-boot',
  pid: 1,
  startTime: 'metadata-start',
}
const metadataChain = (path: string): DeletionIdentity => {
  const parts = path.split('/').filter((part) => part !== '')
  return ['/', ...parts.map((_, index) => `/${parts.slice(0, index + 1).join('/')}`)].map(
    (path, index) => {
      const entry: DeletionIdentity[number] = {
        _tag: 'Inode',
        path,
        mountId: '1',
        dev: '1',
        ino: String(index + 1),
      }
      return entry
    },
  )
}
const metadataReadyFromFresh = (fresh: PoolSlot): PoolSlot => ({
  ...fresh,
  state: 'ready',
  generation: 1,
  identity: 'installed',
  chargeKnown: true,
  token: '',
  owner: '',
  barrierToken: 'metadata-barrier',
  physicalBirth: {
    bootId: metadataActor.bootId,
    root: metadataChain(fresh.path),
    gitAdmin: metadataChain(join(fresh.bare, 'worktrees', fresh.id)),
  },
  lifecycle: {
    birth: { generation: 1, actor: metadataActor, state: 'terminal', outcome: 'success' },
  },
})
const metadataId = '223e4567-e89b-42d3-a456-426614174000'
const metadataPath = join(dirname(slot.bare), 'pool', metadataId)
const readySlot = metadataReadyFromFresh({
  ...slot,
  id: metadataId,
  path: metadataPath,
  executionRoot: { origin: 'fresh-reserved-uuid', path: metadataPath, authored: false },
})

const withPoolTestCtx = Vitest.makeWithTestCtx({ makeLayer: () => NodeServices.layer })
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

describe('disposable physical pool provenance', () => {
  it.effect('only mints fresh UUID reservations, retaining legacy and rebound roots HOLD', (test) =>
    Effect.gen(function* () {
      const state = { version: 1 as const, maxSlots: 2, maxBytes: 128, slots: [] }
      const first = yield* reserveFreshPoolRoot({
        state,
        bare: slot.bare,
        commit: slot.commit,
        charge: 64,
      })
      const second = yield* reserveFreshPoolRoot({
        state: first.state,
        bare: slot.bare,
        commit: slot.commit,
        charge: 64,
      })
      expect(first.slot.id).not.toBe(second.slot.id)
      expect(second.state.slots).toHaveLength(2)
      yield* requireDisposablePoolRoot(first.slot)
      expect((yield* requireDisposablePoolRoot(slot).pipe(Effect.result))._tag).toBe('Failure')
      expect(
        (yield* requireDisposablePoolRoot({ ...first.slot, path: '/adopted' }).pipe(Effect.result))
          ._tag,
      ).toBe('Failure')
    }).pipe(withPoolTestCtx(test)),
  )

  it.effect(
    'persists irreversible HOLD before an authored/promoted physical root can be reset',
    (test) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const base = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const fresh = yield* withPoolState({
          base,
          limits: { maxSlots: 1, maxBytes: 64 },
          use: (state, save) =>
            Effect.gen(function* () {
              const reserved = yield* reserveFreshPoolRoot({
                state,
                bare: `${base}.bare`,
                commit: slot.commit,
                charge: 64,
              })
              yield* save(reserved.state)
              return reserved.slot
            }),
        })
        const before = yield* fs.readFileString(`${base}.state/pool/state.json`)
        expect(
          (yield* markPoolRootAuthored({ base, id: fresh.id, generation: 9 }).pipe(Effect.result))
            ._tag,
        ).toBe('Failure')
        expect(yield* fs.readFileString(`${base}.state/pool/state.json`)).toBe(before)
        yield* markPoolRootAuthored({ base, id: fresh.id, generation: fresh.generation })
        const authored = yield* withPoolState({
          base,
          use: (state) => Effect.succeed(state.slots[0]!),
        })
        expect(authored.executionRoot?.authored).toBe(true)
        expect(authored.state).toBe('quarantined')
        expect(authored.chargeKnown).toBe(false)
        expect((yield* requireDisposablePoolRoot(authored).pipe(Effect.result))._tag).toBe(
          'Failure',
        )
        yield* markPoolRootAuthored({ base, id: fresh.id, generation: fresh.generation })
        expect((yield* readPoolProvenance({ base })).authorizesRemoval).toBe(false)
      }).pipe(withPoolTestCtx(test)),
  )
})

// Synthetic metadata fixtures exercise data contracts only, never runtime authority.
const actor: PoolActor = { hostId: 'host', bootId: 'boot', pid: 1, startTime: '10' }
const active: PoolOperation = { generation: 1, actor, state: 'active' }
const terminal: PoolOperation = { ...active, state: 'terminal', outcome: 'success' }
const dataChain = (path: string): PoolPhysicalBirth['root'] =>
  [
    '/',
    ...path
      .split('/')
      .filter(Boolean)
      .map((_, index, parts) => `/${parts.slice(0, index + 1).join('/')}`),
  ].map((path, index) => ({
    _tag: 'Inode',
    path,
    dev: '1',
    ino: String(index + 1),
    mountId: '1',
  }))
const birth: PoolPhysicalBirth = {
  bootId: 'boot',
  root: dataChain(slot.path),
  gitAdmin: dataChain(`${slot.bare}/worktrees/slot`),
}
const intent: PoolSlot = {
  ...slot,
  state: 'preparing',
  identity: '',
  owner: '',
  chargeKnown: false,
}
const dataState = (expected: PoolSlot): PoolState => ({
  version: 1,
  maxSlots: 1,
  maxBytes: 64,
  slots: [expected],
})

describe('pool physical metadata (data-only fixtures)', () => {
  it.effect('roundtrips schemas and rejects incomplete or contradictory operation records', () =>
    Effect.gen(function* () {
      const lifecycle: PoolLifecycle = { birth: active, claim: terminal, retarget: active }
      const value = { ...intent, physicalBirth: birth, lifecycle }
      const json = yield* Schema.encodeEffect(Schema.fromJsonString(PoolSlot))(value)
      expect(yield* Schema.decodeEffect(Schema.fromJsonString(PoolSlot))(json)).toEqual(value)
      for (const invalid of [
        { ...active, outcome: 'success' },
        { ...terminal, outcome: undefined },
        { ...terminal, outcome: 'unknown' },
        { ...active, generation: -1 },
        { ...active, generation: Number.MAX_SAFE_INTEGER + 1 },
        { ...active, actor: { ...actor, pid: 0 } },
        { ...active, actor: { ...actor, pid: 1.5 } },
        { ...active, actor: { ...actor, hostId: '' } },
        { ...active, actor: { ...actor, bootId: '' } },
        { ...active, actor: { ...actor, startTime: '' } },
      ])
        expect(
          Exit.isFailure(
            yield* Schema.decodeUnknownEffect(PoolOperation)(invalid).pipe(Effect.exit),
          ),
        ).toBe(true)
      for (const invalid of [
        { ...birth, bootId: '' },
        { bootId: 'boot', root: birth.root },
      ])
        expect(
          Exit.isFailure(
            yield* Schema.decodeUnknownEffect(PoolPhysicalBirth)(invalid).pipe(Effect.exit),
          ),
        ).toBe(true)
    }),
  )

  it.effect('binds one immutable candidate only and fences every schema field', () =>
    Effect.gen(function* () {
      const state = dataState(intent)
      const before = encodeJson(state)
      const bound = yield* bindPoolPhysicalBirth({ state, expected: intent, birth })
      expect(bound).toEqual({ ...intent, physicalBirth: birth })
      expect(bound).not.toBe(intent)
      expect(encodeJson(state)).toBe(before)
      yield* requirePoolPhysicalBirth({ slot: bound, birth })
      const clone = yield* Schema.decodeEffect(Schema.fromJsonString(PoolSlot))(
        yield* Schema.encodeEffect(Schema.fromJsonString(PoolSlot))(bound),
      )
      expect(clone.physicalBirth).not.toBe(bound.physicalBirth)
      yield* requirePoolSlotSnapshot({ state: dataState(bound), expected: clone })
      const recorded = { ...bound, lifecycle: { birth: active } }
      for (const expected of [
        { ...recorded, physicalBirth: { ...birth, bootId: 'other' } },
        {
          ...recorded,
          lifecycle: { birth: { ...active, actor: { ...actor, startTime: 'other' } } },
        },
      ])
        expect(
          (yield* requirePoolSlotSnapshot({ state: dataState(recorded), expected }).pipe(
            Effect.flip,
          )).message,
        ).toContain('HOLD')
      const stale: ReadonlyArray<PoolSlot> = [
        { ...intent, path: '/other' },
        { ...intent, bare: '/other' },
        { ...intent, id: 'other' },
        { ...intent, commit: 'other' },
        { ...intent, identity: 'other' },
        { ...intent, generation: 2 },
        { ...intent, state: 'ready' },
        { ...intent, token: 'other' },
        { ...intent, owner: 'other' },
        { ...intent, barrierToken: 'other' },
        { ...intent, charge: 63 },
        { ...intent, chargeKnown: true },
        { ...intent, reason: 'other' },
        bound,
        { ...intent, lifecycle: { birth: active } },
      ]
      for (const expected of stale)
        expect(
          (yield* requirePoolSlotSnapshot({ state, expected }).pipe(Effect.flip)).message,
        ).toContain('HOLD')
      expect(
        (yield* bindPoolPhysicalBirth({ state: dataState(bound), expected: bound, birth }).pipe(
          Effect.flip,
        )).message,
      ).toContain('HOLD')
      for (const expected of [
        { ...intent, chargeKnown: undefined },
        { ...intent, token: '' },
        { ...intent, barrierToken: '' },
        { ...intent, owner: 'owner' },
        { ...intent, identity: 'installed' },
        { ...intent, state: 'ready' as const },
      ])
        expect(
          (yield* bindPoolPhysicalBirth({ state: dataState(expected), expected, birth }).pipe(
            Effect.flip,
          )).message,
        ).toContain('HOLD')
    }),
  )

  it.effect('holds missing, partial, overlay, wrong-path and replaced physical facts', () =>
    Effect.gen(function* () {
      const bound = { ...intent, physicalBirth: birth }
      expect(
        (yield* requirePoolPhysicalBirth({ slot: intent, birth }).pipe(Effect.flip)).message,
      ).toContain('HOLD')
      for (const changed of [
        { ...birth, bootId: 'next-boot' },
        { ...birth, root: [] },
        { ...birth, gitAdmin: [] },
        { ...birth, root: birth.root.slice(1) },
        { ...birth, root: dataChain('/source/pool/other') },
        { ...birth, gitAdmin: dataChain(`${slot.bare}/worktrees/nested/slot`) },
        { ...birth, root: birth.root.map((entry) => ({ ...entry, ino: '900' })) },
        { ...birth, gitAdmin: birth.gitAdmin.map((entry) => ({ ...entry, mountId: '900' })) },
        {
          ...birth,
          root: birth.root.map((entry) => ({
            _tag: 'OverlayDirectory' as const,
            path: entry.path,
            mountId: entry.mountId,
          })),
        },
      ]) {
        expect(
          (yield* requirePoolPhysicalBirth({ slot: bound, birth: changed }).pipe(Effect.flip))
            .message,
        ).toContain('HOLD')
      }
      for (const changed of [
        { ...birth, root: [] },
        { ...birth, root: birth.root.slice(1) },
        { ...birth, bootId: '' },
        { ...birth, gitAdmin: [] },
        { ...birth, gitAdmin: birth.gitAdmin.slice(1) },
        {
          ...birth,
          root: birth.root.map((entry) => ({
            _tag: 'OverlayDirectory' as const,
            path: entry.path,
            mountId: entry.mountId,
          })),
        },
        { ...birth, root: dataChain('/other') },
        { ...birth, gitAdmin: dataChain('/other/worktrees/slot') },
        { ...birth, gitAdmin: dataChain(`${slot.bare}/worktrees/nested/slot`) },
        {
          ...birth,
          gitAdmin: birth.gitAdmin.map((entry) => ({
            _tag: 'OverlayDirectory' as const,
            path: entry.path,
            mountId: entry.mountId,
          })),
        },
      ])
        expect(
          (yield* bindPoolPhysicalBirth({
            state: dataState(intent),
            expected: intent,
            birth: changed,
          }).pipe(Effect.flip)).message,
        ).toContain('HOLD')
    }),
  )

  it.effect(
    'persists facts and exposes only truthful terminal evidence without writes or tokens',
    (test) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const base = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const value: PoolSlot = {
          ...intent,
          token: 'secret-nonce',
          barrierToken: 'secret-barrier',
          physicalBirth: birth,
          lifecycle: {
            birth: active,
            claim: terminal,
            retarget: { ...terminal, outcome: 'failure' },
          },
        }
        yield* withPoolState({
          base,
          limits: { maxSlots: 1, maxBytes: 64 },
          use: (state, save) => save({ ...state, slots: [value] }),
        })
        const path = `${base}/.state/pool/state.json`
        const before = yield* fs.readFileString(path)
        expect(
          yield* withPoolState({ base, use: (state) => Effect.succeed(state.slots[0]) }),
        ).toEqual(value)
        const observation = (yield* readPoolProvenance({ base })).observations[0]!
        expect(observation.physicalBirth).toEqual({ _tag: 'Recorded', value: birth })
        expect(observation.lifecycle).toEqual({ _tag: 'Recorded', value: value.lifecycle })
        expect(observation.terminalBirth._tag).toBe('Missing')
        expect(observation.terminalClaim).toEqual({ _tag: 'Recorded', value: terminal })
        expect(observation.terminalRetarget).toEqual({
          _tag: 'Recorded',
          value: value.lifecycle?.retarget,
        })
        expect(observation.ownerActivity._tag).toBe('Missing')
        expect(observation.seatActivity._tag).toBe('Missing')
        expect(observation.disposition).toBe('HOLD')
        expect(observation.authorizesRemoval).toBe(false)
        expect(encodeJson(observation)).not.toContain('secret-')
        expect(yield* fs.readFileString(path)).toBe(before)
        const next = { ...value, lifecycle: { birth: terminal, claim: terminal, retarget: active } }
        yield* withPoolState({ base, use: (state, save) => save({ ...state, slots: [next] }) })
        const retargeting = (yield* readPoolProvenance({ base })).observations[0]!
        expect(retargeting.terminalBirth).toEqual({ _tag: 'Recorded', value: terminal })
        expect(retargeting.terminalClaim).toEqual({ _tag: 'Recorded', value: terminal })
        expect(retargeting.terminalRetarget._tag).toBe('Missing')
        const malformed = encodeJson({
          ...dataState(value),
          slots: [{ ...value, lifecycle: { birth: { ...active, outcome: 'success' } } }],
        })
        yield* fs.writeFileString(path, malformed)
        expect(Exit.isFailure(yield* readPoolProvenance({ base }).pipe(Effect.exit))).toBe(true)
        expect(yield* fs.readFileString(path)).toBe(malformed)
      }).pipe(withPoolTestCtx(test)),
  )
})

describe.skipIf(process.platform !== 'linux')('pool physical birth native comparisons', () => {
  it.effect(
    'refuses real root and Git-admin inode replacement using the existing pin engine',
    (test) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const base = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ directory: '/dev/shm' }),
        )
        const expected: PoolSlot = { ...intent, path: `${base}/pool/slot`, bare: `${base}/.bare` }
        const admin = `${expected.bare}/worktrees/slot`
        for (const path of [expected.path, admin])
          yield* fs.makeDirectory(path, { recursive: true })
        const capture = Effect.gen(function* () {
          return {
            bootId: (yield* fs.readFileString('/proc/sys/kernel/random/boot_id')).trim(),
            root: yield* captureDeletionIdentity({ rootPath: '/', path: expected.path }),
            gitAdmin: yield* captureDeletionIdentity({ rootPath: '/', path: admin }),
          }
        })
        const actual = yield* capture
        expect(actual.root.at(-1)?._tag).toBe('Inode')
        expect(actual.gitAdmin.at(-1)?._tag).toBe('Inode')
        const bound = yield* bindPoolPhysicalBirth({
          state: dataState(expected),
          expected,
          birth: actual,
        })
        yield* requirePoolPhysicalBirth({ slot: bound, birth: yield* capture })
        yield* fs.rename(expected.path, `${expected.path}-old`)
        yield* fs.makeDirectory(expected.path)
        expect(
          (yield* requirePoolPhysicalBirth({ slot: bound, birth: yield* capture }).pipe(
            Effect.flip,
          )).message,
        ).toContain('HOLD')
        yield* fs.remove(expected.path)
        yield* fs.rename(`${expected.path}-old`, expected.path)
        yield* fs.rename(admin, `${admin}-old`)
        yield* fs.makeDirectory(admin)
        expect(
          (yield* requirePoolPhysicalBirth({ slot: bound, birth: yield* capture }).pipe(
            Effect.flip,
          )).message,
        ).toContain('HOLD')
      }).pipe(withPoolTestCtx(test)),
  )
})

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

  it.effect(
    'persists unknown intent before a root exists without replacing its persistent barrier',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const base = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const root = `${base}not-created`
        const lease = yield* acquireDeletionLease({
          storeBasePath: base,
          ownerPath: root,
          now: Date.now(),
          persistent: true,
        })
        const barrier = yield* fs.readFileString(lease.leasePath)
        yield* withPoolState({
          base,
          limits: { maxSlots: 2, maxBytes: 128 },
          use: (state, save) =>
            save({
              ...state,
              slots: [
                {
                  ...slot,
                  path: root,
                  identity: '',
                  token: '',
                  owner: '',
                  state: 'preparing',
                  barrierToken: lease.token,
                },
              ],
            }),
        })
        const intent = yield* withPoolState({
          base,
          use: (state, save) =>
            beginPoolPreparation({
              state,
              id: slot.id,
              generation: slot.generation,
              path: root,
            }).pipe(Effect.tap((next) => save({ ...state, slots: [next] }))),
        })
        expect(yield* fs.exists(root)).toBe(false)
        expect(yield* fs.readFileString(lease.leasePath)).toBe(barrier)
        expect(intent.generation).toBe(slot.generation + 1)
        expect(intent.token).not.toBe('')
        expect(intent.chargeKnown).toBe(false)
        const loaded = yield* withPoolState({ base, use: (state) => Effect.succeed(state) })
        expect(loaded.slots).toEqual([intent])
        expect(
          (yield* reservePoolSlot({
            state: loaded,
            slot: { ...slot, id: 'other' },
          }).pipe(Effect.flip)).message,
        ).toContain('unknown')
        expect(
          (yield* finishPoolPreparation({
            state: loaded,
            intent,
            prepared: { identity: 'candidate', charge: 0 },
          }).pipe(Effect.flip)).message,
        ).toContain('limits')
        expect(
          yield* withPoolState({
            base,
            use: (state) => Effect.succeed(state.slots),
          }),
        ).toEqual([intent])
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
        use: (state, save) =>
          Effect.gen(function* () {
            const intent = yield* beginPoolClaim({
              slot: state.slots[0]!,
              identity: 'installed',
              owner: 'task',
            })
            yield* save({ ...state, slots: [intent] })
            return intent
          }),
      }).pipe(
        Effect.flatMap((intent) =>
          withPoolState({
            base,
            use: (state, save) =>
              finishPoolClaim({ state, intent, identity: 'installed', owner: 'task', actor }).pipe(
                Effect.tap((next) => save({ ...state, slots: [next] })),
              ),
          }),
        ),
        Effect.exit,
      )
      const results = yield* Effect.all([claim, claim], { concurrency: 2 })
      expect(results.filter(Exit.isSuccess)).toHaveLength(1)
      const claimed = yield* withPoolState({ base, use: (state) => Effect.succeed(state.slots[0]) })
      expect(claimed?.generation).toBe(2)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )
  it.effect(
    'reserves distinct metadata records without physical execution or fabricated ROOT acquisition',
    (test) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const base = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const firstReservation = yield* reserveFreshPoolRoot({
          state: { version: 1, maxSlots: 2, maxBytes: 128, slots: [] },
          bare: `${base}.bare`,
          commit: slot.commit,
          charge: 64,
        })
        const secondReservation = yield* reserveFreshPoolRoot({
          state: firstReservation.state,
          bare: `${base}.bare`,
          commit: slot.commit,
          charge: 64,
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
          use: (state, save) =>
            Effect.gen(function* () {
              const selected = state.slots.find((candidate) => candidate.state === 'ready')
              if (selected === undefined)
                return yield* new PoolError({ message: 'No ready metadata candidate; HOLD' })
              const intent = yield* beginPoolClaim({
                slot: selected,
                identity: 'installed',
                owner: 'task',
              })
              yield* save({
                ...state,
                slots: state.slots.map((candidate) =>
                  candidate.id === intent.id ? intent : candidate,
                ),
              })
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
          expect(
            yield* requirePoolLease({
              slot: intent,
              token: intent.token,
              generation: intent.generation,
            }).pipe(Effect.exit),
          ).toSatisfy(Exit.isFailure)
        }
        const persisted = yield* withPoolState({ base, use: (state) => Effect.succeed(state) })
        expect(persisted.slots).toEqual([a, b])
        expect(
          yield* reservePoolSlot({
            state: persisted,
            slot: { ...readySlot, id: 'third', path: `${base}pool/third` },
          }).pipe(Effect.flip),
        ).toMatchObject({ message: expect.stringContaining('unknown') })
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

  it.effect(
    'accepts only the exact reserved snapshot without minting a second generation or token',
    () =>
      Effect.gen(function* () {
        const intent = yield* beginPoolClaim({
          slot: readySlot,
          identity: 'installed',
          owner: 'task',
        })
        const state: PoolState = { version: 1, maxSlots: 1, maxBytes: 64, slots: [intent] }
        const accepted = yield* finishPoolClaim({
          state,
          intent,
          identity: 'installed',
          owner: 'task',
          actor,
        })
        expect(accepted).toEqual({
          ...intent,
          state: 'leased',
          lifecycle: {
            ...intent.lifecycle,
            claim: { generation: intent.generation, actor, state: 'active' },
          },
        })
        expect(intent.state).toBe('claiming')
        yield* requirePoolLease({
          slot: accepted,
          token: intent.token,
          generation: intent.generation,
        })
        for (const delta of [
          { token: 'different' },
          { generation: intent.generation + 1 },
          { owner: 'different' },
          { identity: 'different' },
          { state: 'quarantined' as const },
          { barrierToken: 'different' },
          { commit: 'b'.repeat(40) },
        ]) {
          expect(
            yield* finishPoolClaim({
              state: { ...state, slots: [{ ...intent, ...delta }] },
              intent,
              identity: 'installed',
              owner: 'task',
              actor,
            }).pipe(Effect.exit),
          ).toSatisfy(Exit.isFailure)
        }
        for (const request of [
          { identity: 'different', owner: 'task' },
          { identity: 'installed', owner: 'different' },
          { identity: 'installed', owner: '' },
        ]) {
          expect(
            yield* finishPoolClaim({ state, intent, ...request, actor }).pipe(Effect.exit),
          ).toSatisfy(Exit.isFailure)
        }
        for (const invalid of [readySlot, { ...intent, token: '' }]) {
          expect(
            yield* finishPoolClaim({
              state: { ...state, slots: [invalid] },
              intent: invalid,
              identity: 'installed',
              owner: 'task',
              actor,
            }).pipe(Effect.exit),
          ).toSatisfy(Exit.isFailure)
        }
      }),
  )

  it.effect(
    'records a new process leader without confusing the creator or owner label with seat authority',
    () =>
      Effect.gen(function* () {
        const intent = yield* beginPoolClaim({
          slot: readySlot,
          identity: 'installed',
          owner: 'metadata-task-label',
        })
        const state: PoolState = { version: 1, maxSlots: 1, maxBytes: 64, slots: [intent] }
        const nextActor: PoolActor = { ...actor, pid: 2, startTime: 'next-metadata-generation' }
        const accepted = yield* finishPoolClaim({
          state,
          intent,
          identity: 'installed',
          owner: 'metadata-task-label',
          actor: nextActor,
        })
        expect(accepted.lifecycle?.claim).toEqual({
          generation: intent.generation,
          actor: nextActor,
          state: 'active',
        })
        expect(accepted.lifecycle?.birth).toEqual(intent.lifecycle?.birth)
        expect(accepted.physicalBirth).toEqual(intent.physicalBirth)
        expect(accepted.barrierToken).toBe(intent.barrierToken)
        expect(accepted.charge).toBe(intent.charge)
        expect(accepted.chargeKnown).toBe(false)
        expect(intent.lifecycle?.claim).toBeUndefined()
        for (const invalid of [
          { ...actor, pid: 0 },
          { ...actor, pid: 1.5 },
          { ...actor, startTime: '' },
          { ...actor, hostId: 'other-host' },
          { ...actor, bootId: 'other-boot' },
        ])
          expect(
            yield* finishPoolClaim({
              state,
              intent,
              identity: 'installed',
              owner: 'metadata-task-label',
              actor: invalid,
            }).pipe(Effect.exit),
          ).toSatisfy(Exit.isFailure)
      }),
  )

  it.effect('holds unknown birth, active prior operations and malformed saved claim phases', () =>
    Effect.gen(function* () {
      const intent = yield* beginPoolClaim({
        slot: readySlot,
        identity: 'installed',
        owner: 'task',
      })
      const birth = intent.physicalBirth
      if (birth === undefined)
        return yield* Effect.die('Metadata fixture omitted recorded physical birth')
      const candidates: PoolSlot[] = [
        { ...intent, physicalBirth: undefined },
        { ...intent, lifecycle: {} },
        { ...intent, chargeKnown: true },
        {
          ...intent,
          lifecycle: { ...intent.lifecycle, birth: { generation: 1, actor, state: 'active' } },
        },
        {
          ...intent,
          lifecycle: {
            ...intent.lifecycle,
            claim: { generation: intent.generation, actor, state: 'active' },
          },
        },
        {
          ...intent,
          lifecycle: { ...intent.lifecycle, retarget: { generation: 1, actor, state: 'active' } },
        },
        { ...intent, physicalBirth: { ...birth, bootId: 'other-boot' } },
      ]
      for (const invalid of candidates) {
        const state: PoolState = { version: 1, maxSlots: 1, maxBytes: 64, slots: [invalid] }
        expect(
          yield* finishPoolClaim({
            state,
            intent: invalid,
            identity: 'installed',
            owner: 'task',
            actor,
          }).pipe(Effect.exit),
        ).toSatisfy(Exit.isFailure)
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
        { ...readySlot, generation: -1 },
        { ...readySlot, generation: 0.5 },
        { ...readySlot, generation: Number.NaN },
        { ...readySlot, generation: Number.POSITIVE_INFINITY },
        { ...readySlot, generation: Number.MAX_SAFE_INTEGER },
      ]
      for (const candidate of candidates) {
        expect(
          yield* beginPoolClaim({
            slot: candidate,
            identity: 'installed',
            owner: 'task',
          }).pipe(Effect.exit),
        ).toSatisfy(Exit.isFailure)
      }
      expect(
        yield* beginPoolClaim({
          slot: readySlot,
          identity: 'installed',
          owner: '',
        }).pipe(Effect.exit),
      ).toSatisfy(Exit.isFailure)
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
      const held = yield* finishPoolClaim({
        state: { ...state, slots: [intent] },
        intent,
        identity: 'installed',
        owner: 'task',
        actor,
      })
      expect(held.chargeKnown).toBe(false)
      const unknown = yield* reservePoolSlot({
        state: { ...state, slots: [held] },
        slot,
      }).pipe(Effect.flip)
      expect(unknown.message).toContain('unknown')
      const remeasured = {
        ...held,
        state: 'ready' as const,
        chargeKnown: true,
        token: '',
        owner: '',
      }
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
