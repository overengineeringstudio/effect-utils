import type { TerminalError as restateTerminalError } from '@restatedev/restate-sdk'
import type { Effect, Schema } from 'effect'

import type {
  DurablePromise,
  ObjectKey,
  RestateContext,
  StateRead,
  StateSchemas,
  StateWrite,
} from './RestateContext.ts'

/* eslint-disable @typescript-eslint/no-explicit-any -- phantom Schema/effect variance, per the validated type prototype */

/**
 * One handler's I/O/error Schemas. The error schema is the ONLY thing a
 * handler's `E` channel may carry (R11). Stored at a widened Schema type; the
 * precise per-handler types are recovered by indexing the contract's phantom
 * handler map (`InputOf`/`SuccessOf`/`ErrorOf`).
 */
export interface HandlerSpec {
  readonly input: Schema.Schema<any, any>
  readonly success: Schema.Schema<any, any>
  readonly error?: Schema.Schema<any, any>
  /** Per-handler SDK options (retry policy, retention, timeouts, …; R35, spec §7). */
  readonly options?: HandlerOptions
}

/** A map of handler name → `HandlerSpec`. */
export type HandlerSpecMap = Record<string, HandlerSpec>

/**
 * A shareable, client-side service CONTRACT: handler names + I/O/error Schemas
 * carried in the TYPE via the phantom `_Handlers` carrier (mirrors Restate's
 * phantom `ServiceDefinition<P, M>`). Clients import this for typed ingress
 * calls + serde with no server code; `implement` binds it to effects.
 *
 * The phantom keeps the precise `H` on the public type even when `handlers` is
 * read at a widened runtime type — `call`/`implement` index `H[method]`.
 */
export interface Contract<Name extends string, H extends HandlerSpecMap> {
  readonly _tag: 'Contract'
  readonly name: Name
  readonly handlers: H
  /** Service-level SDK options (retry policy, retention, timeouts, …; R35, spec §7). */
  readonly options?: ServiceLevelOptions
  /* Phantom (covariant) carrier so the precise `H` survives even when `handlers`
   * is read at a widened runtime type; `InputOf`/`SuccessOf`/`ErrorOf` recover it
   * by `infer`ring the `H` type param. */
  readonly _Handlers?: H
}

/* ── per-handler type recovery (indexed off the phantom handler map) ─────── */

/** The decoded input type of `contract`'s handler `M`. */
export type InputOf<C, M extends string> =
  C extends Contract<any, infer H>
    ? M extends keyof H
      ? Schema.Schema.Type<H[M]['input']>
      : never
    : never
/** The decoded success type of `contract`'s handler `M`. */
export type SuccessOf<C, M extends string> =
  C extends Contract<any, infer H>
    ? M extends keyof H
      ? Schema.Schema.Type<H[M]['success']>
      : never
    : never
/** The decoded declared-error type of `contract`'s handler `M` (`never` if none). */
export type ErrorOf<C, M extends string> =
  C extends Contract<any, infer H>
    ? M extends keyof H
      ? H[M]['error'] extends Schema.Schema<any, any>
        ? Schema.Schema.Type<H[M]['error']>
        : never
      : never
    : never
/** The handler-name union of `contract`. */
export type MethodsOf<C> = C extends Contract<any, infer H> ? keyof H & string : never

/**
 * The expected `implement` shape for a Service contract: each handler slot is a
 * function from the decoded input to an `Effect<Success, Error, AppR |
 * RestateContext>`. `AppR` is EXPLICIT (from the `Runtime<AppR>` `materialize`
 * runs against), never inferred (decision 0002 — else the residual `R` over-infers).
 */
export type ServiceImpl<C, AppR> =
  C extends Contract<any, infer H>
    ? {
        [M in keyof H]: (
          input: Schema.Schema.Type<H[M]['input']>,
        ) => Effect.Effect<
          Schema.Schema.Type<H[M]['success']>,
          H[M]['error'] extends Schema.Schema<any, any> ? Schema.Schema.Type<H[M]['error']> : never,
          AppR | RestateContext
        >
      }
    : never

/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * A bound implementation: the contract paired with its handler effects, plus a
 * phantom `_AppR` carrier so `materialize` can recover the explicit app `R`.
 * `materialize` (Endpoint) turns this into a `restate.service`.
 */
