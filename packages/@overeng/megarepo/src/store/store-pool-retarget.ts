import { randomUUID } from 'node:crypto'

import { Effect, Schema } from 'effect'

import {
  finishPoolPreparation,
  PoolActor,
  PoolError,
  PoolOperation,
  type PoolSlot,
  type PoolState,
  requireDisposablePoolRoot,
  requirePoolLease,
  requirePoolPhysicalBirth,
  requirePoolSlotSnapshot,
} from './store-pool-state.ts'

const isActor = Schema.is(PoolActor)
const isOperation = Schema.is(PoolOperation)
const commitPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
const hold = () => new PoolError({ message: 'Pool use or retarget snapshot is inconsistent; HOLD' })
const sameBirthEpoch = ({ slot, actor }: { slot: PoolSlot; actor: PoolActor }) =>
  actor.hostId === slot.lifecycle?.birth?.actor.hostId &&
  actor.bootId === slot.lifecycle?.birth?.actor.bootId

/** Metadata only. These candidates never replace physical birth, Git/GVS, leases, pins or all-UID proof. */
const requireBasis = (slot: PoolSlot) =>
  Effect.gen(function* () {
    yield* requireDisposablePoolRoot(slot)
    const birth = slot.lifecycle?.birth
    const physical = slot.physicalBirth
    const claim = slot.lifecycle?.claim
    const retarget = slot.lifecycle?.retarget
    if (
      Number.isSafeInteger(slot.generation) === false ||
      slot.generation < 0 ||
      Number.isSafeInteger(slot.charge) === false ||
      slot.charge <= 0 ||
      slot.identity === '' ||
      slot.barrierToken === '' ||
      birth === undefined ||
      isOperation(birth) === false ||
      birth.state !== 'terminal' ||
      birth.outcome !== 'success' ||
      physical === undefined ||
      birth.generation > slot.generation ||
      physical.bootId !== birth.actor.bootId ||
      (claim !== undefined &&
        (isOperation(claim) === false ||
          claim.generation > slot.generation ||
          sameBirthEpoch({ slot, actor: claim.actor }) === false)) ||
      (retarget !== undefined &&
        (isOperation(retarget) === false ||
          retarget.generation > slot.generation ||
          sameBirthEpoch({ slot, actor: retarget.actor }) === false ||
          (retarget.state === 'terminal' && retarget.outcome !== 'success')))
    )
      return yield* hold()
    yield* requirePoolPhysicalBirth({ slot, birth: physical })
  })

const requireTarget = ({
  slot,
  actor,
  commit,
}: {
  slot: PoolSlot
  actor: PoolActor
  commit: string
}) =>
  isActor(actor) === false ||
  commitPattern.test(commit) === false ||
  Number.isSafeInteger(slot.generation + 1) === false ||
  sameBirthEpoch({ slot, actor }) === false
    ? Effect.fail(hold())
    : Effect.void

const newIntent = ({
  slot,
  actor,
  commit,
}: {
  slot: PoolSlot
  actor: PoolActor
  commit: string
}) => {
  const generation = slot.generation + 1
  const intent: PoolSlot = {
    ...slot,
    generation,
    commit,
    state: 'preparing',
    owner: '',
    token: randomUUID(),
    chargeKnown: false,
    reason: 'Retarget pending verified commit; HOLD',
    lifecycle: { ...slot.lifecycle, retarget: { generation, actor, state: 'active' } },
  }
  return intent
}

