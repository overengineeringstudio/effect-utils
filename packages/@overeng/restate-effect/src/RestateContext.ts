import * as restate from '@restatedev/restate-sdk'
import { Context, Effect, Runtime, Schema } from 'effect'

import { RestateError } from './RestateError.ts'

/**
 * The per-invocation Restate `Context`, provided as a `Context.Tag` service.
 *
 * Bound to a single invocation/journal, so it is provided PER CALL at the
 * handler boundary (see `Endpoint.materialize`) — never placed in the
 * long-lived application `Layer`. Durable combinators carry `RestateContext`
 * in their `R` and reach the raw SDK context via `yield* RestateContext`.
 */
export class RestateContext extends Context.Tag('@overeng/restate-effect/RestateContext')<
  RestateContext,
  restate.Context
>() {}

/* ── capability markers (flat, independent — see decision 0002) ──────────── */
/*
 * Each marker is a distinct `Context.Tag` service, NOT a subtype lattice
 * (`Context.Tag` models no inheritance). A combinator requiring `StateWrite` is
 * satisfied ONLY by `StateWrite`, never by an umbrella marker — so the right set
 * is PROVIDED per handler kind at `materialize`. Empty service values: they gate
 * type-legality, not runtime behavior (the raw `ctx` does the work).
 */

/** Permits `State.get` / `State.stateKeys`. Provided to object/workflow handlers. */
export class StateRead extends Context.Tag('@overeng/restate-effect/StateRead')<
  StateRead,
  Record<never, never>
>() {}

/** Permits `State.set` / `State.clear` / `State.clearAll`. Exclusive object / workflow `run` only. */
export class StateWrite extends Context.Tag('@overeng/restate-effect/StateWrite')<
  StateWrite,
  Record<never, never>
>() {}

/** Permits `DurablePromise.*`. Workflow handlers only. */
export class DurablePromise extends Context.Tag('@overeng/restate-effect/DurablePromise')<
  DurablePromise,
  Record<never, never>
>() {}

/** Permits the `ctx.key` accessor. Object / workflow handlers (all keyed). */
export class ObjectKey extends Context.Tag('@overeng/restate-effect/ObjectKey')<
  ObjectKey,
  { readonly key: string }
>() {}

/**
 * The full set of durable capabilities `Restate.run` scrubs from its inner
 * effect's `R`, so a nested `ctx.*` / `State.*` / `Restate.sleep` inside a `run`
 * closure is a COMPILE error (mirrors Restate's "no nested `ctx.*` inside run").
 */
export type DurableCaps = RestateContext | StateRead | StateWrite | DurablePromise | ObjectKey

/* eslint-disable @typescript-eslint/no-explicit-any -- Schema map value variance */
/** A map of State key → value Schema (the contract's typed `state` block). */
export type StateSchemas = Record<string, Schema.Schema<any, any>>
/* eslint-enable @typescript-eslint/no-explicit-any */

/* ── descriptors (deterministic concurrency — see decision 0005) ─────────── */

/**
 * A durable-op descriptor: a tagged value carrying how to ISSUE one durable
 * operation against the raw `ctx`, returning the SDK `RestatePromise`. Issued
 * SYNCHRONOUSLY in source order by `Restate.all`/`race`/`any` so the journal
 * order is the source order — NOT `Effect.all` over opaque thunks (whose
 * scheduling, not source order, would decide journal order).
 *
 * The phantom `_A` carrier keeps the precise result type on the descriptor so
 * the combinators recover a precise result tuple/union.
 */
export interface Descriptor<A> {
  readonly _tag: 'run' | 'sleep' | 'promiseGet'
  readonly issue: (ctx: restate.Context) => restate.RestatePromise<A>
  /** phantom result carrier (never read at runtime) */
  readonly _A?: (a: A) => void
}

/** Recover the result tuple from a tuple of descriptors. */
export type ResultsOf<T extends readonly Descriptor<any>[]> = {
  -readonly [P in keyof T]: T[P] extends Descriptor<infer A> ? A : never
}

const descriptor = <A>(
  tag: Descriptor<A>['_tag'],
  issue: (ctx: restate.Context) => restate.RestatePromise<A>,
): Descriptor<A> => ({ _tag: tag, issue })

/* ── durable combinators ─────────────────────────────────────────────────── */

/**
 * A durable side-effect step backed by `ctx.run(name, …)`. Restate journals the
 * result so subsequent attempts replay it verbatim instead of re-executing.
 *
 * SCRUBS the durable capabilities from `effect`'s `R` (`Exclude<R,
 * DurableCaps>`), so a nested `ctx.*` / `State.get` / `Restate.sleep` inside the
 * closure is a COMPILE error. The inner effect runs on the captured
 * per-invocation runtime, so any residual app `R` is satisfied from the
 * surrounding handler scope.
 *
 * A rejection (incl. a give-up after `ctx.run`'s own retries) surfaces as a
 * `RestateError({ reason: 'RunFailed' })` — the wrapper's failure, distinct from
 * the handler's domain `E`.
 */