export interface ServiceImplementation<C extends Contract<string, HandlerSpecMap>, AppR> {
  readonly _tag: 'ServiceImplementation'
  readonly contract: C
  readonly impl: ServiceImpl<C, AppR>
  readonly _AppR?: (r: AppR) => void
}

/* ── builders ────────────────────────────────────────────────────────────── */

/**
 * Author a stateless Service contract. `const` type params keep the precise
 * handler map (`H`) on the returned `Contract<Name, H>` (it must NOT widen to
 * `Record<string, …>`).
 */
const contract = <const Name extends string, const H extends HandlerSpecMap>(
  name: Name,
  handlers: H,
  options?: ServiceLevelOptions,
): Contract<Name, H> => ({
  _tag: 'Contract',
  name,
  handlers,
  ...(options !== undefined ? { options } : {}),
})

/**
 * Bind a Service contract to its handler effects → a `ServiceImplementation`
 * that `materialize` (Endpoint) turns into a server-side `restate.service`.
 * `AppR` is an EXPLICIT type param: pass it as the app `R` the captured
 * `Runtime<AppR>` satisfies (decision 0002).
 */
const implement = <C extends Contract<string, HandlerSpecMap>, AppR = never>(
  contractValue: C,
  impl: ServiceImpl<C, AppR>,
): ServiceImplementation<C, AppR> => ({
  _tag: 'ServiceImplementation',
  contract: contractValue,
  impl,
})

/**
 * `contract` + `implement` in one expression for the single-package case (R36).
 * The separable `contract` artifact stays available for cross-package clients.
 */
const define = <const Name extends string, const H extends HandlerSpecMap, AppR = never>(
  name: Name,
  handlers: H,
  impl: ServiceImpl<Contract<Name, H>, AppR>,
): ServiceImplementation<Contract<Name, H>, AppR> => implement(contract(name, handlers), impl)

/** Declarative, Schema-typed stateless Service authoring (contract / implement). */
export const RestateService = { contract, implement, define } as const

/* ════════════════════════════════════════════════════════════════════════
 * Virtual Objects (keyed, typed State; exclusive vs shared handlers).
 * ════════════════════════════════════════════════════════════════════════ */

/* eslint-disable @typescript-eslint/no-explicit-any -- phantom variance, mirrors the type prototype */

/** One Object handler spec: I/O/error + a `shared` (read-only) flag + R35 options. */
export interface ObjectHandlerSpec extends HandlerSpec {
  readonly shared?: boolean
  readonly options?: HandlerOptions
}
/** A map of Object handler name → `ObjectHandlerSpec`. */
export type ObjectHandlerSpecMap = Record<string, ObjectHandlerSpec>

/** A keyed Virtual Object contract: typed `state` block + per-handler kind tags. */
export interface ObjectContract<
  Name extends string,
  S extends StateSchemas,
  H extends ObjectHandlerSpecMap,
> {
  readonly _tag: 'ObjectContract'
  readonly name: Name
  readonly state: S
  readonly handlers: H
  readonly options?: ServiceLevelOptions
  /* Covariant phantoms (like `Contract._Handlers`) so the precise `S`/`H` survive
   * widening without the contravariance that would break the `implement` constraint. */
  readonly _S?: S
  readonly _H?: H
}

/** Exclusive object handlers get write + read + key; shared get read + key only. */
type ObjectExclusiveCaps = RestateContext | ObjectKey | StateRead | StateWrite
type ObjectSharedCaps = RestateContext | ObjectKey | StateRead
type CapsForObjectHandler<HS extends ObjectHandlerSpec> = HS['shared'] extends true
  ? ObjectSharedCaps
  : ObjectExclusiveCaps

/**
 * The expected Object `implement` shape: each handler slot is typed by its OWN
 * permitted caps, so a `State.set` in a shared handler is a handler-LOCAL error
 * (validated, DQ3). `AppR` is explicit.
 */
export type ObjectImpl<H extends ObjectHandlerSpecMap, AppR> = {
  [M in keyof H]: (
    input: Schema.Schema.Type<H[M]['input']>,
  ) => Effect.Effect<
    Schema.Schema.Type<H[M]['success']>,
    H[M]['error'] extends Schema.Schema<any, any> ? Schema.Schema.Type<H[M]['error']> : never,
    AppR | CapsForObjectHandler<H[M]>
  >
}

/** A bound Object implementation (the contract + its per-kind handler effects). */
export interface ObjectImplementation<
  C extends ObjectContract<string, StateSchemas, ObjectHandlerSpecMap>,
  AppR,
