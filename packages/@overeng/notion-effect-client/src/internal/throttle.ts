import { Clock, Context, Duration, Effect, Layer, RateLimiter } from 'effect'

import { NotionRateLimitMetricBridges } from './metrics.ts'
import { annotateNotionRateLimitWaitSpan } from './otel.ts'

/** Options for the optional global Notion request throttle. */
export interface NotionThrottleOptions {
  /** Sustained request rate (tokens/sec). */
  readonly requestsPerSecond: number
  /** Token bucket capacity for short bursts (default 1). */
  readonly burst?: number
  /** Algorithm: 'token-bucket' (bursty) or 'fixed-window'. Default 'token-bucket'. */
  readonly algorithm?: 'token-bucket' | 'fixed-window'
}

/**
 * Optional global request throttle, shared across all Notion API calls made
 * through the client for the lifetime of the layer. Absent ⇒ no throttling
 * (per-request retries still apply).
 *
 * `apply` wraps one logical request (the whole retry loop) so a single token is
 * consumed per request, not per retry attempt.
 */
export class NotionThrottle extends Context.Service<
  NotionThrottle,
  { readonly apply: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R> }
>()('@overeng/notion-effect-client/NotionThrottle') {}

/**
 * Build a scoped {@link NotionThrottle} layer from an Effect-native
 * `RateLimiter` token bucket. The bucket spreads `requestsPerSecond` requests
 * over a 1-second window, releasing one token every `ceil(1000/rps)` ms (with
 * an optional `burst` of buffered tokens).
 */
export const NotionThrottleLive = (options: NotionThrottleOptions): Layer.Layer<NotionThrottle> =>
  Layer.scoped(
    NotionThrottle,
    Effect.gen(function* () {
      const limiter = yield* RateLimiter.make({
        limit: options.burst ?? 1,
        interval: Duration.millis(Math.ceil(1000 / options.requestsPerSecond)),
        algorithm: options.algorithm ?? 'token-bucket',
      })
      /**
       * Behavior-preserving wait instrumentation (decision 0017 Half 2, #775):
       * `limiter` still wraps `effect` exactly as before (token accounting and
       * pacing untouched), but we measure the time blocked acquiring the token —
       * the genuinely-new rate-limit signal that nothing else captures. `before`
       * is read OUTSIDE the gate; the inner clock read runs the instant the token
       * is granted, so `waitMs` is exactly the queue wait. Both reads are
       * per-invocation locals in the caller's fiber, so concurrent requests each
       * measure their own wait (the limiter serializes grants). The clock used is
       * the Effect `Clock`, so the measurement stays deterministic under TestClock.
       */
      return {
        apply: (effect) =>
          Effect.gen(function* () {
            const before = yield* Clock.currentTimeMillis
            return yield* limiter(
              Effect.gen(function* () {
                const waitMs = (yield* Clock.currentTimeMillis) - before
                yield* annotateNotionRateLimitWaitSpan(waitMs)
                yield* NotionRateLimitMetricBridges.rateLimitWaitMs.trustedRecord({
                  labels: {},
                  value: waitMs,
                })
                return yield* effect
              }),
            )
          }),
      }
    }),
  )
