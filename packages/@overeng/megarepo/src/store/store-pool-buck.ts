import { join } from 'node:path'

import { Effect, Option } from 'effect'
import * as FileSystem from 'effect/FileSystem'

import { type BuckDaemonResult } from './store-buck-daemons.ts'
import { poolBytes } from './store-pool-install.ts'
import { requireOutsidePoolGlobal } from './store-pool-lock-order.ts'
import { PoolError, type PoolSlot, requireDisposablePoolRoot } from './store-pool-state.ts'

/** Size observation only, never permission to preserve, wipe, reset or publish READY. */
export interface PoolBuckResetObservation {
  readonly disposition: 'absent' | 'within-bound' | 'over-bound'
  readonly logicalBytes: number
  readonly allocatedBytes: number
  readonly maxBytes: number
}

/** Pure receipt veto, not proof of quiescence; final actual all-UID evidence is mandatory. */
export const requirePoolBuckDrain = (results: ReadonlyArray<BuckDaemonResult>) =>
  results.some((result) => result._tag !== 'stopped' || result.raced !== undefined) === true
    ? Effect.fail(
        new PoolError({
          message: 'Pool prewarm Buck shutdown is active, unreachable or raced; HOLD',
        }),
      )
    : Effect.void

/** Caller retains ROOT; acting on this observation also needs actual pins, drained daemons,
 * normal Buck configuration and fresh source/lease/all-UID proof. No template copying.
 * Zero is a deliberate wipe-on-reset bound for matched warm-versus-wiped measurements.
 */
export const inspectPoolBuckReset = ({ slot, maxBytes }: { slot: PoolSlot; maxBytes: number }) =>
  Effect.gen(function* () {
    yield* requireOutsidePoolGlobal(
      () => new PoolError({ message: 'Buck observation inside GLOBAL; HOLD' }),
    )
    yield* requireDisposablePoolRoot(slot)
    if (Number.isSafeInteger(maxBytes) === false || maxBytes < 0)
      return yield* new PoolError({
        message: 'Configured Buck reset bound must be nonnegative safe bytes; HOLD',
      })
    const fs = yield* FileSystem.FileSystem
    if ((yield* fs.realPath(slot.path)) !== slot.path)
      return yield* new PoolError({ message: 'Pool root is not canonical; HOLD' })
    const path = join(slot.path, 'buck-out')
    const info = yield* fs.lstat(path).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === 'NotFound',
        () => Effect.void,
      ),
    )
    if (info === undefined) {
      const absent: PoolBuckResetObservation = {
        disposition: 'absent',
        logicalBytes: 0,
        allocatedBytes: 0,
        maxBytes,
      }
      return absent
    }
    if (
      info.type !== 'Directory' ||
      process.getuid === undefined ||
      Option.getOrUndefined(info.uid) !== process.getuid() ||
      (yield* fs.realPath(path)) !== path
    )
      return yield* new PoolError({
        message: 'Buck state is not an owned canonical directory; HOLD',
      })
    const logicalBytes = yield* poolBytes({ path, kind: 'logical' })
    const allocatedBytes = yield* poolBytes({ path, kind: 'allocated' })
    const current = yield* fs.lstat(path)
    if (
      current.type !== 'Directory' ||
      Option.getOrUndefined(current.uid) !== process.getuid() ||
      (yield* fs.realPath(path)) !== path
    )
      return yield* new PoolError({ message: 'Buck state changed during accounting; HOLD' })
    const observation: PoolBuckResetObservation = {
      disposition:
        Math.max(logicalBytes, allocatedBytes) > maxBytes ? 'over-bound' : 'within-bound',
      logicalBytes,
      allocatedBytes,
      maxBytes,
    }
    return observation
  })
