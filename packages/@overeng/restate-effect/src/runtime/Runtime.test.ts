/**
 * Unit tests for the per-invocation determinism layer (R17, decision 0004):
 * the journaled `Clock` (`ctx.date` + a per-attempt frozen sync base) and
 * `Random` (`ctx.rand`) provided over the handler effect by `determinismLayer`.
 *
 * These exercise the layer directly against a deterministic fake `ctx` (no
 * server needed): the end-to-end replay-stability guarantee is covered by the
 * native-server integration tests; here we assert the layer's CONTRACT — async
 * reads track `ctx.date`, the sync `unsafeCurrentTime*` reads are FROZEN at the
 * entry-seeded base (do not advance mid-attempt), and `Random` reads `ctx.rand`.
 */
import type * as restate from '@restatedev/restate-sdk'
import { Clock, Effect, Random } from 'effect'
import { describe, expect, it } from 'vitest'

import { determinismLayer, loggerLayer } from '../mod.ts'

/* The fully-derived default Random whose method set the journaled Random must match. */
const defaultRandom = Random.make('parity-probe')

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
      }).pipe(Effect.provide(determinismLayer(ctx, frozenBase))),
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
    const layer = determinismLayer(ctx, frozenBase)
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

  it('Clock.unsafeCurrentTime* is FROZEN at the entry base (does not advance mid-attempt)', async () => {
    const ctx = fakeCtx({ dateBase: 1_700_000_000_000, randValues: [0.5] })
    const frozenBase = await ctx.date.now()
    const result = await Effect.runPromise(
      Clock.clockWith((clock) =>
        Effect.sync(() => {
          /* Repeated sync reads must return the SAME frozen value — a replayed
           * attempt must observe the same wall-clock it first observed (R17). */
          const m1 = clock.unsafeCurrentTimeMillis()
          const m2 = clock.unsafeCurrentTimeMillis()
          const n1 = clock.unsafeCurrentTimeNanos()
          return { m1, m2, n1 }
        }),
      ).pipe(Effect.provide(determinismLayer(ctx, frozenBase))),
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
    }).pipe(Effect.provide(determinismLayer(ctx, 0)))
    const result = await Effect.runPromise(program)
    /* Base reads are the journaled ctx.rand.random() values verbatim. */
    expect(result.a).toBe(0.1)
    expect(result.b).toBe(0.7)
    /* nextBoolean derives `n > 0.5` from the next journaled read (0.3 → false). */
    expect(result.bool).toBe(false)
  })

  it('journaled Random overrides EVERY generator method of the default Random (parity guard)', async () => {
    /* `makeJournaledRandom` spreads `Random.make(...)` then overrides each
     * generator from the journaled `ctx.rand`. A FUTURE generator method on the
     * `Random` interface that the journaled Random does NOT override would be a
     * SILENT determinism hole — it would read the spread's non-journaled source on
     * replay. This guard enumerates every CALLABLE member the default Random
     * exposes (own + prototype), drops the known PRNG IMPL details (`seed`/`PRNG`
     * are not part of the `Random` service interface and do not feed a journaled
     * read), and asserts the journaled Random carries its OWN override for each
     * remaining generator method. It fails loudly the day Effect adds a generator
     * we have not journaled. */
    const ctx = fakeCtx({ dateBase: 0, randValues: [0.5] })
    const journaled = await Effect.runPromise(
      Random.randomWith((r) => Effect.succeed(r)).pipe(Effect.provide(determinismLayer(ctx, 0))),
    )
    /* PRNG impl details (NOT on the `Random` service interface; carried by the
     * concrete `Random.make` instance but never read by the journaled overrides).
     * The `Random` brand symbol is also dropped — it is not a generator. */
    const implOnly = new Set(['seed', 'PRNG'])
    const generators = (r: object): ReadonlyArray<string> => {
      const names = new Set<string>()
      /* Walk own + prototype members but STOP at `Object.prototype` (so the
       * universal `toString`/`hasOwnProperty`/… are not counted). Both Effect-VALUED
       * generators (`next`/`nextBoolean`/`nextInt`) and function-shaped generators
       * (`nextRange`/`nextIntBetween`/`shuffle`) count — classifying by `typeof` would
       * miss the Effect-valued ones. */
      for (
        let cur: object | null = r;
        cur !== null && cur !== Object.prototype;
        cur = Object.getPrototypeOf(cur)
      ) {
        for (const key of Object.getOwnPropertyNames(cur)) {
          if (key === 'constructor' || implOnly.has(key)) continue
          names.add(key)
        }
      }
      return [...names].sort()
    }
    const expected = generators(defaultRandom)
    /* The six documented `Random` generators (sanity floor — catches accidental
     * over-filtering of the impl allowlist). */
    expect(expected).toStrictEqual([
      'next',
      'nextBoolean',
      'nextInt',
      'nextIntBetween',
      'nextRange',
      'shuffle',
    ])
    /* Every generator method is an OWN property on the journaled Random (i.e. it
     * was re-journaled, not inherited from the spread). */
    for (const method of expected) {
      expect(Object.hasOwn(journaled, method)).toBe(true)
    }
  })

  it('Random.nextIntBetween derives a bounded int from the journaled float', async () => {
    /* 0.42 over [0,10) → floor(0.42 * 10) = 4. */
    const ctx = fakeCtx({ dateBase: 0, randValues: [0.42] })
    const value = await Effect.runPromise(
      Random.nextIntBetween(0, 10).pipe(Effect.provide(determinismLayer(ctx, 0))),
    )
    expect(value).toBe(4)
  })

  it('two runs over the same journaled source produce identical output (replay-stable)', async () => {
    const make = () => fakeCtx({ dateBase: 1_000, randValues: [0.11, 0.22, 0.33] })
    const program = (ctx: restate.Context) =>
      Effect.gen(function* () {
        const t = yield* Clock.currentTimeMillis
        const r1 = yield* Random.next
        const r2 = yield* Random.next
        return { t, r1, r2 }
      }).pipe(Effect.provide(determinismLayer(ctx, 1_000)))
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
