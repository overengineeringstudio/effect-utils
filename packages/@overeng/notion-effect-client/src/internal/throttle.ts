import { Clock, Context, Duration, Effect, Layer } from 'effect'
import * as RateLimiter from 'effect/unstable/persistence/RateLimiter'

import { NotionRateLimitMetricBridges } from './metrics.ts'
import { annotateNotionRateLimitWaitSpan } from './otel.ts'

const isRateLimiterError = (error: unknown): error is RateLimiter.RateLimiterError =>
  typeof error === 'object' &&
  error !== null &&
  '_tag' in error &&
  error._tag === 'RateLimiterError'

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
 * through the client for the lifetime of the layer. Defaults lazily to a
 * pass-through throttle (no throttling; per-request retries still apply);
 * an explicit `Layer.succeed`/`Effect.provideService` always wins.
 *
 * `apply` wraps one logical request (the whole retry loop) so a single token is
 * consumed per request, not per retry attempt.
 */
export interface NotionThrottleShape {
  readonly apply: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

/** Optional global request throttle reference; see {@link NotionThrottleShape}. */
export const NotionThrottle: Context.Reference<NotionThrottleShape> =
  Context.Reference<NotionThrottleShape>('@overeng/notion-effect-client/NotionThrottle', {
    defaultValue: () => ({ apply: (effect) => effect }),
  })

/**
 * Build a {@link NotionThrottle} layer backed by an Effect-native `RateLimiter`
 * token bucket. The bucket spreads `requestsPerSecond` requests over a
 * 1-second window (refill one token every `window / limit` ms), with an
 * optional `burst` of buffered tokens as the bucket capacity.
 */
export const NotionThrottleLive = (options: NotionThrottleOptions): Layer.Layer<never> =>
  Layer.effect(
    NotionThrottle,
    Effect.gen(function* () {
      const withLimiter = yield* RateLimiter.makeWithRateLimiter
      const burst = options.burst ?? 1
      /**
       * Behavior-preserving wait instrumentation (decision 0017 Half 2, #775):
       * the limiter still wraps `effect` exactly as before (token accounting and
       * pacing untouched), but we measure the time blocked acquiring the token —
       * the genuinely-new rate-limit signal that nothing else captures. `before`
       * is read OUTSIDE the gate; the inner clock read runs the instant the token
       * is granted, so `waitMs` is exactly the queue wait. Both reads are
       * per-invocation locals in the caller's fiber, so concurrent requests each
       * measure their own wait. The clock used is the Effect `Clock`, so the
       * measurement stays deterministic under TestClock.
       */
      return {
        apply: <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
          Effect.gen(function* () {
            const before = yield* Clock.currentTimeMillis
            /* `onExceeded: 'delay'` delays instead of failing, so the limiter's
             * `RateLimiterError` channel is statically unreachable here; a
             * store failure surfaces as a defect rather than being swallowed. */
            const throttled: Effect.Effect<A, E | RateLimiter.RateLimiterError, R> = withLimiter({
              key: '@overeng/notion-effect-client/throttle',
              limit: burst,
              window: Duration.millis(burst * Math.ceil(1000 / options.requestsPerSecond)),
              algorithm: options.algorithm ?? 'token-bucket',
              onExceeded: 'delay',
            })(
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
            /* `onExceeded: 'delay'` delays instead of failing, so the limiter's
             * `RateLimiterError` channel is statically unreachable here; a
             * store failure surfaces as a defect rather than being swallowed. */
            return yield* Effect.catch(throttled, (error) => {
              if (isRateLimiterError(error) === true) {
                return Effect.die(error)
              }
              return Effect.fail(error)
            })
          }),
      }
    }),
  ).pipe(Layer.provide(RateLimiter.layer), Layer.provide(RateLimiter.layerStoreMemory))
