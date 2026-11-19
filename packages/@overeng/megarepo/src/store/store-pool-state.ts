import { randomUUID } from 'node:crypto'
import { type FileHandle, open, rename } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { Cause, Context, Effect, Exit, Option, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import type { PlatformError } from 'effect/PlatformError'
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner'

import { type AbsoluteDirPath, EffectPath } from '@overeng/effect-path'

import * as Git from '../core/git.ts'
import { type GitWriterLockError, withPoolWorktreeOperationLock } from './git-writer-lock.ts'
import {
  DeletionLeaseProviderObservation, type DeletionLeaseUnavailableError,
  hasPersistentDeletionLeases, withDeletionLease,
} from './store-deletion-lease.ts'
import { isStoreDirectory, makeStoreLayer, Store } from './store.ts'

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
/** Tool-observed root activity; an opaque owner label is never an authenticated seat. */
export const PoolActivityEvent = Schema.Struct({
  observedAtUtc: Schema.String,
  provider: DeletionLeaseProviderObservation,
  ownerLabel: Schema.String,
  ownerLabelOrigin: Schema.Literals(['none', 'claim-argument', 'retarget-argument', 'legacy-record']),
})
export type PoolActivityEvent = Schema.Schema.Type<typeof PoolActivityEvent>
export const PoolActivity = Schema.Struct({
  generation: Schema.Finite,
  commit: Schema.String,
  identity: Schema.String,
  phase: Schema.Literals([
    'birth-ready', 'birth-failed', 'claim-active', 'claim-completed', 'claim-failed',
    'release-ready', 'release-failed', 'retarget-ready', 'retarget-failed',
  ]),
  event: PoolActivityEvent,
  claimed: Schema.optional(PoolActivityEvent),
  completed: Schema.optional(PoolActivityEvent),
})
export type PoolActivity = Schema.Schema.Type<typeof PoolActivity>
const RetirementIntent = Schema.Struct({
  fromGeneration: Schema.Finite,
  identity: Schema.String,
  nonce: Schema.String,
  activity: PoolActivity,
  status: Schema.Literals(['pending', 'failed']),
  adminDir: Schema.optional(Schema.String),
})
/** Authoritative records: uncertain generations are never implicitly recovered. */
export const PoolSlot = Schema.Struct({
  ...PoolSlotV1.fields,
  state: Schema.Union([PoolSlotV1.fields.state, Schema.Literal('reserved')]),
  reservation: Schema.optional(Schema.String),
  initialPreparation: Schema.optional(Schema.Struct({ generation: Schema.Finite, commit: Schema.String })),
  sourceHistory: Schema.NonEmptyArray(Schema.String),
  retarget: Schema.optional(RetargetIntent),
  activity: Schema.optional(PoolActivity),
  retirement: Schema.optional(RetirementIntent),
  executionRoot: Schema.optional(Schema.Struct({
    origin: Schema.Literal('fresh-reserved-uuid'),
    authored: Schema.Boolean,
  })),
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

const validActivityEvent = (event: PoolActivityEvent) => {
  const observed = Date.parse(event.observedAtUtc)
  return Number.isFinite(observed) && new Date(observed).toISOString() === event.observedAtUtc &&
    Number.isSafeInteger(event.provider.pid) && event.provider.pid > 0 &&
    (event.provider.uid === undefined || (Number.isSafeInteger(event.provider.uid) && event.provider.uid >= 0)) &&
    (event.provider.processStartTime === undefined || /^\d+$/u.test(event.provider.processStartTime)) &&
    (event.ownerLabelOrigin !== 'none' || event.ownerLabel === '')
}

export const validPoolActivity = (slot: PoolSlot) => {
  const activity = slot.activity
  if (activity === undefined) return true
  const expected = activity.phase.endsWith('-ready') ? 'ready' :
    activity.phase === 'claim-active' ? 'leased' : activity.phase === 'claim-completed' ? 'completed' : 'quarantined'
  if (activity.generation !== slot.generation || activity.commit !== slot.commit || activity.identity !== slot.identity ||
    validActivityEvent(activity.event) === false ||
    (activity.claimed !== undefined && validActivityEvent(activity.claimed) === false) ||
    (activity.completed !== undefined && validActivityEvent(activity.completed) === false) ||
    (slot.state !== expected && slot.state !== 'quarantined') ||
    (slot.state === 'ready' && (slot.token !== '' || slot.owner !== '' || slot.chargeKnown !== true)) ||
    (slot.initialPreparation !== undefined && activity.phase !== 'birth-failed') ||
    (slot.retarget !== undefined && activity.phase !== 'retarget-failed') ||
    (activity.phase.endsWith('-ready') && activity.identity === '')) return false
  if (activity.completed !== undefined && activity.claimed === undefined) return false
  if (activity.claimed !== undefined && (activity.claimed.ownerLabelOrigin !== 'claim-argument' ||
    activity.completed !== undefined && (activity.completed.ownerLabelOrigin !== 'claim-argument' ||
      activity.completed.ownerLabel !== activity.claimed.ownerLabel))) return false
  if (activity.phase.startsWith('birth-')) return slot.generation === 1 && slot.sourceHistory.length === 1 &&
    activity.event.ownerLabelOrigin === 'none' && activity.claimed === undefined && activity.completed === undefined
  if (activity.phase.startsWith('retarget-')) return slot.sourceHistory.length >= 2 &&
    activity.event.ownerLabelOrigin === 'retarget-argument' && activity.claimed === undefined && activity.completed === undefined
  if (activity.phase === 'claim-active') return activity.claimed !== undefined && activity.completed === undefined &&
    activity.event.ownerLabelOrigin === 'claim-argument' && activity.event.ownerLabel === slot.owner &&
    activity.claimed.ownerLabel === slot.owner
  if (activity.phase === 'claim-completed') return activity.event.ownerLabel === slot.owner &&
    (activity.claimed === undefined
      ? activity.completed === undefined && activity.event.ownerLabelOrigin === 'legacy-record'
      : activity.completed !== undefined && activity.event.ownerLabelOrigin === 'claim-argument' &&
        activity.event.ownerLabel === activity.claimed.ownerLabel)
  if (activity.phase === 'release-ready') return activity.claimed === undefined
    ? activity.completed === undefined && activity.event.ownerLabelOrigin === 'legacy-record'
    : activity.event.ownerLabelOrigin === 'claim-argument' && activity.event.ownerLabel === activity.claimed.ownerLabel
  return true
}

export const poolActivityProviderRecorded = (event: PoolActivityEvent) =>
  event.provider.uid !== undefined && event.provider.processStartTime !== undefined
export type PoolTerminalRootActivity = {
  readonly kind: 'birth' | 'claim-release'
  readonly observedAtUtc: string
}
/** Derive observations only after the caller validates canonical source/epoch/install binding. */
export const poolTerminalRootActivity = (activity: PoolActivity): PoolTerminalRootActivity | undefined => {
  if (poolActivityProviderRecorded(activity.event) === false) return undefined
  if (activity.phase === 'birth-ready')
    return { kind: 'birth', observedAtUtc: activity.event.observedAtUtc }
  if (activity.phase === 'release-ready' && activity.claimed !== undefined && activity.completed !== undefined &&
    poolActivityProviderRecorded(activity.claimed) === true && poolActivityProviderRecorded(activity.completed) === true &&
    Date.parse(activity.claimed.observedAtUtc) <= Date.parse(activity.completed.observedAtUtc) &&
    Date.parse(activity.completed.observedAtUtc) <= Date.parse(activity.event.observedAtUtc))
    return { kind: 'claim-release', observedAtUtc: activity.event.observedAtUtc }
  return undefined
}
export const isPoolReadyUnclaimed = (slot: PoolSlot) =>
  slot.state === 'ready' && slot.chargeKnown === true && slot.identity !== '' && slot.barrierToken !== '' &&
  slot.owner === '' && slot.token === '' && slot.reservation === undefined &&
  slot.initialPreparation === undefined && slot.retarget === undefined && slot.retirement === undefined

const validPoolRetirement = (slot: PoolSlot) => {
  const intent = slot.retirement
  if (intent === undefined) return true
  return slot.state === 'quarantined' && slot.chargeKnown === false &&
    slot.identity === '' && slot.token === '' && slot.owner === '' && slot.barrierToken !== '' &&
    slot.reservation === undefined && slot.initialPreparation === undefined && slot.retarget === undefined &&
    slot.activity === undefined && Number.isSafeInteger(intent.fromGeneration) &&
    intent.fromGeneration >= 1 && slot.generation === intent.fromGeneration + 1 &&
    intent.identity !== '' && intent.nonce !== '' &&
    (intent.adminDir === undefined || intent.adminDir.startsWith('/') && resolve(intent.adminDir) === intent.adminDir) &&
    validPoolActivity({
      ...slot, generation: intent.fromGeneration, identity: intent.identity, chargeKnown: true,
      state: 'ready', retirement: undefined, activity: intent.activity,
    }) === true && poolTerminalRootActivity(intent.activity) !== undefined
}

/** Pure one-generation revocation; only the owner may persist it before calling its remover. */
export const beginPoolRetirement = ({
  slot, generation, identity,
}: { slot: PoolSlot; generation: number; identity: string }): Effect.Effect<PoolSlot, PoolError> => {
  const activity = slot.activity
  if (isPoolReadyUnclaimed(slot) === false || activity === undefined ||
    validPoolActivity(slot) === false || poolTerminalRootActivity(activity) === undefined || slot.generation !== generation ||
    slot.identity !== identity || generation < 1 || Number.isSafeInteger(generation + 1) === false)
    return Effect.fail(new PoolError({ message: 'Stale, unrecorded or non-ready retirement target' }))
  return Effect.succeed<PoolSlot>({
    ...slot, generation: generation + 1, state: 'quarantined', chargeKnown: false,
    identity: '', token: '', owner: '', activity: undefined, reason: 'retirement incomplete',
    retirement: {
      fromGeneration: generation, identity, nonce: randomUUID(), activity, status: 'pending',
    },
  })
}

/** Disposal authority follows this physical root, never a copied canonical destination. */
export const requireDisposablePoolRoot = (slot: PoolSlot): Effect.Effect<void, PoolError> =>
  slot.executionRoot?.origin === 'fresh-reserved-uuid' && slot.executionRoot.authored === false
    ? Effect.void
    : Effect.fail(new PoolError({ message: 'Authored or unproven pool root retained; reset forbidden' }))

/** Persist this irreversible marker before any in-place authoring or promotion handoff. */
export const markPoolRootAuthored = (slot: PoolSlot): Effect.Effect<PoolSlot, PoolError> =>
  slot.executionRoot === undefined
    ? Effect.fail(new PoolError({ message: 'Unproven pool root cannot gain execution provenance' }))
    : Effect.succeed<PoolSlot>({
        ...slot, executionRoot: { ...slot.executionRoot, authored: true },
        reason: 'Root entered authoring; reset forbidden',
      })

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
          validPoolActivity(slot) === false ||
          validPoolRetirement(slot) === false ||
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
          (slot.initialPreparation !== undefined &&
            (['preparing', 'quarantined'].includes(slot.state) === false ||
              slot.initialPreparation.generation !== slot.generation ||
              slot.initialPreparation.commit !== slot.commit ||
              slot.generation !== 1 ||
              slot.sourceHistory.length !== 1 ||
              slot.reservation !== undefined ||
              slot.retarget !== undefined ||
              slot.identity !== '' ||
              slot.token !== '' ||
              slot.owner !== '' ||
              slot.chargeKnown !== false)) ||
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

/** Internal real-filesystem fault seam, after rename and before the actual directory sync. */
export class PoolDirectorySyncObserver extends Context.Service<
  PoolDirectorySyncObserver, (directory: FileHandle) => Promise<void>
>()('megarepo/PoolDirectorySyncObserver') {}

/** Fsync both contents and rename: readiness/ownership must survive process loss. */
const persist = ({ path, state }: { path: string; state: PoolState }) =>
  Effect.gen(function* () {
    yield* validatePoolState(state)
    const contents = yield* Schema.encodeEffect(Schema.fromJsonString(PoolState), {
      onExcessProperty: 'error',
    })(state)
    const observer = yield* Effect.serviceOption(PoolDirectorySyncObserver)
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
        if (Option.isSome(observer)) await observer.value(directory)
        await directory.sync()
      } finally {
        await directory.close()
      }
    })
  }).pipe(
    Effect.mapError((cause) => new PoolError({ message: `Pool persistence failed: ${cause}` })),
    Effect.uninterruptible,
  )

