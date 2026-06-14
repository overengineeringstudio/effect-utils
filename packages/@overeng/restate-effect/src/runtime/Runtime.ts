/**
 * Per-invocation handler runtime boundary: the determinism layer (journaled
 * Clock/Random backed by `ctx`), the logger bridge (Effect `Logger` → the
 * replay-aware `ctx.console`), and the cancellation↔interruption bridge
 * (`attemptCompletedSignal` → attempt-scoped finalization; Restate cancellation →
 * Effect interruption).
 *
 * These are PER-INVOCATION concerns provided over the user's handler effect at
 * the `materialize*` boundary (Endpoint.ts), alongside `RestateContext` and the
 * capability markers — never placed in the long-lived application Layer.
 *
 * See decisions 0004 (determinism layer), 0015 (logger bridge) and 0003 (error
 * boundary), docs/vrs/03-effect-runtime/spec.md §1 (determinism) + §2 (logging) and docs/vrs/04-error-boundary/spec.md §2 (cancellation↔interruption), and requirements R17 + R31.
 */
import * as restate from '@restatedev/restate-sdk'
import { Chunk, Clock, Effect, Layer, Logger, LogLevel, Random } from 'effect'

import { RestateContext } from '../authoring/RestateContext.ts'
import { withRestateOperation } from '../observability/effect.ts'

/**
 * Build an Effect `Clock` backed by the invocation's journaled `ctx.date`.
 *
 * - `currentTimeMillis` / `currentTimeNanos` read `ctx.date.now()` (async,
 *   journaled — replay-stable).
 * - `unsafeCurrentTimeMillis()` / `unsafeCurrentTimeNanos()` are SYNC and cannot
 *   call the async `ctx.date`, so they are served from a per-attempt FROZEN
 *   monotonic base seeded ONCE from `ctx.date.now()` at handler entry (passed in
 *   as `frozenBaseMillis`). Wall-clock time therefore does not advance
 *   mid-attempt — the deterministically-correct behavior: a replayed attempt
 *   observes the same time it observed when it first ran (R17, decision 0004).
 * - `sleep` is NOT remapped to `ctx.sleep` (R18) — durable waits stay the
 *   explicit `Restate.sleep` / `timeout` / `race` combinators. A bare in-handler
 *   `Effect.sleep` stays a non-durable in-process timer (the default Clock's
 *   sleep), so this Clock delegates `sleep` to the default Clock.
 */
const makeJournaledClock = (ctx: restate.Context, frozenBaseMillis: number): Clock.Clock => {
  const millisToNanos = (millis: number): bigint => BigInt(Math.trunc(millis)) * 1_000_000n
  const base = Clock.make()
  /* PROTOTYPE-PRESERVING clone: `Clock.make()` puts `sleep` and the sync
   * `unsafeCurrentTime*` on the Clock PROTOTYPE (only the async `currentTime*`
   * Effects are own-enumerable). A plain `{ ...Clock.make(), … }` object spread
   * therefore DROPS `sleep` — an in-handler `Effect.sleep` would then throw
   * `clock.sleep is not a function` (it surfaces as a retry loop under load).
   * We clone onto an object whose prototype IS the base Clock's prototype, so
   * `sleep` (the non-durable in-process timer — NOT remapped to `ctx.sleep`,
   * R18) and the `[ClockTypeId]` brand survive, then override only the time
   * reads: the sync `unsafeCurrentTime*` from the per-attempt frozen base, the
   * async `currentTime*` from the journaled `ctx.date`. */
  return Object.assign(Object.create(Object.getPrototypeOf(base)) as Clock.Clock, base, {
    unsafeCurrentTimeMillis: () => frozenBaseMillis,
    unsafeCurrentTimeNanos: () => millisToNanos(frozenBaseMillis),
    currentTimeMillis: Effect.promise(() => ctx.date.now()),
    currentTimeNanos: Effect.map(
      Effect.promise(() => ctx.date.now()),
      millisToNanos,
    ),
  })
}

/**
 * Build an Effect `Random` backed by the invocation's journaled `ctx.rand`
 * (seeded on the invocation id; `ctx.rand.random()` is replay-stable). The base
 * generator is `ctx.rand.random()` (uniform `[0, 1)`); the derived methods mirror
 * Effect's own `Random.make` derivations (so semantics match the default), but
 * integers are derived from the float (`ctx.rand` exposes only `random()` /
 * `uuidv4()`). Determinism holds because `ctx.rand.random()` is journaled-seeded
 * (R17, decision 0004).
 */