> {
  readonly _tag: 'ObjectImplementation'
  readonly contract: C
  readonly impl: C extends ObjectContract<string, infer _S, infer H> ? ObjectImpl<H, AppR> : never
  readonly _AppR?: (r: AppR) => void
}

const objectContract = <
  const Name extends string,
  const S extends StateSchemas,
  const H extends ObjectHandlerSpecMap,
>(
  name: Name,
  def: { readonly state: S; readonly handlers: H; readonly options?: ServiceLevelOptions },
): ObjectContract<Name, S, H> => ({
  _tag: 'ObjectContract',
  name,
  state: def.state,
  handlers: def.handlers,
  ...(def.options !== undefined ? { options: def.options } : {}),
})

/**
 * Bind an Object contract to its per-kind handler effects. `materialize`
 * (Endpoint) wraps each as a `restate.object` handler — exclusive by default,
 * `restate.handlers.object.shared(...)` for `shared: true` handlers — providing
 * the legal capability markers per kind. `AppR` is explicit (decision 0002).
 */
const objectImplement = <
  C extends ObjectContract<string, StateSchemas, ObjectHandlerSpecMap>,
  AppR = never,
>(
  contractValue: C,
  impl: C extends ObjectContract<string, infer _S, infer H> ? ObjectImpl<H, AppR> : never,
): ObjectImplementation<C, AppR> => ({
  _tag: 'ObjectImplementation',
  contract: contractValue,
  impl,
})

/** Keyed Virtual Object authoring (typed State, exclusive/shared kinds). */
export const RestateObject = { contract: objectContract, implement: objectImplement } as const

/* ════════════════════════════════════════════════════════════════════════
 * Workflows (one `run`, signal/query shared handlers, durable promises).
 * ════════════════════════════════════════════════════════════════════════ */

/** One Workflow handler spec (used for `payload` / `signals` / `queries`). */
export interface WorkflowHandlerSpec extends HandlerSpec {
  readonly options?: HandlerOptions
}
/** A map of Workflow signal/query handler name → spec. */
export type WorkflowHandlerSpecMap = Record<string, WorkflowHandlerSpec>

/** A per-workflow-ID Workflow contract: one `run`, plus signals + queries. */
export interface WorkflowContract<
  Name extends string,
  S extends StateSchemas,
  Run extends WorkflowHandlerSpec,
  Signals extends WorkflowHandlerSpecMap,
  Queries extends WorkflowHandlerSpecMap,
> {
  readonly _tag: 'WorkflowContract'
  readonly name: Name
  readonly state: S
  readonly run: Run
  readonly signals: Signals
  readonly queries: Queries
  readonly options?: ServiceLevelOptions
  /* Covariant phantom so the precise type params survive widening (no contravariance). */
  readonly _Phantom?: readonly [S, Run, Signals, Queries]
}

/* Capability sets per Workflow handler kind (spec §3): `run` is the full set;
 * signals/queries are shared (read-only State) but may resolve/await durable
 * promises. A `State.set` in a signal/query is therefore a compile error. */
type WorkflowRunCaps = RestateContext | ObjectKey | StateRead | StateWrite | DurablePromise
type WorkflowSharedCaps = RestateContext | ObjectKey | StateRead | DurablePromise

/** The error type of a handler spec (`never` when no `error` schema is declared). */
type SpecError<HS extends HandlerSpec> =
  HS['error'] extends Schema.Schema<any, any> ? Schema.Schema.Type<HS['error']> : never

/**
 * The expected Workflow `implement` shape: the single `run` handler (full caps +
 * `DurablePromise`), plus signal + query handlers (shared, read-only State +
 * `DurablePromise`). `AppR` is explicit.
 */
export type WorkflowImpl<
  Run extends WorkflowHandlerSpec,
  Signals extends WorkflowHandlerSpecMap,
  Queries extends WorkflowHandlerSpecMap,
  AppR,
> = {
  readonly run: (
    input: Schema.Schema.Type<Run['input']>,
  ) => Effect.Effect<Schema.Schema.Type<Run['success']>, SpecError<Run>, AppR | WorkflowRunCaps>
} & {
  readonly [M in keyof Signals]: (
    input: Schema.Schema.Type<Signals[M]['input']>,
  ) => Effect.Effect<
    Schema.Schema.Type<Signals[M]['success']>,
    SpecError<Signals[M]>,
    AppR | WorkflowSharedCaps
  >
} & {
  readonly [M in keyof Queries]: (
    input: Schema.Schema.Type<Queries[M]['input']>,
  ) => Effect.Effect<
    Schema.Schema.Type<Queries[M]['success']>,
    SpecError<Queries[M]>,
    AppR | WorkflowSharedCaps
  >
}