export const run = <A, E, R>(
  name: string,
  effect: [R] extends [Exclude<R, DurableCaps>] ? Effect.Effect<A, E, R> : never,
): Effect.Effect<A, E | RestateError, Exclude<R, DurableCaps> | RestateContext> =>
  Effect.gen(function* () {
    const ctx = yield* RestateContext
    const runtime = yield* Effect.runtime<Exclude<R, DurableCaps>>()
    /* The `[R] extends [Exclude<R, DurableCaps>]` guard guarantees `R` carries no
     * durable capability, so the captured `Exclude<R, DurableCaps>` runtime can
     * run it; the cast just reconciles the conditional type. */
    const inner = effect as Effect.Effect<A, E, Exclude<R, DurableCaps>>
    return yield* Effect.tryPromise({
      try: () => ctx.run(name, () => Runtime.runPromise(runtime)(inner)),
      catch: (cause) => new RestateError({ reason: 'RunFailed', method: `run(${name})`, cause }),
    })
  }).pipe(Effect.withSpan('restate.run', { attributes: { 'span.label': name } }))

/** A `run` descriptor for use inside `Restate.all`/`race`/`any`. */
export const runDescriptor = <A>(
  name: string,
  action: (() => Promise<A>) | (() => A),
): Descriptor<A> => descriptor<A>('run', (ctx) => ctx.run<A>(name, action))

/**
 * A durable timer backed by `ctx.sleep`. The duration is a lower bound; the
 * timer survives suspension and process restarts.
 */
export const sleep = (
  millis: number,
  name?: string,
): Effect.Effect<void, RestateError, RestateContext> =>
  Effect.gen(function* () {
    const ctx = yield* RestateContext
    yield* Effect.tryPromise({
      try: () => ctx.sleep(millis, name),
      catch: (cause) =>
        new RestateError({ reason: 'SleepFailed', method: `sleep(${millis})`, cause }),
    })
  }).pipe(Effect.withSpan('restate.sleep', { attributes: { 'span.label': name ?? `${millis}ms` } }))

/** A `sleep` descriptor for use inside `Restate.all`/`race`/`any`. */
export const sleepDescriptor = (millis: number, name?: string): Descriptor<void> =>
  descriptor('sleep', (ctx) => ctx.sleep(millis, name))

/**
 * A durable timeout: race `effect` against a `ctx.sleep` deadline via
 * `RestatePromise.orTimeout`. On timeout the result is `None`; otherwise
 * `Some(value)`. The raced `effect` must itself be a single durable op
 * descriptor issuer — Phase 1 exposes `timeout` over a `run`/`promiseGet`
 * descriptor so the inner op is issued once and bounded.
 */
export const timeout = <A>(
  descr: Descriptor<A>,
  millis: number,
): Effect.Effect<A | undefined, RestateError, RestateContext> =>
  Effect.gen(function* () {
    const ctx = yield* RestateContext
    return yield* Effect.tryPromise({
      try: () =>
        descr
          .issue(ctx)
          .orTimeout(millis)
          .map((value?: A) => value),
      catch: (cause) =>
        new RestateError({ reason: 'RunFailed', method: `timeout(${millis})`, cause }),
    })
  }).pipe(Effect.withSpan('restate.timeout', { attributes: { 'span.label': `${millis}ms` } }))

/**
 * Combine durable-op descriptors deterministically. Issues every descriptor
 * SYNCHRONOUSLY in source order to obtain the `RestatePromise[]` (fixing the
 * journal order), hands the array to the SDK `combine` (`all`/`race`/`any`), and
 * awaits the SINGLE resulting `RestatePromise` in ONE `Effect.tryPromise`,
 * mapping the result after (never `.then`-chaining pre-await — `.then` is the
 * SDK's suspension seam). See decision 0005.
 */
const combineDescriptors =
  <Combined>(
    label: string,
    combine: (
      promises: ReadonlyArray<restate.RestatePromise<unknown>>,
    ) => restate.RestatePromise<Combined>,
  ) =>
  <const T extends readonly Descriptor<any>[]>(
    descriptors: T,
  ): Effect.Effect<Combined, RestateError, RestateContext> =>
    Effect.gen(function* () {
      const ctx = yield* RestateContext
      return yield* Effect.tryPromise({
        try: () => combine(descriptors.map((d) => d.issue(ctx))),
        catch: (cause) => new RestateError({ reason: 'RunFailed', method: label, cause }),
      })
    }).pipe(Effect.withSpan(`restate.${label}`))

/** Await all durable descriptors → result TUPLE (issued in source order). */
export const all = <const T extends readonly Descriptor<any>[]>(
  descriptors: T,
): Effect.Effect<ResultsOf<T>, RestateError, RestateContext> =>
  combineDescriptors<ResultsOf<T>>(
    'all',
    (promises) =>
      /* The SDK's `all` returns the awaited tuple; the descriptor phantoms make it
       * precise at the call site. */
      restate.RestatePromise.all(promises) as restate.RestatePromise<ResultsOf<T>>,
  )(descriptors)

