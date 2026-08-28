import { Context, Duration, Effect, Layer } from 'effect'
import * as RateLimiter from 'effect/unstable/persistence/RateLimiter'

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
      const limiter = yield* RateLimiter.RateLimiter
      const burst = options.burst ?? 1
      return {
        apply: <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
          Effect.gen(function* () {
            /* `onExceeded: 'delay'` paces instead of failing: `RateLimiter.make`
             * only constructs `RateLimitExceeded` failures under
             * `onExceeded: 'fail'` (every failure branch in `consume` is
             * guarded by that check), so the only residual failure is a
             * `RateLimitStoreError` from the backing store — surfaced as a
             * defect via `orDie` rather than swallowed. */
            const { delay } = yield* limiter
              .consume({
                key: '@overeng/notion-effect-client/throttle',
                limit: burst,
                window: Duration.millis(burst * Math.ceil(1000 / options.requestsPerSecond)),
                algorithm: options.algorithm ?? 'token-bucket',
                onExceeded: 'delay',
              })
              .pipe(Effect.orDie)
            /* The limiter reports the exact pacing delay it will impose
             * (`ConsumeResult.delay`; zero when the token is granted
             * immediately), which is precisely the queue wait the
             * wait-span/metrics signals describe — no double-Clock
             * measurement needed. */
            const waitMs = Duration.toMillis(delay)
            if (Duration.isZero(delay) === true) return yield* effect
            /* Record only after the pacing delay has actually elapsed: an
             * interrupted waiter must not contribute a completed-wait sample
             * (the pre-flip instrumentation sampled after token acquisition
             * for the same reason). */
            yield* Effect.sleep(delay)
            yield* annotateNotionRateLimitWaitSpan(waitMs)
            yield* NotionRateLimitMetricBridges.rateLimitWaitMs.trustedRecord({
              labels: {},
              value: waitMs,
            })
            return yield* effect
          }),
      }
    }),
  ).pipe(Layer.provide(RateLimiter.layer), Layer.provide(RateLimiter.layerStoreMemory))
