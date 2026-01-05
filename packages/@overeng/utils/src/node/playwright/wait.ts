/**
 * Generic "poll until ready" helpers for Playwright tests.
 *
 * Prefer these over `while` loops with `page.waitForTimeout()`:
 * - easier to reason about timeouts and retry conditions
 * - spans/attributes for observability
 * - avoids accidental `await` chains spread across test logic
 *
 * @module
 */

import { type Duration, Effect, Schedule, Schema } from 'effect'

export class PwWaitTimeoutError extends Schema.TaggedError<PwWaitTimeoutError>(
  'PwWaitTimeoutError',
)('PwWaitTimeoutError', {
  label: Schema.String,
  timeout: Schema.String,
}) {}

const hasTag = (error: unknown): error is { _tag: string } => {
  if (typeof error !== 'object' || error === null) return false
  return typeof (error as Record<string, unknown>)._tag === 'string'
}

const errorTag = (error: unknown) => (hasTag(error) ? error._tag : undefined)

const errorType = (error: unknown) => {
  if (typeof error === 'object' && error !== null) {
    return (error as { constructor?: { name?: string } }).constructor?.name ?? 'Object'
  }
  return typeof error
}

/**
 * Repeatedly runs `check` until it succeeds, retrying while `while` returns true.
 *
 * The typical pattern is: have `check` fail with a small tagged error (e.g. `{ _tag: 'NotReady' }`)
 * to indicate "keep waiting" and return success when the desired condition is met.
 */
export const until = <TResult, TError, TContext>(args: {
  /** Span/trace label for this polling loop (use a stable identifier). */
  label: string
  /** Effect to evaluate; should succeed when ready and fail with a retryable error when not ready. */
  check: Effect.Effect<TResult, TError, TContext>
  /** Delay between retry attempts. */
  pollInterval: Duration.DurationInput
  /** Maximum time to wait before failing with `PwWaitTimeoutError`. */
  timeout: Duration.DurationInput
  /** Predicate that decides whether to retry for a given error value. */
  while: (error: TError) => boolean
}): Effect.Effect<TResult, TError | PwWaitTimeoutError, TContext> => {
  const { label, check, pollInterval, timeout, while: while_ } = args

  return Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan({
      'pw.wait.label': label,
      'pw.wait.pollInterval': String(pollInterval),
      'pw.wait.timeout': String(timeout),
    })

    let attempt = 0

    const checkWithTelemetry = Effect.gen(function* () {
      attempt += 1
      yield* Effect.annotateCurrentSpan({ 'pw.wait.attempt': attempt })
      return yield* check
    }).pipe(
      Effect.tapError((error) =>
        Effect.logDebug('pw.wait.retry', {
          'pw.wait.label': label,
          'pw.wait.attempt': attempt,
          'pw.wait.error.tag': errorTag(error as unknown) ?? '',
          'pw.wait.error.type': errorType(error as unknown),
        }),
      ),
    )

    return yield* checkWithTelemetry.pipe(
      Effect.retry({ schedule: Schedule.spaced(pollInterval), while: while_ }),
      Effect.timeoutFail({
        duration: timeout,
        onTimeout: () => new PwWaitTimeoutError({ label, timeout: String(timeout) }),
      }),
    )
  }).pipe(Effect.withSpan('pw.wait.until'))
}
