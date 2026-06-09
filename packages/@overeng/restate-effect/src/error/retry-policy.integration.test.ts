/**
 * Integration gap: `disableRetries` as an ASSERTION + the retryable surface against
 * a real native server (decision 0006, spec §7). `disableRetries` is passed
 * everywhere but never asserted — here we PROVE it, and exercise the
 * `Restate.retryable` + `retryAfter` projection end-to-end:
 *
 * - `disableRetries` (server-global max-attempts=1 + kill-on-max) makes a DEFECT
 *   (infra) failure fail-FAST: attempted EXACTLY ONCE, then killed. WITHOUT it the
 *   default policy RETRIES the same defect (the attempt count climbs past one).
 * - A `Restate.retryable`-annotated domain failure RETRIES (the retryable
 *   classification + the `retryAfter` projection drive Restate to re-run the handler).
 *
 * The handler is triggered as a forked ingress `call` (never blocking the test on a
 * killed/looping invocation). Attempts are counted via module-level per-test counters
 * incremented at each REAL handler entry — the endpoint runs in this test process, so
 * the counter is directly observable AND survives the per-attempt State rollback a
 * failed attempt incurs.
 */
import { it } from '@effect/vitest'
import { Effect, Layer, Schema } from 'effect'
import { describe, expect } from 'vitest'

import { Restate, RestateService } from '../mod.ts'
import { liveSleep, RestateTestHarness, serverAvailable } from '../testing/testing.ts'

/* A retryable domain error with a SHORT `retryAfter` floor projected from the error
 * instance (so the retries elapse quickly + the projection path is exercised). */
class Throttled extends Schema.TaggedError<Throttled>('retry/Throttled')('Throttled', {
  retryAfterMillis: Schema.Number,
}) {}
const ThrottledRetryable = Restate.retryable(Throttled, {
  retryAfter: (e: Throttled) => e.retryAfterMillis,
})

const Flaky = RestateService.contract('retry-flaky', {
  /* A DEFECT (infra) failure — retried by the invoker's default policy, bounded by
   * the global max-attempts (so `disableRetries` makes it fail-fast). */
  defect: { input: Schema.Void, success: Schema.Void },
  /* A `retryable`-annotated domain failure — Restate re-runs the handler. */
  retryable: { input: Schema.Void, success: Schema.Void, error: ThrottledRetryable },
})

/* Module-level attempt counters (the endpoint runs in-process); they survive the
 * per-attempt State rollback a failed attempt incurs. */
const attempts = { defect: 0, retryable: 0 }
const FlakyLive = RestateService.implement<typeof Flaky>(Flaky, {
  defect: () =>
    Effect.gen(function* () {
      attempts.defect += 1
      return yield* Effect.die(new Error('infra boom'))
    }),
  retryable: () =>
    Effect.gen(function* () {
      attempts.retryable += 1
      return yield* new Throttled({ retryAfterMillis: 10 })
    }),
})

const failFastHarness = RestateTestHarness.layer({
  services: [FlakyLive],
  appLayer: Layer.empty,
  /* The assertion under test: max-attempts=1 + kill-on-max as the global default. */
  disableRetries: true,
})
const retryingHarness = RestateTestHarness.layer({ services: [FlakyLive], appLayer: Layer.empty })

/** Wait until a counter stops climbing (the retries have settled / been killed). */
const settled = (read: () => number): Effect.Effect<number> =>
  Effect.gen(function* () {
    let last = -1
    let stable = 0
    for (let i = 0; i < 40 && stable < 4; i++) {
      const n = read()
      stable = n === last ? stable + 1 : 0
      last = n
      yield* liveSleep(100)
    }
    return last
  })

/** Observe a counter climb past one within a bounded window (the retries firing). */
const climbsPastOne = (read: () => number): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    for (let i = 0; i < 50; i++) {
      if (read() >= 3) return true
      yield* liveSleep(100)
    }
    return read() > 1
  })

describe.skipIf(!serverAvailable)('disableRetries + retryable surface (real server)', () => {
  it.layer(failFastHarness, { timeout: 90_000 })('disableRetries', (it) => {
    it.effect('a defect failure is attempted EXACTLY once (fail-fast)', () =>
      Effect.gen(function* () {
        attempts.defect = 0
        const harness = yield* RestateTestHarness
        /* Forked so the test never blocks on the killed invocation. */
        yield* harness.ingress.call(Flaky, 'defect', undefined).pipe(Effect.ignore, Effect.fork)
        const total = yield* settled(() => attempts.defect)
        expect(total).toBe(1)
      }),
    )
  })

  it.layer(retryingHarness, { timeout: 90_000 })('default policy retries', (it) => {
    it.effect('without disableRetries the SAME defect RETRIES (count climbs past one)', () =>
      Effect.gen(function* () {
        attempts.defect = 0
        const harness = yield* RestateTestHarness
        yield* harness.ingress.call(Flaky, 'defect', undefined).pipe(Effect.ignore, Effect.fork)
        expect(yield* climbsPastOne(() => attempts.defect)).toBe(true)
      }),
    )

    it.effect('a Restate.retryable failure drives Restate to RETRY (retryAfter paced)', () =>
      Effect.gen(function* () {
        attempts.retryable = 0
        const harness = yield* RestateTestHarness
        yield* harness.ingress.call(Flaky, 'retryable', undefined).pipe(Effect.ignore, Effect.fork)
        expect(yield* climbsPastOne(() => attempts.retryable)).toBe(true)
      }),
    )
  })
})