const decodePoolState = Schema.decodeEffect(Schema.fromJsonString(PoolStateReader), {
  onExcessProperty: 'error',
})
const currentPoolState = (stored: Schema.Schema.Type<typeof PoolStateReader>): PoolState =>
  stored.version === 1
    ? { ...stored, version: 2, slots: stored.slots.map((slot): PoolSlot => ({ ...slot, sourceHistory: [slot.commit] })) }
    : stored

/** Atomic observation only; no initialization, migration writes, recovery or lifecycle exclusion. */
export const readPoolState = ({ base }: { base: AbsoluteDirPath }): Effect.Effect<
  PoolState, PoolError | PlatformError | Schema.SchemaError, FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const state = currentPoolState(yield* fs.readFileString(`${base}/.state/pool/state.json`).pipe(Effect.flatMap(decodePoolState)))
    yield* validatePoolState(state)
    return state
  })

/** Missing authority is not permission to forget roots, native registrations or durable barriers. */
const assertInitialPoolInventory = (base: AbsoluteDirPath): Effect.Effect<
  void, PoolError | PlatformError | Schema.SchemaError | Git.GitCommandError,
  FileSystem.FileSystem | ChildProcessSpawner
> => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  if ((yield* hasPersistentDeletionLeases({ storeBasePath: base })) === true)
    return yield* new PoolError({ message: 'Missing pool authority: persistent or unknown deletion barriers retained' })
  const repos = yield* Effect.flatMap(Store, (store) => store.listRepos).pipe(
    Effect.provide(makeStoreLayer({ basePath: base })),
  )
  for (const repo of repos) {
    const poolDirectory = resolve(yield* fs.realPath(repo.fullPath), 'pool')
    if ((yield* fs.readDirectory(repo.fullPath)).includes('pool') === true &&
      ((yield* isStoreDirectory({ fs, path: poolDirectory })) === false ||
        (yield* fs.readDirectory(poolDirectory)).length !== 0))
      return yield* new PoolError({ message: `Missing pool authority: existing or unknown roots retained at ${poolDirectory}` })
    const registrations = yield* Git.listWorktrees(
      EffectPath.ops.join(repo.fullPath, EffectPath.unsafe.relativeDir('.bare/')),
    )
    if (registrations.some((entry) => {
      const path = entry.path.replace(/\/+$/u, '')
      return path === poolDirectory || path.startsWith(`${poolDirectory}/`) ||
        Option.getOrUndefined(entry.lockReason)?.startsWith('mr-pool:') === true
    }) === true)
      return yield* new PoolError({ message: 'Missing pool authority: native pool registrations retained' })
  }
})

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
}): Effect.Effect<
  A, E | PoolError | PlatformError | Schema.SchemaError | Git.GitCommandError | DeletionLeaseUnavailableError,
  R | FileSystem.FileSystem | ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(`${base}/.state/pool`, { recursive: true })
    const directory = yield* fs.realPath(`${base}/.state/pool`)
    return yield* Effect.gen(function* () {
      const path = `${directory}/state.json`
      const exists = yield* fs.exists(path)
      const stored =
        exists === true
          ? yield* fs.readFileString(path).pipe(Effect.flatMap(decodePoolState))
          : {
              version: 2 as const,
              maxSlots: limits?.maxSlots ?? 0,
              maxBytes: limits?.maxBytes ?? 0,
              slots: [],
            }
      const state = currentPoolState(stored)
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
      if (exists === false) yield* assertInitialPoolInventory(base)
      let current = state
      return yield* use(state, (next) => Effect.gen(function* () {
        for (const slot of next.slots) {
          const previous = current.slots.find((item) => item.id === slot.id)
          if (
            (previous !== undefined && previous.executionRoot === undefined && slot.executionRoot !== undefined) ||
            (previous?.executionRoot !== undefined &&
              (slot.executionRoot === undefined ||
                slot.executionRoot.origin !== previous.executionRoot.origin ||
                slot.path !== previous.path ||
                slot.bare !== previous.bare ||
                (previous.executionRoot.authored === true && slot.executionRoot.authored !== true))) ||
            (previous === undefined && slot.executionRoot !== undefined &&
              (slot.state !== 'reserved' || slot.generation !== 0 || slot.executionRoot.authored !== false))
          )
            return yield* new PoolError({ message: 'Execution-root provenance is immutable and authoring is irreversible' })
        }
        yield* persist({ path, state: next })
        current = next
      }))
    }).pipe(withDeletionLease({ storeBasePath: base, ownerPath: directory, now: Date.now() }))
  })

