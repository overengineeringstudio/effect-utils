/// <reference lib="dom" />

/**
 * Web Locks API utilities with Effect integration.
 * Provides cross-tab coordination using the browser's Web Locks API.
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API
 */

import type { Exit } from 'effect'
import { Deferred, Effect, Runtime, Schema } from 'effect'

/**
 * Error thrown when Web Locks API is not supported.
 */
export class WebLockNotSupportedError extends Schema.TaggedError<WebLockNotSupportedError>()(
  'WebLockNotSupportedError',
  {
    message: Schema.String,
  },
) {
  static readonly notAvailable = new WebLockNotSupportedError({
    message: 'Web Locks API is not available: navigator.locks is undefined',
  })
}

/**
 * Checks if Web Locks API is supported in the current environment.
 */
export const isWebLocksSupported = (): boolean =>
  typeof navigator !== 'undefined' && navigator.locks !== undefined

/**
 * Wraps an Effect with a named lock.
 * The effect will only execute once the lock is acquired.
 */
export const withLock =
  <E2>(lockOptions: {
    lockName: string
    onTaken?: Effect.Effect<void, E2>
    options?: Omit<LockOptions, 'signal'>
  }) =>
  <Ctx, E, A>(eff: Effect.Effect<A, E, Ctx>): Effect.Effect<A | undefined, E | E2, Ctx> => {
    const { lockName, onTaken, options } = lockOptions
    return Effect.gen(function* () {
      if (!isWebLocksSupported()) {
        return yield* Effect.fail(WebLockNotSupportedError.notAvailable) as Effect.Effect<
          never,
          E | E2
        >
      }

      const runtime = yield* Effect.runtime<Ctx>()

      const exit = yield* Effect.tryPromise<Exit.Exit<A, E> | undefined, E | E2>({
        try: async (signal) => {
          if (signal.aborted) throw new Error('Aborted')

          // NOTE The 'signal' and 'ifAvailable' options cannot be used together.
          const requestOptions = options?.ifAvailable === true ? options : { ...options, signal }

          const result = await navigator.locks.request(lockName, requestOptions, async (lock) => {
            if (lock === null) {
              if (onTaken) {
                const onTakenExit = await Runtime.runPromiseExit(runtime)(onTaken)
                if (onTakenExit._tag === 'Failure') {
                  return onTakenExit as unknown as Exit.Exit<A, E>
                }
              }
              return undefined
            }

            return await Runtime.runPromiseExit(runtime)(eff)
          })

          return result
        },
        catch: (err) => err as E,
      })

      if (exit === undefined) {
        return undefined
      }

      if (exit._tag === 'Failure') {
        return yield* Effect.failCause(exit.cause)
      }

      return exit.value
    })
  }

/** Waits to acquire an exclusive lock, holding it until the deferred resolves. */
export const waitForDeferredLock = (opts: {
  deferred: Deferred.Deferred<void>
  lockName: string
}): Effect.Effect<void, WebLockNotSupportedError> => {
  const { deferred, lockName } = opts
  return Effect.suspend(() => {
    if (!isWebLocksSupported()) {
      return Effect.fail(WebLockNotSupportedError.notAvailable)
    }

    return Effect.async<void>((cb, signal) => {
      if (signal.aborted) return

      navigator.locks
        .request(lockName, { signal, mode: 'exclusive', ifAvailable: false }, (_lock) => {
          // Immediately continue calling Effect since we have the lock
          cb(Effect.void)

          // Hold lock until deferred is resolved
          return Effect.runPromise(Deferred.await(deferred))
        })
        .catch((error: DOMException) => {
          if (error.code === 20 && error.message === 'signal is aborted without reason') {
            // Signal interruption is handled via Effect, ignore
          } else {
            throw error
          }
        })
    })
  })
}

/** Attempts to acquire a lock if available. Returns true if lock was acquired. */
export const tryGetDeferredLock = (opts: {
  deferred: Deferred.Deferred<void>
  lockName: string
}): Effect.Effect<boolean, WebLockNotSupportedError> => {
  const { deferred, lockName } = opts
  return Effect.suspend(() => {
    if (!isWebLocksSupported()) {
      return Effect.fail(WebLockNotSupportedError.notAvailable)
    }

    return Effect.async<boolean>((cb, signal) => {
      navigator.locks.request(lockName, { mode: 'exclusive', ifAvailable: true }, (lock) => {
        cb(Effect.succeed(lock !== null))

        const abortPromise = new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve())
        })

        // Hold lock until deferred is resolved or aborted
        return Promise.race([Effect.runPromise(Deferred.await(deferred)), abortPromise])
      })
    })
  })
}

/** Forcefully acquires a lock using the steal option. Breaks any existing lock. */
export const stealDeferredLock = (opts: {
  deferred: Deferred.Deferred<void>
  lockName: string
}): Effect.Effect<boolean, WebLockNotSupportedError> => {
  const { deferred, lockName } = opts
  return Effect.suspend(() => {
    if (!isWebLocksSupported()) {
      return Effect.fail(WebLockNotSupportedError.notAvailable)
    }

    return Effect.async<boolean>((cb, signal) => {
      navigator.locks.request(lockName, { mode: 'exclusive', steal: true }, (lock) => {
        cb(Effect.succeed(lock !== null))

        const abortPromise = new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve())
        })

        // Hold lock until deferred is resolved or aborted
        return Promise.race([Effect.runPromise(Deferred.await(deferred)), abortPromise])
      })
    })
  })
}

/**
 * Waits for a shared lock to become available.
 * Multiple contexts can hold a shared lock simultaneously.
 *
 * @param lockName - Name of the lock to acquire
 */
export const waitForLock = (lockName: string): Effect.Effect<void, WebLockNotSupportedError> =>
  Effect.suspend(() => {
    if (!isWebLocksSupported()) {
      return Effect.fail(WebLockNotSupportedError.notAvailable)
    }

    return Effect.async<void>((cb, signal) => {
      if (signal.aborted) return

      navigator.locks.request(lockName, { mode: 'shared', signal, ifAvailable: false }, (_lock) => {
        cb(Effect.succeed(void 0))
      })
    })
  })

/**
 * Attempts to get an exclusive lock if available and waits for it to be stolen.
 * Useful for "leader election" patterns where one tab becomes the leader
 * until another tab steals the lock.
 *
 * @param lockName - Name of the lock
 */
export const getLockAndWaitForSteal = (
  lockName: string,
): Effect.Effect<void, WebLockNotSupportedError> =>
  Effect.suspend(() => {
    if (!isWebLocksSupported()) {
      return Effect.fail(WebLockNotSupportedError.notAvailable)
    }

    return Effect.async<void>((cb, signal) => {
      if (signal.aborted) return

      navigator.locks
        .request(lockName, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
          if (lock === null) {
            // Lock wasn't available, resolve immediately
            cb(Effect.succeed(void 0))
            return
          }

          // We got the lock, now wait for it to be stolen or aborted
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve())
          }).catch(() => {})

          cb(Effect.succeed(void 0))
        })
        .catch((error: DOMException) => {
          if (
            error.code === 20 &&
            (error.message === 'signal is aborted without reason' ||
              error.message === `Lock broken by another request with the 'steal' option.`)
          ) {
            // Signal interruption or lock stolen - handled via Effect
            cb(Effect.succeed(void 0))
          } else {
            console.error('WebLock.getLockAndWaitForSteal error:', error)
            throw error
          }
        })
    })
  })