const makeJournaledRandom = (ctx: restate.Context): Random.Random => {
  const next = Effect.sync(() => ctx.rand.random())
  /* Floor a uniform float into `[0, bound)` — the integer analogue of Effect's
   * `PRNG.integer(bound)`, but over the journaled float source. */
  const nextIntBounded = (bound: number): Effect.Effect<number> =>
    Effect.map(next, (n) => Math.floor(n * bound))
  const nextIntBetween = (min: number, max: number): Effect.Effect<number> =>
    Effect.map(nextIntBounded(max - min), (n) => n + min)
  /* Fisher-Yates over the journaled int source — mirrors Effect's `shuffleWith`. */
  const shuffle = <A>(elements: Iterable<A>): Effect.Effect<Chunk.Chunk<A>> =>
    Effect.suspend(() => {
      const buffer = Array.from(elements)
      const swaps: number[] = []
      for (let i = buffer.length; i >= 2; i = i - 1) swaps.push(i)
      return Effect.as(
        Effect.forEach(
          swaps,
          (n) =>
            Effect.map(nextIntBetween(0, n), (k) => {
              const tmp = buffer[n - 1]!
              buffer[n - 1] = buffer[k]!
              buffer[k] = tmp
            }),
          { discard: true },
        ),
        Chunk.fromIterable(buffer),
      )
    })
  /* Spread the canonical default Random so the nominal `[RandomTypeId]` brand is
   * preserved; override every generator method to read the journaled `ctx.rand`. */
  return {
    ...Random.make('restate'),
    next,
    nextBoolean: Effect.map(next, (n) => n > 0.5),
    nextInt: nextIntBounded(Number.MAX_SAFE_INTEGER),
    nextRange: (min, max) => Effect.map(next, (n) => (max - min) * n + min),
    nextIntBetween,
    shuffle,
  }
}

/**
 * The per-invocation determinism `Layer` (R17): journaled `Clock` (via
 * `ctx.date` + a frozen-per-attempt sync base) and `Random` (via `ctx.rand`),
 * provided over the handler effect. `frozenBaseMillis` is seeded ONCE at handler
 * entry from `ctx.date.now()` so the sync `unsafeCurrentTime*` reads are
 * replay-stable. Requires `RestateContext` so it shares the per-invocation `ctx`.
 */
export const determinismLayer = (
  ctx: restate.Context,
  frozenBaseMillis: number,
): Layer.Layer<never> =>
  Layer.merge(
    Layer.setClock(makeJournaledClock(ctx, frozenBaseMillis)),
    Layer.setRandom(makeJournaledRandom(ctx)),
  )

/* ── logger bridge (decision 0015, docs/vrs/03-effect-runtime/spec.md §2) ───────────────────────────── */

/**
 * Map an Effect `LogLevel` to the `Console` method `ctx.console` exposes. The
 * `ctx.console` is a standard `Console`, so the five level-bearing methods cover
 * the spectrum: `Trace`/`Debug` → `debug`, `Info`/`All` → `info`, `Warning` →
 * `warn`, `Error`/`Fatal` → `error`. `None` never reaches a logger (Effect
 * filters it), so it falls through to `info` defensively.
 */
const consoleMethodFor = (level: LogLevel.LogLevel): 'debug' | 'info' | 'warn' | 'error' => {
  switch (level._tag) {
    case 'Trace':
    case 'Debug':
      return 'debug'
    case 'Warning':
      return 'warn'
    case 'Error':
    case 'Fatal':
      return 'error'
    default:
      return 'info'
  }
}

/* Format a log line via Effect's own `logfmtLogger` (a `Logger<unknown, string>`),
 * so the message, fiber id, annotations, spans, and cause all ride along in the
 * one logfmt string the way Effect's default console output does — we only change
 * the SINK (`ctx.console` instead of `globalThis.console`), not the FORMAT. */
const formatLog = Logger.logfmtLogger.log

/**
 * Build the per-invocation `Logger` that routes every in-handler `Effect.log*`
 * into the invocation's `ctx.console` (decision 0015, docs/vrs/03-effect-runtime/spec.md §2). `ctx.console`
 * is the SDK's replay-aware console: it stamps the invocation id / target context
 * and AUTOMATICALLY suppresses output during replay, and it honors the
 * `RESTATE_LOGGING` level — so an `Effect.logInfo` in a handler no longer
 * re-emits on every replay/attempt (the bug a plain `globalThis.console`-backed
 * default logger has), and level control comes for free.
 *
 * The format is Effect's own `logfmt` (so annotations/spans/cause ride along in
 * the message); only the SINK changes. Synchronous (`ctx.console` is sync), so it
 * composes cleanly as a `Logger.replace` of the default logger.
 */
