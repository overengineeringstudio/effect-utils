import * as restate from '@restatedev/restate-sdk'
import type { Brand } from 'effect'
import { Context, Effect, Option, Runtime, Schema } from 'effect'

import { readIdempotencyKey } from './Annotations.ts'
import { RestateError } from './RestateError.ts'
import { internalSerde } from './Serde.ts'

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

/* ── durable-op rejection handling (cancellation/suspension preservation) ─── */

/**
 * Whether a durable-op rejection is a Restate cancellation (`CancelledError`,
 * which `extends TerminalError`) — the cooperative-cancel signal a suspended
 * durable op (e.g. `ctx.sleep`) rejects with when the invocation is cancelled
 * (R31, spec §5a). It must NOT be wrapped into a `RestateError` defect (which
 * would be retried); it has to propagate so the boundary terminalizes it as a
 * non-retried cancellation.
 */
const isCancellation = (cause: unknown): cause is restate.CancelledError =>
  cause instanceof restate.CancelledError

/**
 * Await a durable-op promise, classifying the rejection so cancellation and
 * suspension are NOT wrapped into a `RestateError` (which would be retried):
 *
 * - A `CancelledError` (cooperative cancel; R31) → re-throw as an Effect
 *   INTERRUPT, so the handler's `acquireRelease` / `onInterrupt` finalizers and
 *   compensations RUN. The boundary then re-maps the interrupt to a
 *   `CancelledError` (terminal, not retried).
 * - A Restate SUSPENSION (`isSuspendedError`) → re-throw the original suspended
 *   error AS-IS (as a defect), so `toTerminal` re-throws it verbatim and the SDK
 *   suspends/resumes. Finalizers must NOT run here — the work resumes in a new
 *   attempt (R15).
 * - Any other rejection (a real infra failure / give-up after `ctx.run` retries)
 *   → fail with the wrapper's `RestateError` (a defect by `orDie` default; the SDK
 *   retries it).
 *
 * This is the single seam where a durable rejection is classified, so every
 * durable combinator (`run` / `sleep` / `timeout` / `all` / `race` / `any`)
 * handles cancellation/suspension identically.
 */
const awaitDurable = <A>(
  thunk: () => Promise<A>,
  onError: (cause: unknown) => RestateError,
): Effect.Effect<A, RestateError, never> =>
  Effect.async<A, RestateError>((resume) => {
    thunk().then(
      (value) => resume(Effect.succeed(value)),
      (cause: unknown) => {
        /* Cancellation → interrupt (finalizers run, not retried). */
        if (isCancellation(cause) === true) {
          resume(Effect.interrupt)
          return
        }
        /* Suspension → re-throw the original verbatim as a defect (the SDK
         * suspends/resumes; finalizers must NOT run — work resumes next attempt). */
        if (restate.internal.isSuspendedError(cause) === true) {
          resume(Effect.die(cause))
          return
        }
        resume(Effect.fail(onError(cause)))
      },
    )
  })

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
    return yield* awaitDurable(
      () => ctx.run(name, () => Runtime.runPromise(runtime)(inner)),
      (cause) => new RestateError({ reason: 'RunFailed', method: `run(${name})`, cause }),
    )
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
    yield* awaitDurable(
      () => ctx.sleep(millis, name),
      (cause) => new RestateError({ reason: 'SleepFailed', method: `sleep(${millis})`, cause }),
    )
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
    return yield* awaitDurable(
      () =>
        descr
          .issue(ctx)
          .orTimeout(millis)
          .map((value?: A) => value),
      (cause) => new RestateError({ reason: 'RunFailed', method: `timeout(${millis})`, cause }),
    )
  }).pipe(Effect.withSpan('restate.timeout', { attributes: { 'span.label': `${millis}ms` } }))

