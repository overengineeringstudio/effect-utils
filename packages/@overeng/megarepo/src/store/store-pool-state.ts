import { randomUUID } from 'node:crypto'
import { open, rename } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { Effect, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'

import { type AbsoluteDirPath } from '@overeng/effect-path'

import { withDeletionLease } from './store-deletion-lease.ts'

/** Historical authority is decoded only at the single canonical read boundary. */
const PoolSlotV1 = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  bare: Schema.String,
  commit: Schema.String,
  identity: Schema.String,
  charge: Schema.Finite,
  chargeKnown: Schema.optional(Schema.Boolean),
  generation: Schema.Finite,
  state: Schema.Literals(['preparing', 'ready', 'leased', 'completed', 'quarantined']),
  token: Schema.String,
  barrierToken: Schema.String,
  owner: Schema.String,
  reason: Schema.String,
})
const RetargetIntent = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  token: Schema.String,
})
/** Authoritative records: uncertain generations are never implicitly recovered. */
export const PoolSlot = Schema.Struct({
  ...PoolSlotV1.fields,
  state: Schema.Union([PoolSlotV1.fields.state, Schema.Literal('reserved')]),
  reservation: Schema.optional(Schema.String),
  sourceHistory: Schema.NonEmptyArray(Schema.String),
  retarget: Schema.optional(RetargetIntent),
})
/** Durable identity, accounting and lifecycle of one protected detached path. */
export type PoolSlot = Schema.Schema.Type<typeof PoolSlot>
const PoolState = Schema.Struct({
  version: Schema.Literal(2),
  maxSlots: Schema.Finite,
  maxBytes: Schema.Finite,
  slots: Schema.Array(PoolSlot),
})
const HistoricalPoolState = Schema.Struct({
  ...PoolState.fields,
  version: Schema.Literal(1),
  slots: Schema.Array(PoolSlotV1),
})
const PoolStateReader = Schema.Union([HistoricalPoolState, PoolState])
/** Host-wide authoritative pool ledger and immutable retention limits. */
export type PoolState = Schema.Schema.Type<typeof PoolState>

/** A refused pool operation or an unavailable authoritative proof. */
export class PoolError extends Schema.TaggedError<PoolError>()('PoolError', {
  message: Schema.String,
}) {}

const validatePoolState = (state: PoolState) =>
  Effect.gen(function* () {
    if (
      Number.isSafeInteger(state.maxSlots) === false ||
      state.maxSlots <= 0 ||
      Number.isSafeInteger(state.maxBytes) === false ||
      state.maxBytes <= 0
    )
      return yield* new PoolError({
        message: 'Initialize pool with positive max-slots and max-bytes',
      })
    if (
      new Set(state.slots.map((slot) => slot.id)).size !== state.slots.length ||
      new Set(state.slots.map((slot) => slot.path)).size !== state.slots.length ||
      state.slots.some(
        (slot) =>
          Number.isSafeInteger(slot.charge) === false ||
          slot.charge <= 0 ||
          Number.isSafeInteger(slot.generation) === false ||
          slot.generation < 0 ||
          slot.sourceHistory.at(-1) !== slot.commit ||
          (slot.state === 'reserved'
            ? slot.reservation === undefined ||
              slot.reservation === '' ||
              slot.generation !== 0 ||
              slot.chargeKnown !== true ||
              slot.identity !== '' ||
              slot.token !== '' ||
              slot.barrierToken !== '' ||
              slot.owner !== '' ||
              slot.retarget !== undefined ||
              slot.sourceHistory.length !== 1 ||
              slot.bare.startsWith('/') === false ||
              resolve(slot.bare) !== slot.bare ||
              resolve(slot.path) !== slot.path ||
              /^[0-9a-f]{40}$/u.test(slot.commit) === false ||
              slot.path !== `${dirname(slot.bare)}/pool/${slot.id}`
            : slot.reservation !== undefined) ||
          (slot.retarget !== undefined &&
            (['preparing', 'quarantined'].includes(slot.state) === false ||
              slot.identity !== '' ||
              slot.token !== '' ||
              slot.chargeKnown !== false ||
              slot.retarget.to !== slot.commit ||
              slot.sourceHistory.at(-2) !== slot.retarget.from ||
              slot.retarget.token === '')),
      ) === true
    )
      return yield* new PoolError({
        message: 'Invalid authoritative pool ownership/accounting records',
      })
  })

