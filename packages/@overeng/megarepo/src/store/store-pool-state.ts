import { randomUUID } from 'node:crypto'
import { open, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

import { Effect, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'

import { type AbsoluteDirPath } from '@overeng/effect-path'

import { withDeletionLease } from './store-deletion-lease.ts'

/** Authoritative records: uncertain generations are never implicitly recovered. */
export const PoolSlot = Schema.Struct({
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
/** Durable identity, accounting and lifecycle of one protected detached path. */
export type PoolSlot = Schema.Schema.Type<typeof PoolSlot>
const PoolState = Schema.Struct({
  version: Schema.Literal(1),
  maxSlots: Schema.Finite,
  maxBytes: Schema.Finite,
  slots: Schema.Array(PoolSlot),
})
/** Host-wide authoritative pool ledger and immutable retention limits. */
export type PoolState = Schema.Schema.Type<typeof PoolState>

/** A refused pool operation or an unavailable authoritative proof. */
export class PoolError extends Schema.TaggedError<PoolError>()('PoolError', {
  message: Schema.String,
}) {}

const validatePoolState = (state: PoolState): Effect.Effect<PoolState, PoolError> =>
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
          slot.generation < 0,
      ) === true
    )
      return yield* new PoolError({
        message: 'Invalid authoritative pool ownership/accounting records',
      })
    return state
  })

const decodePoolState = (contents: string) =>
  Schema.decodeEffect(Schema.fromJsonString(PoolState))(contents).pipe(
    Effect.flatMap(validatePoolState),
  )

type PoolMissingEvidence = {
  readonly _tag: 'Missing'
  readonly reason: 'not-recorded-in-pool-v1'
}

/** Recorded metadata only: labels and ready flags are never removal authority. */
export type PoolProvenanceObservation = {
  readonly root: string
  readonly id: string
  readonly generation: number
  readonly recordedState: PoolSlot['state']
  readonly recordedReadyUnclaimed: boolean
  readonly ownerLabel: string
  readonly ownerActivity: PoolMissingEvidence
  readonly seatActivity: PoolMissingEvidence
  readonly terminalClaim: PoolMissingEvidence
  readonly terminalBirth: PoolMissingEvidence
  readonly terminalRetarget: PoolMissingEvidence
  readonly executionProvenance: PoolMissingEvidence
  readonly disposition: 'HOLD'
  readonly authorizesRemoval: false
}

/** Absence and unavailable activity never authorize cleanup. Read errors remain errors. */
export type PoolProvenanceSnapshot = {
  readonly _tag: 'Absent' | 'Observed'
  readonly observations: ReadonlyArray<PoolProvenanceObservation>
  readonly disposition: 'HOLD'
  readonly authorizesRemoval: false
}

const missingPoolEvidence: PoolMissingEvidence = {
  _tag: 'Missing',
  reason: 'not-recorded-in-pool-v1',
}

/** No initialization, repair, lease acquisition, or filesystem mutation. */
export const readPoolProvenance = ({
  base,
}: {
  base: AbsoluteDirPath
}): Effect.Effect<PoolProvenanceSnapshot, PoolError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const contents = yield* fs.readFileString(`${base}/.state/pool/state.json`).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === 'NotFound',
        () => Effect.succeed(undefined),
      ),
    )
    if (contents === undefined)
      return {
        _tag: 'Absent',
        observations: [],
        disposition: 'HOLD',
        authorizesRemoval: false,
      } satisfies PoolProvenanceSnapshot
    const state = yield* decodePoolState(contents)
    return {
      _tag: 'Observed',
      observations: state.slots.map((slot): PoolProvenanceObservation => ({
        root: slot.path,
        id: slot.id,
        generation: slot.generation,
        recordedState: slot.state,
        recordedReadyUnclaimed: slot.state === 'ready' && slot.token === '' && slot.owner === '',
        ownerLabel: slot.owner,
        ownerActivity: missingPoolEvidence,
        seatActivity: missingPoolEvidence,
        terminalClaim: missingPoolEvidence,
        terminalBirth: missingPoolEvidence,
        terminalRetarget: missingPoolEvidence,
        executionProvenance: missingPoolEvidence,
        disposition: 'HOLD',
        authorizesRemoval: false,
      })),
      disposition: 'HOLD',
      authorizesRemoval: false,
    } satisfies PoolProvenanceSnapshot
  }).pipe(
    Effect.mapError(
      () => new PoolError({ message: 'Pool provenance unavailable; removal remains HOLD' }),
    ),
    Effect.withSpan('megarepo/store/pool/provenance'),
  )

/** Fsync both contents and rename: readiness/ownership must survive process loss. */
const persist = ({ path, state }: { path: string; state: PoolState }) =>
  Effect.gen(function* () {
    const contents = yield* Schema.encodeEffect(Schema.fromJsonString(PoolState))(state)
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
      const state =
        exists === true
          ? yield* fs.readFileString(path).pipe(Effect.flatMap(decodePoolState))
          : yield* validatePoolState({
              version: 1,
              maxSlots: limits?.maxSlots ?? 0,
              maxBytes: limits?.maxBytes ?? 0,
              slots: [],
            })
      if (
        limits !== undefined &&
        exists === true &&
        (limits.maxSlots !== state.maxSlots || limits.maxBytes !== state.maxBytes)
      )
        return yield* new PoolError({
          message: 'Pool limits are host-wide and immutable while records exist',
        })
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