/**
 * Combine durable-op descriptors deterministically. Issues every descriptor
 * SYNCHRONOUSLY in source order to obtain the `RestatePromise[]` (fixing the
 * journal order), hands the array to the SDK `combine` (`all`/`race`/`any`), and
 * awaits the SINGLE resulting `RestatePromise` ONCE via `awaitDurable`, mapping
 * the result after (never `.then`-chaining pre-await — `.then` is the SDK's
 * suspension seam; `awaitDurable` also preserves cancellation/suspension). See
 * decision 0005.
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
      return yield* awaitDurable(
        () => combine(descriptors.map((d) => d.issue(ctx))),
        (cause) => new RestateError({ reason: 'RunFailed', method: label, cause }),
      )
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

/* ── ObjectKey accessor (capability-gated) ───────────────────────────────── */

/**
 * The key of the current Object / Workflow invocation. Requires `ObjectKey`, so
 * it compile-fails in a Service handler (no key). Backed by `ctx.key`.
 */
export const objectKey: Effect.Effect<string, never, ObjectKey | RestateContext> = Effect.gen(
  function* () {
    const ctx = yield* RestateContext
    return (ctx as restate.ObjectContext).key
  },
).pipe(Effect.withSpan('restate.objectKey'))

/* ── Durable promises (Workflow cross-handler signalling) ────────────────── */
/*
 * A Workflow durable promise: a named, durable rendezvous between the `run`
 * handler (which awaits it) and a shared signal handler (which resolves/rejects
 * it). Capability-gated on `DurablePromise`. The payload is decode/encode'd via
 * the contract's per-name Schema on the `internal` slot — a decode failure is a
 * corrupt-journal defect (R13, spec §4). `get` blocks until resolved; `peek` is a
 * non-blocking read (`undefined` if unresolved); `resolve`/`reject` complete it
 * (a `reject` makes the awaiting `get` fail terminally — drives the `'rejected'`
 * path, R34). `getDescriptor` issues the promise as a `Descriptor` for
 * `Restate.race`/`all`/`any`.
 */

const promiseSerde = <T, I>(schema: Schema.Schema<T, I>): restate.Serde<T> => internalSerde(schema)

const promiseGet = <T, I>(
  name: string,
  schema: Schema.Schema<T, I>,
): Effect.Effect<T, RestateError, DurablePromise | RestateContext> =>
  Effect.gen(function* () {
    const ctx = yield* RestateContext
    return yield* Effect.tryPromise({
      try: () =>
        (ctx as restate.WorkflowSharedContext).promise<T>(name, promiseSerde(schema)).get(),
      catch: (cause) =>
        new RestateError({ reason: 'RunFailed', method: `DurablePromise.get(${name})`, cause }),
    })
  }).pipe(Effect.withSpan('restate.promise.get', { attributes: { 'span.label': name } }))

const promisePeek = <T, I>(
  name: string,
  schema: Schema.Schema<T, I>,
): Effect.Effect<T | undefined, RestateError, DurablePromise | RestateContext> =>
  Effect.gen(function* () {
    const ctx = yield* RestateContext
    return yield* Effect.tryPromise({
      try: () =>
        (ctx as restate.WorkflowSharedContext).promise<T>(name, promiseSerde(schema)).peek(),
      catch: (cause) =>
        new RestateError({ reason: 'RunFailed', method: `DurablePromise.peek(${name})`, cause }),
    })
  }).pipe(Effect.withSpan('restate.promise.peek', { attributes: { 'span.label': name } }))

const promiseResolve = <T, I>(
  name: string,
  schema: Schema.Schema<T, I>,
  value: T,
): Effect.Effect<void, RestateError, DurablePromise | RestateContext> =>
  Effect.gen(function* () {
    const ctx = yield* RestateContext
    yield* Effect.tryPromise({
      try: () =>
        (ctx as restate.WorkflowSharedContext)
          .promise<T>(name, promiseSerde(schema))
          .resolve(value),
      catch: (cause) =>
        new RestateError({ reason: 'RunFailed', method: `DurablePromise.resolve(${name})`, cause }),
    })
  }).pipe(Effect.withSpan('restate.promise.resolve', { attributes: { 'span.label': name } }))

