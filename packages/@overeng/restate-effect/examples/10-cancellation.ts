/**
 * Cancellation ↔ interruption.
 *
 * When an invocation is cancelled (via `Restate.cancel`, ingress, or the admin
 * API), the cancellation surfaces inside the handler as an Effect INTERRUPTION at
 * the next durable await point. So ordinary Effect finalizers run before the
 * attempt unwinds: `acquireRelease` releases, `onInterrupt` fires, saga
 * compensations run. The boundary then maps the interruption to a `CancelledError`
 * — neither a domain failure nor a defect, and NOT retried.
 *
 * This is the mechanism the (future) first-class saga helper is built on; today
 * you express compensations by hand with `Restate.run` + Effect finalizers.
 *
 * The cancel→finalizer→no-retry behavior is verified end-to-end by
 * `src/cancellation.integration.test.ts`.
 */
import { Effect, Schema } from 'effect'

import { Restate, RestateObject } from '../src/mod.ts'

export const Job = RestateObject.contract('cancellable-job', {
  state: {},
  handlers: {
    run: { input: Schema.Void, success: Schema.Void },
  },
})

export const JobLive = RestateObject.implement<typeof Job>(Job, {
  run: () =>
    Effect.gen(function* () {
      /* Acquire a resource; the RELEASE runs on success, error, OR interruption —
       * including a Restate cancellation that interrupts the durable wait below. */
      yield* Effect.acquireRelease(Effect.logInfo('acquired external resource'), () =>
        Effect.logInfo('released external resource (runs on cancel too)'),
      )
      /* A long durable timer: the invocation durably suspends here. A cancellation
       * interrupts the fiber at this point → the release above runs → the boundary
       * terminalizes a `CancelledError` (no silent retry). */
      yield* Restate.sleep(60_000, 'long-wait').pipe(Effect.orDie)
    }).pipe(Effect.scoped, Effect.orDie),
})

/** Cancel ANOTHER invocation cooperatively (the target surfaces an interruption
 * so its finalizers run). Requires `RestateContext` — call it from a handler. */
export const cancelOther = (invocationId: string) => Restate.cancel(invocationId)
