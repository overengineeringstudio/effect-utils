/**
 * Unit tests for the per-invocation determinism layer (R17, decision 0004):
 * the journaled `Clock` (`ctx.date` + a per-attempt frozen sync base) and
 * `Random` (`ctx.rand`) provided over the handler effect by `determinismLayer`.
 *
 * These exercise the layer directly against a deterministic fake `ctx` (no
 * server needed): the end-to-end replay-stability guarantee is covered by the
 * native-server integration tests; here we assert the layer's CONTRACT — async
 * reads track `ctx.date`, the sync `currentTime*Unsafe` reads are FROZEN at the
 * entry-seeded base (do not advance mid-attempt), and `Random` reads `ctx.rand`.
 */
import type * as restate from '@restatedev/restate-sdk'
import { Clock, Effect, Random } from 'effect'
import { describe, expect, it } from 'vitest'

import { determinismLayer, loggerLayer } from '../mod.ts'

/**
 * A minimal deterministic fake `ctx` for the determinism layer: `date.now()`
 * returns an advancing journaled clock (each call +1000ms from a fixed base, as
 * a real journal would replay), and `rand` is a fixed cycling pseudo-source so
 * the assertions are exact.
 */
const fakeCtx = (opts: {
  readonly dateBase: number
  readonly randValues: ReadonlyArray<number>
}): restate.Context => {
  let dateCall = 0
  let randCall = 0
  const date = {
    now: () => Promise.resolve(opts.dateBase + dateCall++ * 1000),
    toJSON: () => Promise.resolve(new Date(opts.dateBase).toJSON()),
  }
  const rand = {
    random: () => opts.randValues[randCall++ % opts.randValues.length]!,
    uuidv4: () => '00000000-0000-4000-8000-000000000000',
  }
  return { date, rand } as unknown as restate.Context
}

describe('determinism layer', () => {
  it('Clock.currentTimeMillis reads journaled ctx.date (advances per journaled read)', async () => {
    const ctx = fakeCtx({ dateBase: 1_700_000_000_000, randValues: [0.5] })
    /* The frozen base is seeded from the FIRST ctx.date.now() (call 0). */
    const frozenBase = await ctx.date.now()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const a = yield* Clock.currentTimeMillis
        const b = yield* Clock.currentTimeMillis
        return { a, b }
      }).pipe(Effect.provide(determinismLayer({ ctx, frozenBaseMillis: frozenBase }))),
    )
    /* Each async read maps to a fresh journaled ctx.date.now() (calls 1, 2). */
    expect(result.a).toBe(1_700_000_001_000)
    expect(result.b).toBe(1_700_000_002_000)
  })

  it('Clock.sleep is preserved (in-handler Effect.sleep does NOT throw clock.sleep is not a function)', async () => {
    /* REGRESSION (found under load): the journaled Clock was built via a
     * `{ ...Clock.make(), … }` object spread, which DROPS `sleep` (it lives on
     * the Clock prototype, not as an own-enumerable property). A bare in-handler
     * `Effect.sleep` then crashed with `clock.sleep is not a function`, surfacing
     * as a retry loop. The prototype-preserving construction keeps `sleep`. */
    const ctx = fakeCtx({ dateBase: 1_700_000_000_000, randValues: [0.5] })
    const frozenBase = await ctx.date.now()
    const layer = determinismLayer({ ctx, frozenBaseMillis: frozenBase })
    /* The journaled Clock must expose a callable `sleep` (the non-durable
     * in-process timer — NOT remapped to `ctx.sleep`, R18). */
    const sleepIsFn = await Effect.runPromise(
      Clock.clockWith((clock) => Effect.succeed(typeof clock.sleep)).pipe(Effect.provide(layer)),
    )
    expect(sleepIsFn).toBe('function')
    /* And an actual in-handler `Effect.sleep` runs to completion without throwing. */
    const completed = await Effect.runPromise(
      Effect.sleep('1 millis').pipe(Effect.as('done' as const), Effect.provide(layer)),
    )
    expect(completed).toBe('done')
  })

  it('Clock.currentTime*Unsafe is FROZEN at the entry base (does not advance mid-attempt)', async () => {
    const ctx = fakeCtx({ dateBase: 1_700_000_000_000, randValues: [0.5] })
    const frozenBase = await ctx.date.now()
    const result = await Effect.runPromise(
      Clock.clockWith((clock) =>
        Effect.sync(() => {
          /* Repeated sync reads must return the SAME frozen value — a replayed
           * attempt must observe the same wall-clock it first observed (R17). */
          const m1 = clock.currentTimeMillisUnsafe()
          const m2 = clock.currentTimeMillisUnsafe()
          const n1 = clock.currentTimeNanosUnsafe()
          return { m1, m2, n1 }
        }),
      ).pipe(Effect.provide(determinismLayer({ ctx, frozenBaseMillis: frozenBase }))),
    )
    expect(result.m1).toBe(frozenBase)
    expect(result.m2).toBe(frozenBase)
    /* Nanos is the millis base in ns (frozen base * 1e6). */
    expect(result.n1).toBe(BigInt(frozenBase) * 1_000_000n)
  })

  it('Random reads journaled ctx.rand (deterministic for a fixed source)', async () => {
    const ctx = fakeCtx({ dateBase: 0, randValues: [0.1, 0.7, 0.3] })
    const program = Effect.gen(function* () {
      const a = yield* Random.next
      const b = yield* Random.next
      const bool = yield* Random.nextBoolean
      return { a, b, bool }
    }).pipe(Effect.provide(determinismLayer({ ctx, frozenBaseMillis: 0 })))
    const result = await Effect.runPromise(program)
    /* Base reads are the journaled ctx.rand.random() values verbatim. */
    expect(result.a).toBe(0.1)
    expect(result.b).toBe(0.7)
    /* nextBoolean derives `n > 0.5` from the next journaled read (0.3 → false). */
    expect(result.bool).toBe(false)
  })

  it('journaled Random supplies both Effect 4 primitive generator methods', async () => {
    /* Effect 4's effectful Random operations derive exclusively from these two
     * Reference methods. A future service-shape change must fail this guard so
     * the journaled source cannot silently fall back to an untracked generator. */
    const ctx = fakeCtx({ dateBase: 0, randValues: [0.5] })
    const journaled = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* Random.Random
      }).pipe(
        Effect.provide(determinismLayer({ ctx, frozenBaseMillis: 0 })),
      ),
    )
    const expected = ['nextDoubleUnsafe', 'nextIntUnsafe']
    expect(Object.keys(journaled).sort()).toStrictEqual(expected)
    for (const method of expected) {
      expect(Object.hasOwn(journaled, method)).toBe(true)
    }
  })

  it('Random.nextIntBetween preserves the v3 half-open upper bound', async () => {
    /* 0.999 over [0,10) → 9. The v4 inclusive default can return 10. */
    const ctx = fakeCtx({ dateBase: 0, randValues: [0.999] })
    const value = await Effect.runPromise(
      Random.nextIntBetween(0, 10, { halfOpen: true }).pipe(
        Effect.provide(determinismLayer({ ctx, frozenBaseMillis: 0 })),
      ),
    )
    expect(value).toBe(9)
  })

  it('Random.nextInt preserves the journaled v3 integer derivation', async () => {
    const ctx = fakeCtx({ dateBase: 0, randValues: [0.5] })
    const value = await Effect.runPromise(
      Random.nextInt.pipe(Effect.provide(determinismLayer({ ctx, frozenBaseMillis: 0 }))),
    )
    expect(value).toBe(Math.floor(0.5 * Number.MAX_SAFE_INTEGER))
  })

  it('two runs over the same journaled source produce identical output (replay-stable)', async () => {
    const make = () => fakeCtx({ dateBase: 1_000, randValues: [0.11, 0.22, 0.33] })
    const program = (ctx: restate.Context) =>
      Effect.gen(function* () {
        const t = yield* Clock.currentTimeMillis
        const r1 = yield* Random.next
        const r2 = yield* Random.next
        return { t, r1, r2 }
      }).pipe(Effect.provide(determinismLayer({ ctx, frozenBaseMillis: 1_000 })))
    const first = await Effect.runPromise(program(make()))
    const second = await Effect.runPromise(program(make()))
    /* A replayed attempt over the same journal observes identical values. */
    expect(second).toEqual(first)
  })
})

