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
  charge: Schema.Number,
  chargeKnown: Schema.optional(Schema.Boolean),
  generation: Schema.Number,
  state: Schema.Literals(['preparing', 'ready', 'leased', 'completed', 'quarantined']),
  token: Schema.String,
  barrierToken: Schema.String,
  owner: Schema.String,
  reason: Schema.String,
})
export type PoolSlot = Schema.Schema.Type<typeof PoolSlot>
const PoolState = Schema.Struct({
  version: Schema.Literal(1),
  maxSlots: Schema.Number,
  maxBytes: Schema.Number,
  slots: Schema.Array(PoolSlot),
})
export type PoolState = Schema.Schema.Type<typeof PoolState>

export class PoolError extends Schema.TaggedError<PoolError>()('PoolError', {
  message: Schema.String,
}) {}

/** Fsync both contents and rename: readiness/ownership must survive process loss. */
const persist = (path: string, state: PoolState) =>
  Effect.tryPromise(async () => {
    const temporary = `${path}.${randomUUID()}`
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(JSON.stringify(state))
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
  }).pipe(
    Effect.mapError((cause) => new PoolError({ message: `Pool persistence failed: ${cause}` })),
    Effect.uninterruptible,
  )

/** One host-store-wide exclusion point, including capacity reservation. No TTL takeover. */
export const withPoolState = <A, E, R>(
  base: AbsoluteDirPath,
  use: (
    state: PoolState,
    save: (next: PoolState) => Effect.Effect<void, PoolError>,
  ) => Effect.Effect<A, E, R>,
  limits?: { maxSlots: number; maxBytes: number },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(`${base}/.state/pool`, { recursive: true })
    const directory = yield* fs.realPath(`${base}/.state/pool`)
    return yield* Effect.gen(function* () {
      const path = `${directory}/state.json`
      const exists = yield* fs.exists(path)
      const state = exists
        ? yield* fs
            .readFileString(path)
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(PoolState))))
        : {
            version: 1 as const,
            maxSlots: limits?.maxSlots ?? 0,
            maxBytes: limits?.maxBytes ?? 0,
            slots: [],
          }
      if (
        limits !== undefined &&
        exists &&
        (limits.maxSlots !== state.maxSlots || limits.maxBytes !== state.maxBytes)
      )
        return yield* new PoolError({
          message: 'Pool limits are host-wide and immutable while records exist',
        })
      if (
        !Number.isSafeInteger(state.maxSlots) ||
        state.maxSlots <= 0 ||
        !Number.isSafeInteger(state.maxBytes) ||
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
            !Number.isSafeInteger(slot.charge) ||
            slot.charge <= 0 ||
            !Number.isSafeInteger(slot.generation) ||
            slot.generation < 0,
        )
      )
        return yield* new PoolError({
          message: 'Invalid authoritative pool ownership/accounting records',
        })
      return yield* use(state, (next) => persist(path, next))
    }).pipe(withDeletionLease({ storeBasePath: base, ownerPath: directory, now: Date.now() }))
  })

/** Pure generation fence; a token can authorize only its original claim. */
export const requirePoolLease = (slot: PoolSlot, token: string, generation: number) =>
  (slot.state === 'leased' || slot.state === 'completed') &&
  slot.token === token &&
  slot.generation === generation
    ? Effect.void
    : Effect.fail(new PoolError({ message: 'Stale or non-leased pool generation' }))

/** Transition is published only under withPoolState after real root proofs. */
export const claimPoolGeneration = (slot: PoolSlot, identity: string, owner: string) => {
  if (slot.state !== 'ready' || slot.identity !== identity)
    return Effect.fail(
      new PoolError({ message: 'Generation is not ready for this install identity' }),
    )
  const next: PoolSlot = {
    ...slot,
    state: 'leased',
    generation: slot.generation + 1,
    token: randomUUID(),
    owner,
    reason: '',
  }
  return Effect.succeed(next)
}

export const reservePoolSlot = (state: PoolState, slot: PoolSlot) => {
  if (state.slots.some((item) => item.chargeKnown !== true))
    return Effect.fail(
      new PoolError({ message: 'Pool retained bytes are unknown; allocation blocked' }),
    )
  if (
    !Number.isSafeInteger(slot.charge) ||
    slot.charge <= 0 ||
    state.slots.length >= state.maxSlots ||
    state.slots.reduce((sum, item) => sum + item.charge, 0) + slot.charge > state.maxBytes
  )
    return Effect.fail(
      new PoolError({ message: 'Host-wide pool capacity exhausted or invalid charge' }),
    )
  return Effect.succeed({ ...state, slots: [...state.slots, slot] })
}