/** A bound Workflow implementation (the contract + its per-kind handler effects). */
export interface WorkflowImplementation<
  C extends WorkflowContract<string, StateSchemas, WorkflowHandlerSpec, any, any>,
  AppR,
> {
  readonly _tag: 'WorkflowImplementation'
  readonly contract: C
  readonly impl: C extends WorkflowContract<string, infer _S, infer Run, infer Sig, infer Qry>
    ? WorkflowImpl<Run, Sig, Qry, AppR>
    : never
  readonly _AppR?: (r: AppR) => void
}

const workflowContract = <
  const Name extends string,
  const S extends StateSchemas,
  const Run extends WorkflowHandlerSpec,
  const Signals extends WorkflowHandlerSpecMap,
  const Queries extends WorkflowHandlerSpecMap,
>(
  name: Name,
  def: {
    readonly state: S
    readonly payload: Run
    readonly signals?: Signals
    readonly queries?: Queries
    readonly options?: ServiceLevelOptions
  },
): WorkflowContract<Name, S, Run, Signals, Queries> => ({
  _tag: 'WorkflowContract',
  name,
  state: def.state,
  run: def.payload,
  signals: (def.signals ?? {}) as Signals,
  queries: (def.queries ?? {}) as Queries,
  ...(def.options !== undefined ? { options: def.options } : {}),
})

/**
 * Bind a Workflow contract to its handler effects. `materialize` wraps `run` as
 * the `restate.workflow` run handler (full caps) and each signal/query as a
 * `restate.handlers.workflow.shared(...)` handler (read-only State + durable
 * promises). `AppR` is explicit (decision 0002).
 */
const workflowImplement = <
  C extends WorkflowContract<string, StateSchemas, WorkflowHandlerSpec, any, any>,
  AppR = never,
>(
  contractValue: C,
  impl: C extends WorkflowContract<string, infer _S, infer Run, infer Sig, infer Qry>
    ? WorkflowImpl<Run, Sig, Qry, AppR>
    : never,
): WorkflowImplementation<C, AppR> => ({
  _tag: 'WorkflowImplementation',
  contract: contractValue,
  impl,
})

/** Per-workflow-ID Workflow authoring (one `run`, signals, queries). */
export const RestateWorkflow = { contract: workflowContract, implement: workflowImplement } as const

/* ════════════════════════════════════════════════════════════════════════
 * Surfaced SDK options (R35). The idempotency/journal/timeout/ingressPrivate/
 * cancellation knobs, plus the retry surfacing (decision 0006, spec §7): a typed
 * `retryPolicy` and an `asTerminalError` hook mapped to the SDK at `materialize`.
 * ════════════════════════════════════════════════════════════════════════ */

/* eslint-disable @typescript-eslint/no-explicit-any -- the `asTerminalError` arg is the raw thrown error (any), matching the SDK signature */

/**
 * Restate's durable retry policy (decision 0006, spec §7). Durable retries are
 * Restate's — `Effect.retry`/`Schedule` are for PURE logic only (the
 * `overeng/no-raw-nondeterminism` lint guards against wrapping durable ops). This
 * mirrors the SDK `RetryPolicy`: intervals are millis (decoded by the boundary);
 * `onMaxAttempts` decides what happens after the last attempt — `'pause'` makes
 * the invocation resumable from the CLI/UI, `'kill'` auto-kills it.
 */
export interface RetryPolicyOptions {
  readonly maxAttempts?: number
  readonly initialIntervalMillis?: number
  readonly maxIntervalMillis?: number
  readonly exponentiationFactor?: number
  readonly onMaxAttempts?: 'pause' | 'kill'
}

