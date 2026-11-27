import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { expect } from 'vitest'

import { type DeletionIdentity } from './store-pinned-deletion.ts'
import { beginPoolReset, beginPoolRetarget, completePoolUse, finishPoolRetarget } from './store-pool-retarget.ts'
import { beginPoolClaim, finishPoolClaim, type PoolActor, type PoolSlot, type PoolState, reserveFreshPoolRoot } from './store-pool-state.ts'

// Synthetic recorded metadata only: neither these chains/actors nor candidates prove native/process/seat ownership.
const actor: PoolActor = { hostId: 'metadata-host', bootId: 'metadata-boot', pid: 1, startTime: 'metadata-start' }
const commit = 'a'.repeat(40)
const target = 'b'.repeat(64)
const metadataChain = (path: string): DeletionIdentity => {
  const parts = path.split('/').filter((part) => part !== '')
  return ['/', ...parts.map((_, index) => `/${parts.slice(0, index + 1).join('/')}`)].map((path, index) => {
    const entry: DeletionIdentity[number] = { _tag: 'Inode', path, mountId: '1', dev: '1', ino: String(index + 1) }
    return entry
  })
}
const readyFixture = Effect.gen(function* () {
  const reserved = yield* reserveFreshPoolRoot({
    state: { version: 1, maxSlots: 1, maxBytes: 128, slots: [] }, bare: '/metadata/.bare', commit, charge: 64,
  })
  const slot: PoolSlot = {
    ...reserved.slot, generation: 1, state: 'ready', identity: 'recorded-source-history', barrierToken: 'metadata-barrier',
    physicalBirth: { bootId: actor.bootId, root: metadataChain(reserved.slot.path),
      gitAdmin: metadataChain(`${reserved.slot.bare}/worktrees/${reserved.slot.id}`) },
    lifecycle: { birth: { generation: 1, actor, state: 'terminal', outcome: 'success' } },
  }
  const state: PoolState = { ...reserved.state, slots: [slot] }
  return { slot, state }
})
const leasedFixture = Effect.gen(function* () {
  const ready = yield* readyFixture
  const intent = yield* beginPoolClaim({ slot: ready.slot, identity: ready.slot.identity, owner: 'metadata-task' })
  const slot = yield* finishPoolClaim({ state: { ...ready.state, slots: [intent] }, intent,
    identity: ready.slot.identity, owner: 'metadata-task', actor })
  return { slot, state: { ...ready.state, slots: [slot] } }
})
const completedFixture = Effect.gen(function* () {
  const leased = yield* leasedFixture
  const slot = yield* completePoolUse({ state: leased.state, expected: leased.slot, token: leased.slot.token, outcome: 'success' })
  return { slot, state: { ...leased.state, slots: [slot] } }
})