/** Race durable descriptors → first result (union of branch types). */
export const race = <const T extends readonly Descriptor<any>[]>(
  descriptors: T,
): Effect.Effect<ResultsOf<T>[number], RestateError, RestateContext> =>
  combineDescriptors<ResultsOf<T>[number]>(
    'race',
    (promises) =>
      restate.RestatePromise.race(promises) as restate.RestatePromise<ResultsOf<T>[number]>,
  )(descriptors)

/** First SUCCESSFULLY-resolved durable descriptor (union of branch types). */
export const any = <const T extends readonly Descriptor<any>[]>(
  descriptors: T,
): Effect.Effect<ResultsOf<T>[number], RestateError, RestateContext> =>
  combineDescriptors<ResultsOf<T>[number]>(
    'any',
    (promises) =>
      restate.RestatePromise.any(promises) as restate.RestatePromise<ResultsOf<T>[number]>,
  )(descriptors)

/* ── State combinators (capability-gated, key/value typed against `state`) ─ */
/*
 * Typed against a `StateSchemas` map `S` keyed by the state key. `get`/`stateKeys`
 * require `StateRead`; `set`/`clear`/`clearAll` require `StateWrite`. These
 * compile-fail in a Service handler (no markers provided) — correct: State is an
 * Object/Workflow capability, exercised in Phase 2. Each is decode/encode'd via
 * the contract's per-key Schema (`internal` slot — a State decode failure is a
 * corrupt-journal defect).
 */

const readState = <S extends StateSchemas, K extends keyof S & string>(
  schemas: S,
  key: K,
): Effect.Effect<Schema.Schema.Type<S[K]> | undefined, RestateError, StateRead | RestateContext> =>
  Effect.gen(function* () {
    const ctx = yield* RestateContext
    const objectCtx = ctx as restate.ObjectContext
    const raw = yield* Effect.tryPromise({
      try: () => objectCtx.get<unknown>(key),
      catch: (cause) =>
        new RestateError({ reason: 'RunFailed', method: `State.get(${key})`, cause }),
    })
    if (raw === null || raw === undefined) return undefined
    return yield* Schema.decodeUnknown(schemas[key] as S[K])(raw).pipe(
      Effect.mapError(
        (cause) => new RestateError({ reason: 'SerdeFailed', method: `State.get(${key})`, cause }),
      ),
    )
  }).pipe(Effect.withSpan('restate.state.get', { attributes: { 'span.label': key } }))

const writeState = <S extends StateSchemas, K extends keyof S & string>(
  schemas: S,
  key: K,
  value: Schema.Schema.Type<S[K]>,
): Effect.Effect<void, RestateError, StateWrite | RestateContext> =>
  Effect.gen(function* () {
    const ctx = yield* RestateContext
    const objectCtx = ctx as restate.ObjectContext
    const encoded = yield* Schema.encode(schemas[key] as S[K])(value).pipe(
      Effect.mapError(
        (cause) => new RestateError({ reason: 'SerdeFailed', method: `State.set(${key})`, cause }),
      ),
    )
    objectCtx.set(key, encoded)
  }).pipe(Effect.withSpan('restate.state.set', { attributes: { 'span.label': key } }))

/**
 * Build the typed State combinator family bound to a contract's `state` block.
 * Phase 2's Object/Workflow `implement` calls this with the contract's schema
 * map; the combinators it returns are capability-gated and key/value-typed.
 */
export const stateFor = <S extends StateSchemas>(schemas: S) =>
  ({
    get: <K extends keyof S & string>(key: K) => readState(schemas, key),
    set: <K extends keyof S & string>(key: K, value: Schema.Schema.Type<S[K]>) =>
      writeState(schemas, key, value),
    clear: <K extends keyof S & string>(
      key: K,
    ): Effect.Effect<void, RestateError, StateWrite | RestateContext> =>
      Effect.gen(function* () {
        const ctx = yield* RestateContext
        ;(ctx as restate.ObjectContext).clear(key)
      }).pipe(Effect.withSpan('restate.state.clear', { attributes: { 'span.label': key } })),
    clearAll: (): Effect.Effect<void, RestateError, StateWrite | RestateContext> =>
      Effect.gen(function* () {
        const ctx = yield* RestateContext
        ;(ctx as restate.ObjectContext).clearAll()
      }).pipe(Effect.withSpan('restate.state.clearAll')),
    stateKeys: (): Effect.Effect<ReadonlyArray<string>, RestateError, StateRead | RestateContext> =>
      Effect.gen(function* () {
        const ctx = yield* RestateContext
        return yield* Effect.tryPromise({
          try: () => (ctx as restate.ObjectContext).stateKeys(),
          catch: (cause) =>
            new RestateError({ reason: 'RunFailed', method: 'State.stateKeys', cause }),
        })
      }).pipe(Effect.withSpan('restate.state.stateKeys')),
  }) as const
