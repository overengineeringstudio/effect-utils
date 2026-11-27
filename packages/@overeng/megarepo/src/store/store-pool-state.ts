import { randomUUID } from 'node:crypto'
import { open, rename } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

import { Effect, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'

import { type AbsoluteDirPath } from '@overeng/effect-path'

import { withDeletionLease } from './store-deletion-lease.ts'
import { withVerifiedDirectoryPins, type OwnedDeletionPins } from './store-pinned-deletion.ts'
import { requireOutsidePoolGlobal, withPoolGlobalEpoch } from './store-pool-lock-order.ts'

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
  executionRoot: Schema.optional(
    Schema.Struct({
      origin: Schema.Literal('fresh-reserved-uuid'),
      path: Schema.String,
      authored: Schema.Boolean,
    }),
  ),
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
        () => Effect.void,
      ),
    )
    if (typeof contents !== 'string')
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
    yield* requireOutsidePoolGlobal(
      () => new PoolError({ message: 'GLOBAL pool epoch cannot acquire another epoch' }),
    )
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
      return yield* use(state, (next) => persist({ path, state: next })).pipe(withPoolGlobalEpoch)
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

/** Only the reservation producer may mint disposable physical-root provenance. */
export const reserveFreshPoolRoot = ({
  state,
  bare,
  commit,
  charge,
}: {
  state: PoolState
  bare: string
  commit: string
  charge: number
}) => {
  const id = randomUUID()
  const path = join(dirname(bare), 'pool', id)
  const slot: PoolSlot = {
    id, path, bare, commit, charge,
    identity: '', generation: 0, state: 'preparing',
    chargeKnown: true, token: '', barrierToken: '', owner: '', reason: '',
    executionRoot: { origin: 'fresh-reserved-uuid', path, authored: false },
  }
  return reservePoolSlot({ state, slot }).pipe(
    Effect.map((next) => ({ state: next, slot })),
  )
}

/** Physical-root contract only; callers still need fresh Git, GVS, pins and holder proofs. */
export const requireDisposablePoolRoot = (slot: PoolSlot) =>
  slot.executionRoot?.origin === 'fresh-reserved-uuid' &&
  isAbsolute(slot.bare) &&
  slot.executionRoot.path === slot.path &&
  slot.path === join(dirname(slot.bare), 'pool', slot.id) &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(slot.id) &&
  slot.executionRoot.authored === false
    ? Effect.void
    : Effect.fail(new PoolError({ message: 'Unknown or authored physical pool root; HOLD' }))

/**
 * Persist BEFORE any in-place authoring/promotion write, under the caller's ROOT action fence.
 * No operation clears this physical-root bit. Copy-style promotion does not alter the source.
 */
export const markPoolRootAuthored = ({
  base,
  id,
  generation,
}: {
  base: AbsoluteDirPath
  id: string
  generation: number
}) =>
  withPoolState({
    base,
    use: (state, save) =>
      Effect.gen(function* () {
        const slot = state.slots.find((item) => item.id === id)
        if (slot === undefined || slot.generation !== generation || slot.executionRoot === undefined)
          return yield* new PoolError({ message: 'Physical pool provenance unavailable; HOLD' })
        const next: PoolSlot = {
          ...slot,
          executionRoot: { ...slot.executionRoot, authored: true },
          state: 'quarantined',
          chargeKnown: false,
          reason: 'Physical root authored or promoted; never reset',
        }
        yield* save({ ...state, slots: state.slots.map((item) => item.id === id ? next : item) })
      }),
  })

/**
 * Finish a reserved preparation: ROOT lease → pins → short GLOBAL CAS.
 * Prepare owns fresh Git/GVS/holder proofs; this helper neither resets nor removes roots.
 * A publication/durability error may leave verified READY: never infer failure means unpublished
 * or automatically retry/repair.
 */
export const preparePoolGeneration = <E, R>({
  base,
  id,
  generation,
  targets,
  prepare,
}: {
  base: AbsoluteDirPath
  id: string
  generation: number
  targets: Parameters<typeof withVerifiedDirectoryPins>[0]['targets']
  prepare: (
    slot: PoolSlot,
    pins: ReadonlyArray<OwnedDeletionPins>,
  ) => Effect.Effect<{ identity: string; charge: number }, E, R>
}) =>
  Effect.gen(function* () {
    const lookup = (state: PoolState): Effect.Effect<PoolSlot, PoolError> => {
      const slot = state.slots.find((item) => item.id === id)
      return slot === undefined
        ? Effect.fail(new PoolError({ message: 'Pool reservation missing' }))
        : Effect.succeed(slot)
    }
    const path = targets[0]?.path
    if (path === undefined)
      return yield* new PoolError({ message: 'Pinned reservation root is required' })
    return yield* Effect.gen(function* () {
      const intent = yield* withPoolState({
        base,
        use: (state, save) =>
          Effect.gen(function* () {
            const slot = yield* lookup(state)
            if (
              slot.path !== path ||
              slot.generation !== generation ||
              Number.isSafeInteger(slot.generation + 1) === false ||
              slot.state !== 'preparing' ||
              slot.token !== '' ||
              slot.owner !== '' ||
              slot.chargeKnown !== true
            )
              return yield* new PoolError({
                message: 'Preparation requires an untouched reservation',
              })
            const next: PoolSlot = {
              ...slot,
              generation: slot.generation + 1,
              token: randomUUID(),
              chargeKnown: false,
              reason: 'Preparation pending verified commit; HOLD',
            }
            yield* save({
              ...state,
              slots: state.slots.map((item) => (item.id === id ? next : item)),
            })
            return next
          }),
      })
      return yield* withVerifiedDirectoryPins({
        targets,
        prepare: (pins) => prepare(intent, pins),
        commit: (prepared) =>
          withPoolState({
            base,
            use: (state, save) =>
              Effect.gen(function* () {
                const current = yield* lookup(state)
                if (
                  current.path !== intent.path ||
                  current.generation !== intent.generation ||
                  current.token !== intent.token ||
                  current.bare !== intent.bare ||
                  current.commit !== intent.commit ||
                  current.identity !== intent.identity ||
                  current.barrierToken !== intent.barrierToken ||
                  current.owner !== intent.owner ||
                  current.charge !== intent.charge ||
                  current.state !== 'preparing' ||
                  current.chargeKnown !== false
                )
                  return yield* new PoolError({ message: 'Preparation generation changed; HOLD' })
                if (
                  prepared.identity === '' ||
                  Number.isSafeInteger(prepared.charge) === false ||
                  prepared.charge <= 0 ||
                  state.slots.reduce(
                    (sum, item) => sum + (item.id === id ? prepared.charge : item.charge),
                    0,
                  ) > state.maxBytes
                )
                  return yield* new PoolError({
                    message: 'Prepared identity/charge exceeds reservation limits; HOLD',
                  })
                const ready: PoolSlot = {
                  ...current,
                  state: 'ready',
                  token: '',
                  owner: '',
                  identity: prepared.identity,
                  charge: prepared.charge,
                  chargeKnown: true,
                  reason: '',
                }
                yield* save({
                  ...state,
                  slots: state.slots.map((item) => (item.id === id ? ready : item)),
                })
                return ready
              }),
          }),
      })
    }).pipe(withDeletionLease({ storeBasePath: base, ownerPath: path, now: Date.now() }))
  })