describe('pure pool completion and retarget candidates, not physical authority', () => {
  it.effect('records either task outcome without clearing the claim fence, charge uncertainty or original state', () => Effect.gen(function* () {
    for (const outcome of ['success', 'failure'] as const) {
      const { slot, state } = yield* leasedFixture
      const before = JSON.stringify(state)
      const completed = yield* completePoolUse({ state, expected: slot, token: slot.token, outcome })
      expect(completed).toEqual({ ...slot, state: 'completed', lifecycle: {
        ...slot.lifecycle, claim: { generation: 2, actor, state: 'terminal', outcome },
      } })
      expect(completed.chargeKnown).toBe(false)
      expect(completed.token).toBe(slot.token)
      expect(JSON.stringify(state)).toBe(before)
      const reset = yield* beginPoolReset({ state: { ...state, slots: [completed] }, expected: completed, token: slot.token, actor, commit: target })
      expect(reset.lifecycle?.claim).toEqual(completed.lifecycle?.claim)
      expect(reset.barrierToken).toBe(slot.barrierToken)
    }
  }))

  it.effect('refuses stale completion snapshots, wrong tokens and non-leased phases', () => Effect.gen(function* () {
    const { slot, state } = yield* leasedFixture
    const candidates: PoolSlot[] = [
      { ...slot, generation: slot.generation + 1 }, { ...slot, owner: 'other-task' }, { ...slot, state: 'completed' },
      { ...slot, identity: 'changed-history' }, { ...slot, lifecycle: {} },
    ]
    for (const expected of candidates)
      expect((yield* completePoolUse({ state, expected, token: slot.token, outcome: 'success' }).pipe(Effect.result))._tag).toBe('Failure')
    expect((yield* completePoolUse({ state, expected: slot, token: 'wrong', outcome: 'success' }).pipe(Effect.result))._tag).toBe('Failure')
    const ready = yield* readyFixture
    expect((yield* completePoolUse({ state: ready.state, expected: ready.slot, token: '', outcome: 'success' }).pipe(Effect.result))._tag).toBe('Failure')
  }))

  it.effect('refuses active historical retargets and cross-boot claim metadata even when the snapshot matches', () => Effect.gen(function* () {
    const fixture = yield* leasedFixture
    const candidates: PoolSlot[] = [
      { ...fixture.slot, lifecycle: { ...fixture.slot.lifecycle, retarget: { generation: 1, actor, state: 'active' } } },
      { ...fixture.slot, lifecycle: { ...fixture.slot.lifecycle, claim: {
        generation: 2, actor: { ...actor, bootId: 'other-boot' }, state: 'active',
      } } },
    ]
    for (const slot of candidates)
      expect((yield* completePoolUse({ state: { ...fixture.state, slots: [slot] }, expected: slot, token: slot.token, outcome: 'success' })
        .pipe(Effect.result))._tag).toBe('Failure')
  }))

  it.effect('starts completed reset with a fresh generation and nonce, retaining old identity, bytes and terminal claim', () => Effect.gen(function* () {
    const { slot, state } = yield* completedFixture
    const intent = yield* beginPoolReset({ state, expected: slot, token: slot.token, actor, commit: target })
    expect(intent.state).toBe('preparing')
    expect(intent.generation).toBe(3)
    expect(intent.token).not.toBe(slot.token)
    expect(intent.token).not.toBe('')
    expect(intent.owner).toBe('')
    expect(intent.commit).toBe(target)
    expect(intent.identity).toBe(slot.identity)
    expect(intent.charge).toBe(slot.charge)
    expect(intent.chargeKnown).toBe(false)
    expect(intent.physicalBirth).toEqual(slot.physicalBirth)
    expect(intent.barrierToken).toBe(slot.barrierToken)
    expect(intent.lifecycle?.claim).toEqual(slot.lifecycle?.claim)
    expect(intent.lifecycle?.retarget).toEqual({ generation: 3, actor, state: 'active' })
    expect(state.slots[0]).toEqual(slot)
  }))

  it.effect('retargets an idle slot without manufacturing a claim or assigning known accounting', () => Effect.gen(function* () {
    const { slot, state } = yield* readyFixture
    const intent = yield* beginPoolRetarget({ state, expected: slot, actor, commit: target })
    expect(intent.lifecycle?.claim).toBeUndefined()
    expect(intent.generation).toBe(2)
    expect(intent.state).toBe('preparing')
    expect(intent.chargeKnown).toBe(false)
    expect(intent.identity).toBe(slot.identity)
    expect(intent.lifecycle?.retarget).toEqual({ generation: 2, actor, state: 'active' })
    expect((yield* beginPoolReset({ state, expected: slot, token: '', actor, commit: target }).pipe(Effect.result))._tag).toBe('Failure')
  }))

  it.effect('refuses malformed targets, invalid or foreign actors and exhausted generations', () => Effect.gen(function* () {
    const fixture = yield* readyFixture
    for (const invalid of ['', 'main', 'A'.repeat(40), 'a'.repeat(41)])
      expect((yield* beginPoolRetarget({ state: fixture.state, expected: fixture.slot, actor, commit: invalid })
        .pipe(Effect.result))._tag).toBe('Failure')
    for (const invalid of [{ ...actor, pid: 0 }, { ...actor, hostId: 'other-host' }, { ...actor, bootId: 'other-boot' }])
      expect((yield* beginPoolRetarget({ state: fixture.state, expected: fixture.slot, actor: invalid, commit: target })
        .pipe(Effect.result))._tag).toBe('Failure')
    for (const generation of [Number.MAX_SAFE_INTEGER, 1.5, -1]) {
      const slot: PoolSlot = { ...fixture.slot, generation }
      expect((yield* beginPoolRetarget({ state: { ...fixture.state, slots: [slot] }, expected: slot, actor, commit: target })
        .pipe(Effect.result))._tag).toBe('Failure')
    }
  }))

  it.effect('never resets or retargets a promoted, unknown or rebound physical root', () => Effect.gen(function* () {
    const fixture = yield* completedFixture
    const origin = fixture.slot.executionRoot
    if (origin === undefined) return yield* Effect.die('Fresh producer omitted its disposable-root origin')
    const candidates: PoolSlot[] = [
      { ...fixture.slot, executionRoot: { ...origin, authored: true } },
      { ...fixture.slot, executionRoot: undefined }, { ...fixture.slot, path: '/adopted-root' },
    ]
    for (const slot of candidates) {
      expect((yield* beginPoolReset({ state: { ...fixture.state, slots: [slot] }, expected: slot, token: slot.token, actor, commit: target })
        .pipe(Effect.result))._tag).toBe('Failure')
      const ready: PoolSlot = { ...slot, state: 'ready', token: '', owner: '', chargeKnown: true }
      expect((yield* beginPoolRetarget({ state: { ...fixture.state, slots: [ready] }, expected: ready, actor, commit: target })
        .pipe(Effect.result))._tag).toBe('Failure')
    }
  }))

  it.effect('finishes only the exact active retarget, applying existing budget validation and preserving terminal claim', () => Effect.gen(function* () {
    const fixture = yield* completedFixture
    const intent = yield* beginPoolReset({ state: fixture.state, expected: fixture.slot, token: fixture.slot.token, actor, commit: target })
    const state: PoolState = { ...fixture.state, slots: [intent] }
    const before = JSON.stringify(state)
    const prepared = { identity: 'verified-new-source-history', charge: 80 }
    const ready = yield* finishPoolRetarget({ state, intent, prepared })
    expect(ready.state).toBe('ready')
    expect(ready.token).toBe('')
    expect(ready.owner).toBe('')
    expect(ready.identity).toBe(prepared.identity)
    expect(ready.charge).toBe(80)
    expect(ready.chargeKnown).toBe(true)
    expect(ready.lifecycle?.claim).toEqual(fixture.slot.lifecycle?.claim)
    expect(ready.lifecycle?.retarget).toEqual({ generation: 3, actor, state: 'terminal', outcome: 'success' })
    expect(JSON.stringify(state)).toBe(before)
    for (const invalid of [{ identity: '', charge: 80 }, ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 129]
      .map((charge) => ({ identity: prepared.identity, charge }))])
      expect((yield* finishPoolRetarget({ state, intent, prepared: invalid }).pipe(Effect.result))._tag).toBe('Failure')
    const changed: PoolSlot = { ...intent, lifecycle: { ...intent.lifecycle, retarget: {
      generation: intent.generation, actor: { ...actor, startTime: 'replacement-process' }, state: 'active',
    } } }
    expect((yield* finishPoolRetarget({ state: { ...state, slots: [changed] }, intent, prepared }).pipe(Effect.result))._tag).toBe('Failure')
    const origin = intent.executionRoot
    if (origin === undefined) return yield* Effect.die('Fresh producer omitted its disposable-root origin')
    const promoted: PoolSlot = { ...intent, executionRoot: { ...origin, authored: true } }
    expect((yield* finishPoolRetarget({ state: { ...state, slots: [promoted] }, intent: promoted, prepared })
      .pipe(Effect.result))._tag).toBe('Failure')
  }))

  it.effect('refuses reset with a wrong claim, stale full snapshot or nonterminal operation', () => Effect.gen(function* () {
    const { slot, state } = yield* completedFixture
    expect((yield* beginPoolReset({ state, expected: slot, token: 'wrong', actor, commit: target }).pipe(Effect.result))._tag).toBe('Failure')
    expect((yield* beginPoolReset({ state, expected: { ...slot, identity: 'stale' }, token: slot.token, actor, commit: target })
      .pipe(Effect.result))._tag).toBe('Failure')
    const active: PoolSlot = { ...slot, lifecycle: { ...slot.lifecycle, claim: { generation: slot.generation, actor, state: 'active' } } }
    expect((yield* beginPoolReset({ state: { ...state, slots: [active] }, expected: active, token: slot.token, actor, commit: target })
      .pipe(Effect.result))._tag).toBe('Failure')
  }))

  it.effect('finalizes idle retarget and permits a new fenced retarget without inventing a claim', () => Effect.gen(function* () {
    const fixture = yield* readyFixture
    const intent = yield* beginPoolRetarget({ state: fixture.state, expected: fixture.slot, actor, commit: target })
    expect(intent.charge).toBe(fixture.slot.charge)
    expect(intent.token).not.toBe('')
    expect(intent.owner).toBe('')
    expect(intent.barrierToken).toBe(fixture.slot.barrierToken)
    const state: PoolState = { ...fixture.state, slots: [intent] }
    const prepared = { identity: 'new-source-history', charge: 80 }
    const ready = yield* finishPoolRetarget({ state, intent, prepared })
    const published: PoolState = { ...state, slots: [ready] }
    expect(ready.lifecycle?.claim).toBeUndefined()
    expect((yield* finishPoolRetarget({ state: published, intent, prepared }).pipe(Effect.result))._tag).toBe('Failure')
    const next = yield* beginPoolRetarget({ state: published, expected: ready, actor, commit })
    expect(next.generation).toBe(ready.generation + 1)
    expect(next.token).not.toBe(intent.token)
    expect(next.lifecycle?.claim).toBeUndefined()
    expect(next.identity).toBe(prepared.identity)
  }))

  it.effect('refuses missing, terminal or mismatched retarget operations even in an exact saved snapshot', () => Effect.gen(function* () {
    const fixture = yield* readyFixture
    const intent = yield* beginPoolRetarget({ state: fixture.state, expected: fixture.slot, actor, commit: target })
    const candidates: PoolSlot[] = [
      { ...intent, lifecycle: { ...intent.lifecycle, retarget: undefined } },
      { ...intent, lifecycle: { ...intent.lifecycle, retarget: { generation: intent.generation, actor, state: 'terminal', outcome: 'success' } } },
      { ...intent, lifecycle: { ...intent.lifecycle, retarget: { generation: intent.generation + 1, actor, state: 'active' } } },
    ]
    for (const candidate of candidates)
      expect((yield* finishPoolRetarget({ state: { ...fixture.state, slots: [candidate] }, intent: candidate,
        prepared: { identity: 'new-source-history', charge: 80 } }).pipe(Effect.result))._tag).toBe('Failure')
  }))

  it.effect('charges other real reservations at the aggregate boundary rather than treating them as free', () => Effect.gen(function* () {
    const fixture = yield* readyFixture
    const other = yield* reserveFreshPoolRoot({ state: { ...fixture.state, maxSlots: 2 }, bare: '/other/.bare', commit, charge: 48 })
    const intent = yield* beginPoolRetarget({ state: other.state, expected: fixture.slot, actor, commit: target })
    const state: PoolState = { ...other.state, slots: other.state.slots.map((slot) => slot.id === intent.id ? intent : slot) }
    expect((yield* finishPoolRetarget({ state, intent, prepared: { identity: 'new-source-history', charge: 80 } })).charge).toBe(80)
    expect((yield* finishPoolRetarget({ state, intent, prepared: { identity: 'new-source-history', charge: 81 } })
      .pipe(Effect.result))._tag).toBe('Failure')
  }))

  it.effect('composes real metadata claim, completion, reset, finalization and a subsequent claimant', () => Effect.gen(function* () {
    const fixture = yield* leasedFixture
    const completed = yield* completePoolUse({ state: fixture.state, expected: fixture.slot,
      token: fixture.slot.token, outcome: 'failure' })
    const intent = yield* beginPoolReset({ state: { ...fixture.state, slots: [completed] }, expected: completed,
      token: completed.token, actor, commit: target })
    const ready = yield* finishPoolRetarget({ state: { ...fixture.state, slots: [intent] }, intent,
      prepared: { identity: 'verified-next-source-history', charge: 80 } })
    expect(ready.lifecycle?.claim?.state).toBe('terminal')
    const claim = yield* beginPoolClaim({ slot: ready, identity: ready.identity, owner: 'next-metadata-task' })
    const nextActor: PoolActor = { ...actor, pid: 2, startTime: 'next-metadata-generation' }
    const leased = yield* finishPoolClaim({ state: { ...fixture.state, slots: [claim] }, intent: claim,
      identity: ready.identity, owner: claim.owner, actor: nextActor })
    expect(leased.generation).toBe(4)
    expect(leased.lifecycle?.claim).toEqual({ generation: 4, actor: nextActor, state: 'active' })
    expect(leased.lifecycle?.retarget).toEqual(ready.lifecycle?.retarget)
    expect(leased.physicalBirth).toEqual(fixture.slot.physicalBirth)
    expect(leased.barrierToken).toBe(fixture.slot.barrierToken)
    expect(leased.chargeKnown).toBe(false)
  }))

  it.effect('holds missing, cross-boot and rebound recorded birth even in an exact saved retarget snapshot', () => Effect.gen(function* () {
    const fixture = yield* readyFixture
    const intent = yield* beginPoolRetarget({ state: fixture.state, expected: fixture.slot, actor, commit: target })
    const birth = intent.physicalBirth
    if (birth === undefined) return yield* Effect.die('Metadata fixture omitted recorded physical birth')
    const candidates: PoolSlot[] = [
      { ...intent, physicalBirth: undefined },
      { ...intent, physicalBirth: { ...birth, bootId: 'other-boot' } },
      { ...intent, physicalBirth: { ...birth, root: metadataChain('/metadata/pool/rebound') } },
      { ...intent, physicalBirth: { ...birth, gitAdmin: metadataChain('/metadata/.bare/other/admin') } },
    ]
    for (const candidate of candidates)
      expect((yield* finishPoolRetarget({ state: { ...fixture.state, slots: [candidate] }, intent: candidate,
        prepared: { identity: 'new-source-history', charge: 80 } }).pipe(Effect.result))._tag).toBe('Failure')
  }))
})