const promiseReject = <T, I>(
  name: string,
  schema: Schema.Schema<T, I>,
  reason: string,
): Effect.Effect<void, RestateError, DurablePromise | RestateContext> =>
  Effect.gen(function* () {
    const ctx = yield* RestateContext
    yield* Effect.tryPromise({
      try: () =>
        (ctx as restate.WorkflowSharedContext)
          .promise<T>(name, promiseSerde(schema))
          .reject(reason),
      catch: (cause) =>
        new RestateError({ reason: 'RunFailed', method: `DurablePromise.reject(${name})`, cause }),
    })
  }).pipe(Effect.withSpan('restate.promise.reject', { attributes: { 'span.label': name } }))

/**
 * Build the typed durable-promise combinator family for one payload Schema. Each
 * combinator is capability-gated on `DurablePromise` (Workflow handlers only) and
 * payload-typed. `getDescriptor` issues the promise for deterministic concurrency.
 */
export const durablePromiseFor = <T, I>(schema: Schema.Schema<T, I>) =>
  ({
    get: (name: string) => promiseGet(name, schema),
    peek: (name: string) => promisePeek(name, schema),
    resolve: (name: string, value: T) => promiseResolve(name, schema, value),
    reject: (name: string, reason: string) => promiseReject(name, schema, reason),
    getDescriptor: (name: string): Descriptor<T> =>
      descriptor<T>('promiseGet', (ctx) =>
        (ctx as restate.WorkflowSharedContext).promise<T>(name, promiseSerde(schema)).get(),
      ),
  }) as const

/* ── Awakeables (external completion tokens) ─────────────────────────────── */

/** The nominal awakeable-id brand (independent of payload — the `<T>` tag rides below). */
type AwakeableIdBrand = Brand.Brand<'@overeng/restate-effect/AwakeableId'>

/**
 * Branded awakeable id (typed against its payload — see `Awakeable.make`). The
 * payload `T` rides in a property whose KEY is unique per payload type via the
 * intersection, but `T` is kept OUT of any inference-driving position: the resolve
 * combinators infer their `T` from the payload SCHEMA (the single source), never
 * from the id, so a mismatched id is a plain assignability error, not a `T` shift.
 */
export type AwakeableId<T> = string & AwakeableIdBrand & { readonly _payload?: T }

/**
 * Create an awakeable: a typed external-completion token. Returns its branded
 * `id` (send it to an external system / another handler) and a `promise` Effect
 * that SUSPENDS until the awakeable is resolved (via ingress `resolveAwakeable`
 * or another handler). The payload is decode/encode'd via `schema` on the
 * `internal` slot. Requires `RestateContext` (legal in any handler kind). A
 * rejection surfaces the awaiting `promise` as a `RestateError`.
 */
export const makeAwakeable = <T, I>(
  schema: Schema.Schema<T, I>,
): Effect.Effect<
  { readonly id: AwakeableId<T>; readonly promise: Effect.Effect<T, RestateError, never> },
  never,
  RestateContext
> =>
  Effect.gen(function* () {
    const ctx = yield* RestateContext
    const aw = ctx.awakeable<T>(promiseSerde(schema))
    const promise = Effect.tryPromise({
      try: () => aw.promise,
      catch: (cause) => new RestateError({ reason: 'RunFailed', method: 'Awakeable.await', cause }),
    }).pipe(Effect.withSpan('restate.awakeable.await', { attributes: { 'span.label': aw.id } }))
    return { id: aw.id as AwakeableId<T>, promise }
  }).pipe(Effect.withSpan('restate.awakeable.make'))

/** Resolve an awakeable in-handler with a typed payload (encoded via `schema`). */
export const resolveAwakeable = <T, I>(
  schema: Schema.Schema<T, I>,
  id: AwakeableId<T>,
  payload: T,
): Effect.Effect<void, never, RestateContext> =>
  Effect.gen(function* () {
    const ctx = yield* RestateContext
    ctx.resolveAwakeable<T>(id, payload, promiseSerde(schema))
  }).pipe(Effect.withSpan('restate.awakeable.resolve', { attributes: { 'span.label': id } }))

