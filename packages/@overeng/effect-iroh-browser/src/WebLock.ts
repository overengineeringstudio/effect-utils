import { Effect, type Scope } from 'effect'

import { NotLeader } from './errors.ts'

/**
 * Holds the exclusiveLock Web Lock `name` for the lifetime of the scope, failing with
 * `NotLeader` if another tab holds it. Without Web Locks support it just succeeds.
 * Use it to make one tab the owner of a device-wide resource (e.g. the iroh identity).
 */
export const exclusiveLock = (name: string): Effect.Effect<void, NotLeader, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<(() => void) | void | 'busy'>((resume) => {
      if (typeof navigator === 'undefined' || !('locks' in navigator)) return resume(Effect.void)
      let cancelled = false
      let releaseLock: (() => void) | undefined
      void navigator.locks
        .request(name, { ifAvailable: true }, (lock) => {
          // A browser callback can already be queued when acquisition is interrupted.
          if (cancelled === true) return undefined
          if (lock === null) {
            resume(Effect.succeed('busy'))
            return undefined
          }
          // The lock is held until this promise settles, i.e. until the scope closes.
          const held = Promise.withResolvers<void>()
          releaseLock = held.resolve
          resume(Effect.succeed(held.resolve))
          return held.promise
        })
        .catch(() => resume(Effect.succeed('busy')))
      return Effect.sync(() => {
        cancelled = true
        releaseLock?.()
      })
    }).pipe(
      Effect.interruptible,
      Effect.filterOrFail(
        (release): release is (() => void) | void => release !== 'busy',
        () => new NotLeader(),
      ),
    ),
    (release) =>
      Effect.sync(() => {
        if (typeof release === 'function') release()
      }),
  ).pipe(Effect.asVoid)
