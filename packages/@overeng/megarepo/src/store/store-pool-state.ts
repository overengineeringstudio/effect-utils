import { randomUUID } from 'node:crypto'
import { open, rename } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { Effect, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'

import { type AbsoluteDirPath } from '@overeng/effect-path'

import { withDeletionLease } from './store-deletion-lease.ts'
import { DeletionIdentity } from './store-pinned-deletion.ts'

/** Recorded native birth, never a fresh inspection or cross-boot adoption proof. */
export const PoolPhysicalBirth = Schema.Struct({
  bootId: Schema.NonEmptyString,
  root: DeletionIdentity,
  gitAdmin: DeletionIdentity,
})
export type PoolPhysicalBirth = typeof PoolPhysicalBirth.Type

/** Exact authenticated leader generation recorded by the physical caller. */
export const PoolActor = Schema.Struct({
  hostId: Schema.NonEmptyString,
  bootId: Schema.NonEmptyString,
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  startTime: Schema.NonEmptyString,
})
export type PoolActor = typeof PoolActor.Type

/** Active work has no outcome; only terminal work records success or failure. */
export const PoolOperation = Schema.Union([
  Schema.Struct({
    generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    actor: PoolActor,
    state: Schema.Literal('active'),
    outcome: Schema.optionalKey(Schema.Never),
  }),
  Schema.Struct({
    generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    actor: PoolActor,
    state: Schema.Literal('terminal'),
    outcome: Schema.Literals(['success', 'failure']),
  }),
])
export type PoolOperation = typeof PoolOperation.Type

/** Independent categories preserve terminal claims across later retargets. */
export const PoolLifecycle = Schema.Struct({
  birth: Schema.optional(PoolOperation),
  claim: Schema.optional(PoolOperation),
  retarget: Schema.optional(PoolOperation),
})
export type PoolLifecycle = typeof PoolLifecycle.Type

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
  physicalBirth: Schema.optional(PoolPhysicalBirth),
  lifecycle: Schema.optional(PoolLifecycle),
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

const equivalentSlot = Schema.toEquivalence(PoolSlot)
const equivalentBirth = Schema.toEquivalence(PoolPhysicalBirth)

/** Full authoritative snapshot fence; not ownership or physical proof. */
export const requirePoolSlotSnapshot = ({
  state, expected,
}: { state: PoolState; expected: PoolSlot }): Effect.Effect<PoolSlot, PoolError> => {
  const current = state.slots.find((slot) => slot.id === expected.id)
  return current !== undefined && equivalentSlot(current, expected)
    ? Effect.succeed(current)
    : Effect.fail(new PoolError({ message: 'Pool snapshot changed or missing; HOLD' }))
}

const nativeChain = (identity: DeletionIdentity): boolean =>
  identity[0]?.path === '/' &&
  identity.at(-1)?._tag === 'Inode' &&
  identity.every((entry, index) =>
    resolve(entry.path) === entry.path &&
    (index === 0 || (entry.path !== '/' && dirname(entry.path) === identity[index - 1]?.path)),
  )

const matchesBirthPaths = (slot: PoolSlot, birth: PoolPhysicalBirth): boolean => {
  const admin = birth.gitAdmin.at(-1)
  return birth.bootId !== '' && nativeChain(birth.root) && nativeChain(birth.gitAdmin) &&
    birth.root.at(-1)?.path === slot.path &&
    resolve(slot.bare) === slot.bare && admin !== undefined &&
    dirname(admin.path) === `${slot.bare}/worktrees`
}

/** Pure, once-only candidate for an untouched unknown precreation intent.
 * Caller supplies actual fresh-origin/native creation, lease, pins and holder evidence.
 */
export const bindPoolPhysicalBirth = ({
  state, expected, birth,
}: { state: PoolState; expected: PoolSlot; birth: PoolPhysicalBirth }): Effect.Effect<PoolSlot, PoolError> =>
  Effect.gen(function* () {
    const current = yield* requirePoolSlotSnapshot({ state, expected })
    if (
      current.state !== 'preparing' || current.chargeKnown !== false ||
      current.token === '' || current.owner !== '' || current.barrierToken === '' ||
      current.identity !== '' || current.physicalBirth !== undefined ||
      matchesBirthPaths(current, birth) === false
    )
      return yield* new PoolError({ message: 'Physical birth requires untouched native intent; HOLD' })
    return { ...current, physicalBirth: birth }
  })

/** Missing, replaced or cross-boot physical roots never implicitly recover. */
export const requirePoolPhysicalBirth = ({
  slot, birth,
}: { slot: PoolSlot; birth: PoolPhysicalBirth }): Effect.Effect<void, PoolError> =>
  slot.physicalBirth !== undefined && matchesBirthPaths(slot, birth) &&
  equivalentBirth(slot.physicalBirth, birth)
    ? Effect.void
    : Effect.fail(new PoolError({ message: 'Physical birth missing or changed; HOLD' }))

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

type PoolRecordedEvidence<TEvidence> = PoolMissingEvidence | { readonly _tag: 'Recorded'; readonly value: TEvidence }
type PoolTerminalOperation = Extract<PoolOperation, { readonly state: 'terminal' }>

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
  readonly physicalBirth: PoolRecordedEvidence<PoolPhysicalBirth>
  readonly lifecycle: PoolRecordedEvidence<PoolLifecycle>
  readonly terminalClaim: PoolRecordedEvidence<PoolTerminalOperation>
  readonly terminalBirth: PoolRecordedEvidence<PoolTerminalOperation>
  readonly terminalRetarget: PoolRecordedEvidence<PoolTerminalOperation>
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

const terminalEvidence = (
  operation: PoolOperation | undefined,
): PoolRecordedEvidence<PoolTerminalOperation> =>
  operation?.state === 'terminal'
    ? { _tag: 'Recorded', value: operation }
    : missingPoolEvidence

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
        physicalBirth: slot.physicalBirth === undefined
          ? missingPoolEvidence : { _tag: 'Recorded', value: slot.physicalBirth },
        lifecycle: slot.lifecycle === undefined
          ? missingPoolEvidence : { _tag: 'Recorded', value: slot.lifecycle },
        terminalClaim: terminalEvidence(slot.lifecycle?.claim),
        terminalBirth: terminalEvidence(slot.lifecycle?.birth),
        terminalRetarget: terminalEvidence(slot.lifecycle?.retarget),
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