/** Per-handler options surfaced from the SDK `*HandlerOpts` (R35, decision 0006). */
export interface HandlerOptions {
  readonly idempotencyRetentionMillis?: number
  readonly journalRetentionMillis?: number
  readonly inactivityTimeoutMillis?: number
  readonly abortTimeoutMillis?: number
  /** Service-to-service only: omit the handler from the ingress client surface. */
  readonly ingressPrivate?: boolean
  readonly enableLazyState?: boolean
  readonly explicitCancellation?: boolean
  /** Restate's durable retry policy for this handler (spec §7). */
  readonly retryPolicy?: RetryPolicyOptions
  /**
   * Map a thrown (non-`TerminalError`) error to a `TerminalError` so Restate does
   * NOT retry it — the SDK-level escape hatch for "this raw throw is terminal".
   * Domain errors should prefer the `Restate.terminal`/`retryable` annotation; this
   * is for foreign throws from inside `ctx.run` etc. (spec §7).
   */
  readonly asTerminalError?: (error: any) => restateTerminalError | undefined
}

/** Service/object/workflow-level options surfaced from the SDK (R35, decision 0006). */
export interface ServiceLevelOptions {
  readonly idempotencyRetentionMillis?: number
  readonly journalRetentionMillis?: number
  readonly inactivityTimeoutMillis?: number
  readonly abortTimeoutMillis?: number
  readonly ingressPrivate?: boolean
  readonly enableLazyState?: boolean
  readonly workflowRetentionMillis?: number
  readonly explicitCancellation?: boolean
  /** Restate's durable retry policy for every handler of this construct (spec §7). */
  readonly retryPolicy?: RetryPolicyOptions
  /** Service-level `asTerminalError` mapping (spec §7). */
  readonly asTerminalError?: (error: any) => restateTerminalError | undefined
}

/* eslint-enable @typescript-eslint/no-explicit-any */

/* ── per-method type recovery for Objects / Workflows (client inference) ──── */

/** The method-name union of an Object contract. */
export type ObjectMethodsOf<C> =
  C extends ObjectContract<any, any, infer H> ? keyof H & string : never
/** The decoded input of Object `contract`'s handler `M`. */
export type ObjectInputOf<C, M extends string> =
  C extends ObjectContract<any, any, infer H>
    ? M extends keyof H
      ? Schema.Schema.Type<H[M]['input']>
      : never
    : never
/** The decoded success of Object `contract`'s handler `M`. */
export type ObjectSuccessOf<C, M extends string> =
  C extends ObjectContract<any, any, infer H>
    ? M extends keyof H
      ? Schema.Schema.Type<H[M]['success']>
      : never
    : never
/** The decoded declared-error of Object `contract`'s handler `M` (`never` if none). */
export type ObjectErrorOf<C, M extends string> =
  C extends ObjectContract<any, any, infer H>
    ? M extends keyof H
      ? H[M]['error'] extends Schema.Schema<any, any>
        ? Schema.Schema.Type<H[M]['error']>
        : never
      : never
    : never

/** The signal/query method-name union of a Workflow contract (excludes `run`). */
export type WorkflowSignalQueryOf<C> =
  C extends WorkflowContract<any, any, any, infer Sig, infer Qry>
    ? (keyof Sig & string) | (keyof Qry & string)
    : never
/** The decoded `run` input of a Workflow contract. */
export type WorkflowRunInputOf<C> =
  C extends WorkflowContract<any, any, infer Run, any, any>
    ? Schema.Schema.Type<Run['input']>
    : never
/** The decoded `run` success of a Workflow contract. */
export type WorkflowRunSuccessOf<C> =
  C extends WorkflowContract<any, any, infer Run, any, any>
    ? Schema.Schema.Type<Run['success']>
    : never
/** The decoded `run` declared-error of a Workflow contract (`never` if none). */
export type WorkflowRunErrorOf<C> =
  C extends WorkflowContract<any, any, infer Run, any, any>
    ? Run['error'] extends Schema.Schema<any, any>
      ? Schema.Schema.Type<Run['error']>
      : never
    : never
/** The combined signal+query map of a Workflow contract. */
type WorkflowSignalQueryMap<C> =
  C extends WorkflowContract<any, any, any, infer Sig, infer Qry> ? Sig & Qry : never
/** The decoded input of a Workflow signal/query handler `M`. */
export type WorkflowSignalInputOf<C, M extends string> = M extends keyof WorkflowSignalQueryMap<C>
  ? Schema.Schema.Type<WorkflowSignalQueryMap<C>[M]['input']>
  : never
/** The decoded success of a Workflow signal/query handler `M`. */
export type WorkflowSignalSuccessOf<C, M extends string> = M extends keyof WorkflowSignalQueryMap<C>
  ? Schema.Schema.Type<WorkflowSignalQueryMap<C>[M]['success']>
  : never

/* eslint-enable @typescript-eslint/no-explicit-any */
