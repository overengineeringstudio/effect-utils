import { Context, Duration, Effect, Layer, RateLimiter } from 'effect'

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
export class NotionThrottle extends Context.Tag('@overeng/notion-effect-client/NotionThrottle')<
  NotionThrottle,
  { readonly apply: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R> }
>() {}

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
      return { apply: (effect) => limiter(effect) }
    }),
  )