/** Reject an awakeable in-handler with a reason (the awaiter fails terminally). */
export const rejectAwakeable = <T>(
  id: AwakeableId<T>,
  reason: string,
): Effect.Effect<void, never, RestateContext> =>
  Effect.gen(function* () {
    const ctx = yield* RestateContext
    ctx.rejectAwakeable(id, reason)
  }).pipe(Effect.withSpan('restate.awakeable.reject', { attributes: { 'span.label': id } }))

/* ── In-handler service-to-service clients ───────────────────────────────── */
/*
 * Typed request/response (`call`) and one-way (`send`, optionally delayed)
 * service-to-service invocations from inside a handler, routed by the target
 * contract's name + the `generic*` SDK surface so no `restate.service` value is
 * needed at the call site. Input encoded / success decoded via the target's serde
 * (`ingress` slot — a peer call is a caller-facing boundary). The idempotency key
 * is read from the annotated input field (decision 0011), never a call-site
 * option. `key` routes to a Virtual Object / Workflow instance.
 */

const clientCallSerde = <T, I>(schema: Schema.Schema<T, I>): restate.Serde<T> =>
  internalSerde(schema)

/** Options threaded through an in-handler one-way `send` (delay only — key is positional). */
export interface SendOptions {
  /** Delay the send by this many milliseconds (durable, fault-tolerant cron). */
  readonly delayMillis?: number
}

const callRpc = <In, InI, Out, OutI>(opts: {
  readonly service: string
  readonly handler: string
  readonly inputSchema: Schema.Schema<In, InI>
  readonly outputSchema: Schema.Schema<Out, OutI>
  readonly input: In
  readonly key?: string
}): Effect.Effect<Out, RestateError, RestateContext> =>
  Effect.gen(function* () {
    const ctx = yield* RestateContext
    const idempotencyKey = readIdempotencyKey(opts.inputSchema.ast, opts.input).pipe(
      Option.getOrUndefined,
    )
    const result = yield* Effect.tryPromise({
      try: () =>
        ctx.genericCall<In, Out>({
          service: opts.service,
          method: opts.handler,
          parameter: opts.input,
          ...(opts.key !== undefined ? { key: opts.key } : {}),
          inputSerde: clientCallSerde(opts.inputSchema),
          outputSerde: clientCallSerde(opts.outputSchema),
          ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        }),
      catch: (cause) =>
        new RestateError({
          reason: 'IngressFailed',
          method: `call(${opts.service}.${opts.handler})`,
          cause,
        }),
    })
    return result as Out
  }).pipe(
    Effect.withSpan('restate.client.call', {
      attributes: { 'span.label': `${opts.service}.${opts.handler}` },
    }),
  )

const sendRpc = <In, InI>(opts: {
  readonly service: string
  readonly handler: string
  readonly inputSchema: Schema.Schema<In, InI>
  readonly input: In
  readonly key?: string
  readonly delayMillis?: number
}): Effect.Effect<void, RestateError, RestateContext> =>
  Effect.gen(function* () {
    const ctx = yield* RestateContext
    const idempotencyKey = readIdempotencyKey(opts.inputSchema.ast, opts.input).pipe(
      Option.getOrUndefined,
    )
    yield* Effect.try({
      try: () =>
        ctx.genericSend<In>({
          service: opts.service,
          method: opts.handler,
          parameter: opts.input,
          ...(opts.key !== undefined ? { key: opts.key } : {}),
          inputSerde: clientCallSerde(opts.inputSchema),
          ...(opts.delayMillis !== undefined ? { delay: opts.delayMillis } : {}),
          ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        }),
      catch: (cause) =>
        new RestateError({
          reason: 'IngressFailed',
          method: `send(${opts.service}.${opts.handler})`,
          cause,
        }),
    })
  }).pipe(
    Effect.withSpan('restate.client.send', {
      attributes: { 'span.label': `${opts.service}.${opts.handler}` },
    }),
  )

/** Internal seam used by the typed `Restate.call/send/objectClient/...` surface. */
export const inHandlerClients = { callRpc, sendRpc } as const