const makeConsoleLogger = (ctx: restate.Context): Logger.Logger<unknown, void> =>
  Logger.make((options) => {
    const line = formatLog(options)
    ctx.console[consoleMethodFor(options.logLevel)](line)
  })

/**
 * The per-invocation logger `Layer` (decision 0015): replaces Effect's default
 * logger with one that writes to the invocation's replay-aware `ctx.console`.
 * Provided over the handler effect ALONGSIDE {@link determinismLayer} in every
 * `materialize*` path. The endpoint's OWN startup `Effect.logInfo` runs OUTSIDE a
 * handler, so it is unaffected (it keeps the process default logger).
 */
export const loggerLayer = (ctx: restate.Context): Layer.Layer<never> =>
  Logger.replace(Logger.defaultLogger, makeConsoleLogger(ctx))

/* ── cancellation ↔ interruption bridge (R31, docs/vrs/04-error-boundary/spec.md §2) ──────────────── */

/**
 * Run `effect` with the attempt's `Request.attemptCompletedSignal` bridged to
 * Effect interruption: when the AbortSignal fires (the attempt is ending —
 * cancellation, suspension, or kill), the handler fiber is interrupted at its
 * next await point, so `acquireRelease` / `onInterrupt` finalizers and saga
 * compensations run before the attempt unwinds (R31).
 *
 * The signal is ATTEMPT-scoped: the same logical invocation may get a NEW
 * attempt later (replay), so attempt-scoped cleanup must be idempotent (spec
 * docs/vrs/04-error-boundary/spec.md §2). We interrupt the running fiber rather than failing it, so the cause is a
 * genuine `Interrupt` (not a domain failure or defect) — `toTerminal` then
 * neither terminalizes nor retries it (docs/vrs/04-error-boundary/spec.md §1/§2).
 */
export const withAttemptInterruption = <A, E, R>(
  ctx: restate.Context,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  const signal = ctx.request().attemptCompletedSignal
  /* A watcher that COMPLETES (resolving `Effect.interrupt`) exactly when the
   * AbortSignal fires. Racing it against the user effect via `raceFirst` means
   * the abort interrupts the user fiber at its next await point — so its
   * `acquireRelease`/`onInterrupt` finalizers and compensations run (R31). The
   * `Effect.async` registration's returned effect removes the listener on
   * teardown (no leak across attempts). */
  const onAttemptComplete: Effect.Effect<never> = Effect.async<never>((resume) => {
    if (signal.aborted === true) {
      resume(Effect.interrupt)
      return
    }
    const onAbort = (): void => resume(Effect.interrupt)
    signal.addEventListener('abort', onAbort, { once: true })
    return Effect.sync(() => signal.removeEventListener('abort', onAbort))
  })
  return Effect.raceFirst(effect, onAttemptComplete).pipe(
    withRestateOperation('restate.attemptInterruption', 'attemptInterruption'),
  )
}

/* ── cancel surface (R31, docs/vrs/10-admin/spec.md) ──────────────────────────────────────── */

/**
 * Cancel ANOTHER invocation from inside a handler (cooperative cancel — the
 * target surfaces an Effect interruption at its next await point, so its
 * finalizers/compensations run; docs/vrs/04-error-boundary/spec.md §2). Backed by `ctx.cancel`. The
 * invocation id is the opaque handle returned by a prior `send` / submission.
 * Requires `RestateContext` (legal in any handler kind).
 */
export const cancel = (invocationId: string): Effect.Effect<void, never, RestateContext> =>
  Effect.gen(function* () {
    const ctx = yield* RestateContext
    ctx.cancel(restate.InvocationIdParser.fromString(invocationId))
  }).pipe(withRestateOperation('restate.cancel', invocationId))

/**
 * Observe the current invocation's cancellation as an Effect that SUCCEEDS when
 * Restate signals cancellation (R31, docs/vrs/10-admin/spec.md). Backed by the SDK's
 * `ContextInternal.cancellation()` durable promise.
 *
 * NOTE: the underlying promise only resolves when the service is configured with
 * `explicitCancellation: true` (decision 0011, R35); without it, cancellation is
 * propagated automatically (the in-flight durable op rejects with
 * `CancelledError`) and this promise never resolves. Use this only to RACE a
 * long-running step against cancellation under `explicitCancellation`.
 */
export const onCancellation: Effect.Effect<void, never, RestateContext> = Effect.gen(function* () {
  const ctx = yield* RestateContext
  const ctxInternal = ctx as restate.internal.ContextInternal
  yield* Effect.promise(() => ctxInternal.cancellation())
}).pipe(withRestateOperation('restate.onCancellation', 'cancellation'))