/** Fsync both contents and rename: readiness/ownership must survive process loss. */
const persist = ({ path, state }: { path: string; state: PoolState }) =>
  Effect.gen(function* () {
    yield* validatePoolState(state)
    const contents = yield* Schema.encodeEffect(Schema.fromJsonString(PoolState), {
      onExcessProperty: 'error',
    })(state)
    yield* Effect.tryPromise(async () => {
      const temporary = `${path}.${randomUUID()}`
      const file = await open(temporary, 'wx', 0o600)
      try {
        await file.writeFile(contents)
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temporary, path)
      const directory = await open(dirname(path), 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    })
  }).pipe(
    Effect.mapError((cause) => new PoolError({ message: `Pool persistence failed: ${cause}` })),
    Effect.uninterruptible,
  )

/** One host-store-wide exclusion point, including capacity reservation. No TTL takeover. */
export const withPoolState = <A, E, R>({
  base,
  use,
  limits,
}: {
  base: AbsoluteDirPath
  use: (
    state: PoolState,
    save: (next: PoolState) => Effect.Effect<void, PoolError>,
  ) => Effect.Effect<A, E, R>
  limits?: { maxSlots: number; maxBytes: number }
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(`${base}/.state/pool`, { recursive: true })
    const directory = yield* fs.realPath(`${base}/.state/pool`)
    return yield* Effect.gen(function* () {
      const path = `${directory}/state.json`
      const exists = yield* fs.exists(path)
      const stored =
        exists === true
          ? yield* fs
              .readFileString(path)
              .pipe(
                Effect.flatMap(
                  Schema.decodeEffect(Schema.fromJsonString(PoolStateReader), {
                    onExcessProperty: 'error',
                  }),
                ),
              )
          : {
              version: 2 as const,
              maxSlots: limits?.maxSlots ?? 0,
              maxBytes: limits?.maxBytes ?? 0,
              slots: [],
            }
      const state: PoolState =
        stored.version === 1
          ? {
              ...stored,
              version: 2,
              slots: stored.slots.map(
                (slot): PoolSlot => ({ ...slot, sourceHistory: [slot.commit] }),
              ),
            }
          : stored
      if (
        limits !== undefined &&
        exists === true &&
        (limits.maxSlots !== state.maxSlots || limits.maxBytes !== state.maxBytes)
      )
        return yield* new PoolError({
          message: 'Pool limits are host-wide and immutable while records exist',
        })
      if (stored.version === 1) yield* persist({ path, state })
      else yield* validatePoolState(state)
      return yield* use(state, (next) => persist({ path, state: next }))
    }).pipe(withDeletionLease({ storeBasePath: base, ownerPath: directory, now: Date.now() }))
  })

type PoolLeaseCheck = { slot: PoolSlot; token: string; generation: number }
type PoolClaim = { slot: PoolSlot; identity: string; owner: string }

/** Pure generation fence; a token can authorize only its original claim. */
export const requirePoolLease = ({ slot, token, generation }: PoolLeaseCheck) =>
  (slot.state === 'leased' || slot.state === 'completed') &&
  slot.token === token &&
  slot.generation === generation
    ? Effect.void
    : Effect.fail(new PoolError({ message: 'Stale or non-leased pool generation' }))

/** Transition is published only under withPoolState after real root proofs. */
export const claimPoolGeneration = ({
  slot,
  identity,
  owner,
}: PoolClaim): Effect.Effect<PoolSlot, PoolError> => {
  if (slot.state !== 'ready' || slot.identity !== identity)
    return Effect.fail(
      new PoolError({ message: 'Generation is not ready for this install identity' }),
    )
  const next: PoolSlot = {
    ...slot,
    state: 'leased',
    chargeKnown: false,
    generation: slot.generation + 1,
    token: randomUUID(),
    owner,
    reason: '',
  }
  return Effect.succeed(next)
}

/** Reserve counted, known logical bytes without discarding uncertain generations. */
export const reservePoolSlot = ({ state, slot }: { state: PoolState; slot: PoolSlot }) => {
  if (state.slots.some((item) => item.chargeKnown !== true) === true)
    return Effect.fail(
      new PoolError({ message: 'Pool retained bytes are unknown; allocation blocked' }),
    )
  if (
    Number.isSafeInteger(slot.charge) === false ||
    slot.charge <= 0 ||
    state.slots.length >= state.maxSlots ||
    state.slots.reduce((sum, item) => sum + item.charge, 0) + slot.charge > state.maxBytes
  )
    return Effect.fail(
      new PoolError({ message: 'Host-wide pool capacity exhausted or invalid charge' }),
    )
  return Effect.succeed({ ...state, slots: [...state.slots, slot] })
}

/** Reserve an unborn, bounded path for explicit owner enrollment; no filesystem mutation. */
export const reservePoolGeneration = ({
  state,
  bare,
  commit,
  charge,
}: {
  state: PoolState
  bare: string
  commit: string
  charge: number
}): Effect.Effect<PoolState, PoolError> => {
  if (
    bare.startsWith('/') === false ||
    resolve(bare) !== bare ||
    /^[0-9a-f]{40}$/u.test(commit) === false
  )
    return Effect.fail(new PoolError({ message: 'Reservation requires canonical bare path and SHA' }))
  const id = randomUUID()
  return reservePoolSlot({
    state,
    slot: {
      id,
      bare,
      commit,
      charge,
      path: `${dirname(bare)}/pool/${id}`,
      sourceHistory: [commit],
      state: 'reserved',
      chargeKnown: true,
      generation: 0,
      reservation: randomUUID(),
      identity: '',
      token: '',
      barrierToken: '',
      owner: '',
      reason: '',
    },
  })
}

/** Consume exactly once under the durable lease before any native path creation. */
export const consumePoolReservation = ({
  slot,
  id,
  reservation,
  generation,
  bare,
  commit,
  charge,
}: {
  slot: PoolSlot
  id: string
  reservation: string
  generation: number
  bare: string
  commit: string
  charge: number
}): Effect.Effect<PoolSlot, PoolError> =>
  slot.state === 'reserved' &&
  slot.chargeKnown === true &&
  slot.generation === 0 &&
  slot.id === id &&
  slot.reservation === reservation &&
  reservation !== '' &&
  slot.generation === generation &&
  slot.bare === bare &&
  slot.commit === commit &&
  slot.charge === charge &&
  slot.path === `${dirname(bare)}/pool/${id}`
    ? Effect.succeed<PoolSlot>({
        ...slot,
        reservation: undefined,
        generation: generation + 1,
        state: 'preparing',
        chargeKnown: false,
        reason: 'Reserved root preparation',
      })
    : Effect.fail(new PoolError({ message: 'Stale or mismatched pool reservation' }))

/** Pure intent transition; the owner must persist it before any checkout mutation. */
export const beginPoolRetarget = ({
  slot,
  generation,
  identity,
  commit,
  owner,
}: {
  slot: PoolSlot
  generation: number
  identity: string
  commit: string
  owner: string
}): Effect.Effect<PoolSlot, PoolError> => {
  if (
    slot.state !== 'ready' ||
    slot.chargeKnown !== true ||
    slot.retarget !== undefined ||
    slot.generation !== generation ||
    Number.isSafeInteger(generation + 1) === false ||
    slot.identity !== identity ||
    identity === '' ||
    owner === '' ||
    commit === slot.commit ||
    /^[0-9a-f]{40}$/u.test(commit) === false
  )
    return Effect.fail(new PoolError({ message: 'Stale, unknown or non-ready retarget source' }))
  const next: PoolSlot = {
    ...slot,
    commit,
    sourceHistory: [...slot.sourceHistory, commit],
    retarget: { from: slot.commit, to: commit, token: randomUUID() },
    generation: generation + 1,
    identity: '',
    token: '',
    state: 'preparing',
    chargeKnown: false,
    owner,
    reason: 'Retarget preparation',
  }
  return Effect.succeed(next)
}

/** Pure completion fencing, not holder/readiness evidence or permission to mutate a root. */
export const finishPoolRetarget = ({
  slot,
  generation,
  token,
  result,
}: {
  slot: PoolSlot
  generation: number
  token: string
  result: { _tag: 'Prepared'; identity: string; charge: number } | { _tag: 'Failed'; reason: string }
}): Effect.Effect<PoolSlot, PoolError> => {
  if (
    slot.state !== 'preparing' ||
    slot.generation !== generation ||
    slot.retarget === undefined ||
    slot.retarget.token !== token
  )
    return Effect.fail(new PoolError({ message: 'Stale or non-preparing retarget intent' }))
  if (result._tag === 'Failed') {
    if (result.reason === '')
      return Effect.fail(new PoolError({ message: 'Failed retarget requires its retained reason' }))
    return Effect.succeed<PoolSlot>({ ...slot, state: 'quarantined', reason: result.reason })
  }
  if (
    result.identity === '' ||
    Number.isSafeInteger(result.charge) === false ||
    result.charge <= 0
  )
    return Effect.fail(new PoolError({ message: 'Retarget completion requires exact readiness/charge' }))
  return Effect.succeed<PoolSlot>({
    ...slot,
    retarget: undefined,
    identity: result.identity,
    charge: result.charge,
    chargeKnown: true,
    state: 'ready',
    owner: '',
    reason: '',
  })
}