/**
 * A fake `ctx.console` that RECORDS the `(method, message)` of every call, and
 * (modeling the SDK's replay-aware console) DROPS the call entirely while
 * `replaying` is true — exactly the replay-suppression `loggerLayer` rides on.
 */
const fakeConsoleCtx = (state: { replaying: boolean }) => {
  const calls: Array<{ readonly method: string; readonly message: string }> = []
  const record =
    (method: 'debug' | 'info' | 'warn' | 'error') =>
    (...args: ReadonlyArray<unknown>): void => {
      if (state.replaying === true) return
      calls.push({ method, message: String(args[0]) })
    }
  const console = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  }
  return { calls, ctx: { console } as unknown as restate.Context }
}

describe('logger bridge (decision 0015)', () => {
  it('routes an in-handler Effect.log* through ctx.console at the matching level', async () => {
    const state = { replaying: false }
    const { calls, ctx } = fakeConsoleCtx(state)
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.logInfo('hello info')
        yield* Effect.logWarning('careful')
        yield* Effect.logError('boom')
      }).pipe(Effect.provide(loggerLayer(ctx))),
    )
    /* Each level lands on the matching console method, with the message in the line. */
    const info = calls.find((c) => c.message.includes('hello info'))
    const warn = calls.find((c) => c.message.includes('careful'))
    const error = calls.find((c) => c.message.includes('boom'))
    expect(info?.method).toBe('info')
    expect(warn?.method).toBe('warn')
    expect(error?.method).toBe('error')
    /* The bridge writes to ctx.console, NOT a separate sink (one call per log). */
    expect(calls).toHaveLength(3)
  })

  it('does NOT double-emit under replay (ctx.console suppresses replayed logs)', async () => {
    const state = { replaying: false }
    const { calls, ctx } = fakeConsoleCtx(state)
    const program = Effect.logInfo('once-per-real-attempt').pipe(Effect.provide(loggerLayer(ctx)))
    /* First (real) attempt emits. */
    await Effect.runPromise(program)
    expect(calls).toHaveLength(1)
    /* A replayed attempt re-runs the same logInfo, but ctx.console drops it — so
     * the handler does not re-emit the log on every replay (the bug this fixes). */
    state.replaying = true
    await Effect.runPromise(program)
    expect(calls).toHaveLength(1)
  })
})