const equivalentPoolSlot = Schema.toEquivalence(PoolSlot)

/** One short CAS epoch; callers retain the root action fence while physical work runs outside it. */
export const replacePoolSlot = <Next extends PoolSlot | undefined>({
  base, expected, next,
}: { base: AbsoluteDirPath; expected: PoolSlot; next: Next }): Effect.Effect<
  Next, PoolError | PlatformError | Schema.SchemaError | Git.GitCommandError | DeletionLeaseUnavailableError,
  FileSystem.FileSystem | ChildProcessSpawner
> =>
  withPoolState({
    base,
    use: (state, save) => Effect.gen(function* () {
      const current = state.slots.find((slot) => slot.id === expected.id)
      if (current === undefined || equivalentPoolSlot(current, expected) === false ||
        (next !== undefined && (next.id !== expected.id || next.path !== expected.path || next.bare !== expected.bare)))
        return yield* new PoolError({ message: 'Stale pool slot epoch; current authority retained' })
      // Always merge into this epoch's authoritative ledger, never a previously captured array.
      yield* save({ ...state, slots: next === undefined
        ? state.slots.filter((slot) => slot.id !== expected.id)
        : state.slots.map((slot) => slot.id === expected.id ? next : slot) })
      return next
    }),
  })

/**
 * Retain one native root action lock across physical work, never the global ledger lock.
 * The callback is invoked once; conflict never replays a subprocess or mutation.
 */