/** Save only after the actual task/children terminate and fresh physical completion proofs pass. */
export const completePoolUse = ({
  state,
  expected,
  token,
  outcome,
}: {
  state: PoolState
  expected: PoolSlot
  token: string
  outcome: 'success' | 'failure'
}): Effect.Effect<PoolSlot, PoolError> =>
  Effect.gen(function* () {
    const current = yield* requirePoolSlotSnapshot({ state, expected })
    yield* requireBasis(current)
    yield* requirePoolLease({ slot: current, token, generation: expected.generation })
    const claim = current.lifecycle?.claim
    if (
      current.state !== 'leased' ||
      current.token === '' ||
      current.owner === '' ||
      current.chargeKnown !== false ||
      claim === undefined ||
      isOperation(claim) === false ||
      claim.state !== 'active' ||
      claim.generation !== current.generation ||
      current.lifecycle?.retarget?.state === 'active' ||
      (outcome !== 'success' && outcome !== 'failure')
    )
      return yield* hold()
    const completed: PoolSlot = {
      ...current,
      state: 'completed',
      lifecycle: { ...current.lifecycle, claim: { ...claim, state: 'terminal', outcome } },
    }
    return completed
  })

/** Completed claim only; save UNKNOWN before any reset, with ROOT continuously held. No recovery. */
export const beginPoolReset = ({
  state,
  expected,
  token,
  actor,
  commit,
}: {
  state: PoolState
  expected: PoolSlot
  token: string
  actor: PoolActor
  commit: string
}): Effect.Effect<PoolSlot, PoolError> =>
  Effect.gen(function* () {
    const current = yield* requirePoolSlotSnapshot({ state, expected })
    yield* requireBasis(current)
    yield* requirePoolLease({ slot: current, token, generation: expected.generation })
    const claim = current.lifecycle?.claim
    if (
      current.state !== 'completed' ||
      current.token === '' ||
      current.owner === '' ||
      current.chargeKnown !== false ||
      claim === undefined ||
      isOperation(claim) === false ||
      claim.state !== 'terminal' ||
      claim.generation !== current.generation ||
      current.lifecycle?.retarget?.state === 'active'
    )
      return yield* hold()
    yield* requireTarget({ slot: current, actor, commit })
    return newIntent({ slot: current, actor, commit })
  })

/** Retarget an unclaimed READY slot directly; never manufacture an empty user claim. */
export const beginPoolRetarget = ({
  state,
  expected,
  actor,
  commit,
}: {
  state: PoolState
  expected: PoolSlot
  actor: PoolActor
  commit: string
}): Effect.Effect<PoolSlot, PoolError> =>
  Effect.gen(function* () {
    const current = yield* requirePoolSlotSnapshot({ state, expected })
    yield* requireBasis(current)
    const claim = current.lifecycle?.claim
    if (
      current.state !== 'ready' ||
      current.token !== '' ||
      current.owner !== '' ||
      current.chargeKnown !== true ||
      current.lifecycle?.retarget?.state === 'active' ||
      (claim !== undefined &&
        (isOperation(claim) === false ||
          claim.state !== 'terminal' ||
          claim.generation > current.generation))
    )
      return yield* hold()
    yield* requireTarget({ slot: current, actor, commit })
    return newIntent({ slot: current, actor, commit })
  })

/** Save only after owned checkout/history, install, ALL chain verification and fresh holder proof. */
export const finishPoolRetarget = ({
  state,
  intent,
  prepared,
}: {
  state: PoolState
  intent: PoolSlot
  prepared: { identity: string; charge: number }
}): Effect.Effect<PoolSlot, PoolError> =>
  Effect.gen(function* () {
    yield* requirePoolSlotSnapshot({ state, expected: intent })
    yield* requireBasis(intent)
    const retarget = intent.lifecycle?.retarget
    if (
      retarget === undefined ||
      isOperation(retarget) === false ||
      retarget.state !== 'active' ||
      retarget.generation !== intent.generation ||
      intent.lifecycle?.claim?.state === 'active' ||
      intent.token === '' ||
      intent.owner !== '' ||
      commitPattern.test(intent.commit) === false
    )
      return yield* hold()
    const ready = yield* finishPoolPreparation({ state, intent, prepared })
    const finished: PoolSlot = {
      ...ready,
      lifecycle: {
        ...ready.lifecycle,
        retarget: { ...retarget, state: 'terminal', outcome: 'success' },
      },
    }
    return finished
  })
