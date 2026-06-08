import type { Effect, Schema } from 'effect'

import type {
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
): Contract<Name, H> => ({ _tag: 'Contract', name, handlers })

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
 * Phase 2 scaffolding — typed Object / Workflow contract builders.
 *
 * These TYPECHECK (their capability machinery is the validated prototype's),
 * but `implement` THROWS at runtime: Phase 2 fills handler-kind capability
 * provisioning (exclusive vs shared) and the run/shared semantics. Kept here so
 * the markers + contract shapes are reused, not redesigned, in Phase 2.
 * ════════════════════════════════════════════════════════════════════════ */

/* eslint-disable @typescript-eslint/no-explicit-any -- phantom variance, mirrors the type prototype */

/** One Object handler spec: I/O/error + a `shared` (read-only) flag. */
export interface ObjectHandlerSpec extends HandlerSpec {
  readonly shared?: boolean
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
  readonly _S?: (s: S) => void
  readonly _H?: (h: H) => void
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
  def: { readonly state: S; readonly handlers: H },
): ObjectContract<Name, S, H> => ({
  _tag: 'ObjectContract',
  name,
  state: def.state,
  handlers: def.handlers,
})

const objectImplement = <
  C extends ObjectContract<string, StateSchemas, ObjectHandlerSpecMap>,
  AppR = never,
>(
  contractValue: C,
  impl: C extends ObjectContract<string, infer _S, infer H> ? ObjectImpl<H, AppR> : never,
): ObjectImplementation<C, AppR> => {
  void contractValue
  void impl
  throw new Error('RestateObject.implement is Phase 2')
}

/** Phase 2: keyed Virtual Object authoring (typed State, exclusive/shared kinds). */
export const RestateObject = { contract: objectContract, implement: objectImplement } as const

/** One Workflow handler spec (used for `payload` / `signals` / `queries`). */
export type WorkflowHandlerSpecMap = Record<string, HandlerSpec>

/** A per-workflow-ID Workflow contract: one `run`, durable promises. */
export interface WorkflowContract<
  Name extends string,
  S extends StateSchemas,
  Run extends HandlerSpec,
  Signals extends WorkflowHandlerSpecMap,
  Queries extends WorkflowHandlerSpecMap,
> {
  readonly _tag: 'WorkflowContract'
  readonly name: Name
  readonly state: S
  readonly run: Run
  readonly signals: Signals
  readonly queries: Queries
  readonly _Phantom?: (x: [S, Run, Signals, Queries]) => void
}

const workflowContract = <
  const Name extends string,
  const S extends StateSchemas,
  const Run extends HandlerSpec,
  const Signals extends WorkflowHandlerSpecMap,
  const Queries extends WorkflowHandlerSpecMap,
>(
  name: Name,
  def: {
    readonly state: S
    readonly payload: Run
    readonly signals?: Signals
    readonly queries?: Queries
  },
): WorkflowContract<Name, S, Run, Signals, Queries> => ({
  _tag: 'WorkflowContract',
  name,
  state: def.state,
  run: def.payload,
  signals: (def.signals ?? {}) as Signals,
  queries: (def.queries ?? {}) as Queries,
})

const workflowImplement = (..._args: ReadonlyArray<unknown>): never => {
  throw new Error('RestateWorkflow.implement is Phase 2')
}

/** Phase 2: per-workflow-ID Workflow authoring (one `run`, signals, queries). */
export const RestateWorkflow = { contract: workflowContract, implement: workflowImplement } as const

/* eslint-enable @typescript-eslint/no-explicit-any */