export const withPoolSlotOperation = <A, E, R>({
  base, select, use,
}: {
  base: AbsoluteDirPath
  select: string | ((slot: PoolSlot) => boolean)
  use: (
    state: PoolState,
    save: (next: PoolState) => Effect.Effect<
      void, PoolError | PlatformError | Schema.SchemaError | Git.GitCommandError | DeletionLeaseUnavailableError,
      FileSystem.FileSystem | ChildProcessSpawner
    >,
    selected: PoolSlot,
  ) => Effect.Effect<A, E, R>
}): Effect.Effect<
  A, E | PoolError | PlatformError | Schema.SchemaError | Git.GitCommandError |
    DeletionLeaseUnavailableError | GitWriterLockError,
  R | FileSystem.FileSystem | ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const before = yield* readPoolState({ base })
    const selected = before.slots.find(
      typeof select === 'string' ? (slot) => slot.id === select : select,
    )
    if (selected === undefined) return yield* new PoolError({ message: 'No matching pool slot' })
    return yield* Effect.gen(function* () {
      const state = yield* readPoolState({ base })
      const current = state.slots.find((slot) => slot.id === selected.id)
      if (current === undefined || equivalentPoolSlot(current, selected) === false)
        return yield* new PoolError({ message: 'Selected pool root changed before action admission' })
      let expected: PoolSlot | undefined = current
      const others = new Map(state.slots.filter((slot) => slot.id !== selected.id).map((slot) => [slot.id, slot]))
      const save = (next: PoolState) => Effect.gen(function* () {
        yield* validatePoolState(next)
        if (expected === undefined || next.version !== state.version ||
          next.maxSlots !== state.maxSlots || next.maxBytes !== state.maxBytes ||
          next.slots.filter((slot) => slot.id !== selected.id).length !== others.size ||
          next.slots.some((slot) => slot.id !== selected.id && others.get(slot.id) !== slot))
          return yield* new PoolError({ message: 'Root action cannot alter other slots or host limits' })
        const replacement = next.slots.find((slot) => slot.id === selected.id)
        const previous = expected
        yield* replacePoolSlot({ base, expected, next: replacement }).pipe(
          Effect.catchCause((original) => Effect.gen(function* () {
            // Rename may have committed before directory fsync failed. Recover custody,
            // not success, and never assume a missing record authorizes resurrection.
            const reconciled = yield* withPoolState({
              base, use: (current) => Effect.succeed(current.slots.find((slot) => slot.id === selected.id)),
            }).pipe(Effect.exit)
            if (Exit.isFailure(reconciled))
              return yield* Effect.failCause(Cause.combine(original, reconciled.cause))
            const current = reconciled.value
            expected = current !== undefined &&
              (equivalentPoolSlot(current, previous) ||
                (replacement !== undefined && equivalentPoolSlot(current, replacement)))
              ? current : undefined
            return yield* Effect.failCause(original)
          }).pipe(Effect.uninterruptible)),
        )
        expected = replacement
      })
      return yield* use(state, save, current)
    }).pipe(withPoolWorktreeOperationLock({
      storeBasePath: base, barePath: selected.bare, path: selected.path, id: selected.id,
    }))
  })

/** Failure retention must never replace the operation's original failure. */
export const retainPoolFailure =
  <E2, R2>(retain: (reason: string) => Effect.Effect<void, E2, R2>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | E2, R | R2> =>
    effect.pipe(Effect.catchCause((original) => Effect.gen(function* () {
      const retained = yield* retain(Cause.pretty(original)).pipe(Effect.exit)
      if (Exit.isFailure(retained))
        return yield* Effect.failCause(Cause.combine(original, retained.cause))
      return yield* Effect.failCause(original)
    }).pipe(Effect.uninterruptible)))

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
    activity: undefined,
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
      executionRoot: { origin: 'fresh-reserved-uuid', authored: false },
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
        activity: undefined,
        generation: generation + 1,
        initialPreparation: { generation: generation + 1, commit },
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
    activity: undefined,
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
    activity: undefined,
  })
}
