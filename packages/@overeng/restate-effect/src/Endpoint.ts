import * as http2 from 'node:http2'

import * as restate from '@restatedev/restate-sdk'
import { createEndpointHandler } from '@restatedev/restate-sdk/node'
import type { Config } from 'effect'
import {
  Cause,
  Chunk,
  type ConfigError,
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Runtime,
  Schema,
} from 'effect'

import {
  readErrorClass,
  readRetention,
  readRetryAfterMillis,
  type RetentionOptions,
} from './Annotations.ts'
import { emitAttempt, emitInvocationMetrics, monotonicMs } from './Metrics.ts'
import { type RedactionCipher, RestateRedaction } from './Redaction.ts'
import { ObjectKey, RestateContext, StateRead, StateWrite } from './RestateContext.ts'
import { DurablePromise } from './RestateContext.ts'
import { RestateError } from './RestateError.ts'
import { determinismLayer, loggerLayer, withAttemptInterruption } from './Runtime.ts'
import { ingressSerde } from './Serde.ts'
import type {
  Contract,
  HandlerOptions,
  HandlerSpec,
  HandlerSpecMap,
  ObjectContract,
  ObjectHandlerSpec,
  ObjectHandlerSpecMap,
  ObjectImplementation,
  RetryPolicyOptions,
  ServiceImplementation,
  ServiceLevelOptions,
  WorkflowContract,
  WorkflowHandlerSpec,
  WorkflowHandlerSpecMap,
  WorkflowImplementation,
} from './Service.ts'

/* eslint-disable @typescript-eslint/no-explicit-any -- the materialize boundary deliberately erases the contract's phantom map (invisible to users; the public Contract type stays precise) */

/**
 * The boundary's classification of a handler exit (spec §5, §10). A SINGLE source
 * of truth read by BOTH the `throw`-producing `toTerminal` and the observability
 * boundary observer ({@link BoundaryObserver}) — so the span attributes / metrics
 * an operator slices on (`restate.error.{tag,class}`, `restate_invocations_total`
 * `outcome`) match the actual SDK outcome exactly (decision 0014).
 *
 * - `success` — the handler returned a value.
 * - `terminal` — a declared domain failure that fails the invocation WITHOUT
 *   retry (the `terminal` annotation, or the default for an unclassified domain
 *   error). `errorTag` is the domain error's `_tag` (when present).
 * - `retryable` — a declared domain failure the SDK RETRIES (the `retryable`
 *   annotation), honoring `retryAfter`. `errorTag` is the domain error's `_tag`.
 * - `cancelled` — an interruption (Restate cancellation bridged to the fiber, or
 *   an in-handler interrupt); finalizers/compensations already ran. Terminal, not
 *   retried (R31, §5a).
 * - `suspended` — a Restate suspension (a durable op parking the attempt); NOT an
 *   outcome an operator counts (the invocation has not finished) — re-thrown as-is.
 * - `defect` — anything else; the SDK throws it as a normal error and RETRIES.
 */
export type BoundaryOutcome =
  | { readonly _tag: 'success' }
  | { readonly _tag: 'terminal'; readonly errorTag: string | undefined; readonly thrown: unknown }
  | { readonly _tag: 'retryable'; readonly errorTag: string | undefined; readonly thrown: unknown }
  | { readonly _tag: 'cancelled'; readonly thrown: unknown }
  | { readonly _tag: 'suspended'; readonly thrown: unknown }
  | { readonly _tag: 'defect'; readonly thrown: unknown }

/** The error-class label stamped on the boundary span / used as the metric `outcome`. */
export type BoundaryErrorClass = 'terminal' | 'retryable' | 'cancelled'

/**
 * Resolve the declared-error schema NODE that actually classifies `error` (spec
 * §5). The `terminal`/`retryable` annotation lives on a SINGLE error member, but a
 * contract's declared `error` is commonly a `Schema.Union` of several members (e.g.
 * a `retryable` 429 alongside a `terminal` 404). The annotation lives on the UNION
 * MEMBERS, not the union node, so reading `readErrorClass(union.ast)` always misses
 * it and mis-classifies every retryable member as the default `terminal`. We pick
 * the member whose `encodeUnknownEither` accepts the failing error and read the
 * annotation off THAT member; a non-union schema (or no match) passes through
 * unchanged. The encode itself still uses the original schema (the union encodes
 * fine), so only the CLASSIFICATION read is narrowed.
 */
const resolveErrorMember = (
  errorSchema: Schema.Schema<any, any>,
  error: unknown,
): Schema.Schema<any, any> => {
  const ast = errorSchema.ast
  if (ast._tag !== 'Union') return errorSchema
  for (const member of ast.types) {
    const memberSchema = Schema.make(member)
    if (Schema.encodeUnknownEither(memberSchema)(error)._tag === 'Right') return memberSchema
  }
  return errorSchema
}

/**
 * Classify an Effect failure `Cause` into a {@link BoundaryOutcome} (spec §5,
 * §10). The throw value the SDK sees rides in `thrown`; {@link toTerminal} just
 * unwraps it. Reads the failing error's `terminal`/`retryable` annotation to
 * decide errorCode vs a retryable throw — resolving the matching UNION MEMBER
 * first (see {@link resolveErrorMember}) so a `retryable` member of a declared
 * error UNION is honored, not silently mis-classified as terminal:
 *
 * - Typed domain failure (declared `error` schema): encode it and produce a
 *   `restate.TerminalError`. The encoded body AND its `_tag` ride in the message
 *   BODY (JSON) — the only channel an ingress caller's `responseText` can read.
 *   `errorCode` comes from the error's `terminal` annotation (default 500);
 *   `_tag` is ALSO mirrored into `metadata` best-effort (server ≥1.6).
 * - `retryable`-annotated domain failure → a `RetryableError` (Restate retries),
 *   honoring `retryAfter`.
 * - A Restate suspension (`isSuspendedError`) → re-thrown as-is, never terminalized.
 * - An Effect INTERRUPTION → a `CancelledError` (which `extends TerminalError`),
 *   so the SDK does NOT retry it.
 * - Anything else (defect) → the squashed cause so the SDK throws it and RETRIES.
 */
export const classifyOutcome = (
  cause: Cause.Cause<unknown>,
  errorSchema?: Schema.Schema<any, any>,
): BoundaryOutcome => {
  /* A Restate suspension (a durable op suspending the attempt) may arrive as a
   * DEFECT (a durable combinator re-throws it verbatim via `Effect.die`, see
   * `awaitDurable`). Re-throw it AS-IS so the SDK suspends/resumes — never
   * terminalize or retry it (R15). Checked first: a suspension defect is not a
   * domain failure. */
  const suspensionDefect = Chunk.findFirst(Cause.defects(cause), (d) =>
    restate.internal.isSuspendedError(d),
  )
  if (Option.isSome(suspensionDefect) === true) {
    return { _tag: 'suspended', thrown: suspensionDefect.value }
  }

  const failure = Cause.failureOption(cause)
  if (failure._tag === 'Some') {
    const error = failure.value
    /* A Restate suspension is never a real failure — never terminalize it. */
    if (restate.internal.isSuspendedError(error) === true) {
      return { _tag: 'suspended', thrown: Cause.squash(cause) }
    }

    /* Validate the thrown failure against the contract's declared `error` union
     * BEFORE classifying/encoding it. A failure that does NOT match the declared
     * union is error-classification DRIFT (a handler failed with an undeclared
     * error) — surface it as a DEFECT (no silent mis-encode), so the SDK retries
     * and the bug is visible, rather than encoding garbage into the terminal body. */
    const encoded =
      errorSchema !== undefined ? Schema.encodeUnknownEither(errorSchema)(error) : undefined
    if (errorSchema !== undefined && encoded !== undefined && encoded._tag === 'Left') {
      return { _tag: 'defect', thrown: Cause.squash(cause) }
    }

    /* Read the classification off the matching union MEMBER (or the schema itself
     * when it is not a union), so a `retryable` member of a declared error union is
     * honored rather than read off the un-annotated union node. */
    const classification =
      errorSchema !== undefined
        ? readErrorClass(resolveErrorMember(errorSchema, error).ast).pipe(
            Option.getOrElse(() => undefined),
          )
        : undefined
    const tag =
      typeof error === 'object' && error !== null && '_tag' in error
        ? String((error as { _tag: unknown })._tag)
        : undefined

    if (classification?._tag === 'retryable') {
      /* Project `retryAfter` from the ACTUAL error instance (#3): a static value
       * is decoded as-is; a projection reads the floor off this very error (e.g. a
       * 429's `e.retryAfterMillis`). */
      const retryAfter = readRetryAfterMillis(classification.retryAfter, error)
      return {
        _tag: 'retryable',
        errorTag: tag,
        thrown: restate.RetryableError.from(error, retryAfter !== undefined ? { retryAfter } : {}),
      }
    }

    const errorCode = classification?._tag === 'terminal' ? classification.errorCode : 500
    const body = encoded !== undefined && encoded._tag === 'Right' ? encoded.right : error
    return {
      _tag: 'terminal',
      errorTag: tag,
      thrown: new restate.TerminalError(JSON.stringify(body), {
        errorCode,
        ...(tag !== undefined ? { metadata: { _tag: tag } } : {}),
      }),
    }
  }
  /* An interruption (Restate cancellation bridged to the fiber, or an in-handler
   * interrupt — incl. a durable op that rejected with `CancelledError`) is neither
   * a domain failure nor a defect: finalizers/compensations already ran.
   * Terminalize as a `CancelledError` so the SDK does NOT retry it (R31, §5a).
   * (A suspension is already handled above as a defect, never reaching here.) */
  if (Cause.isInterrupted(cause) === true) {
    return { _tag: 'cancelled', thrown: new restate.CancelledError() }
  }
  /* Defect → let the SDK retry. */
  return { _tag: 'defect', thrown: Cause.squash(cause) }
}

/**
 * The value the SDK handler must throw for a failure `Cause` (spec §5). A thin
 * unwrap of {@link classifyOutcome}'s `thrown` — kept as a named export for the
 * unit tests and any direct boundary use.
 */
export const toTerminal = (
  cause: Cause.Cause<unknown>,
  errorSchema?: Schema.Schema<any, any>,
): unknown => {
  const outcome = classifyOutcome(cause, errorSchema)
  return outcome._tag === 'success' ? undefined : outcome.thrown
}

/* An untyped Effect handler bound to a single contract handler. */
type EffectHandler = (input: unknown) => Effect.Effect<unknown, unknown, any>

/* The original-invocation header carrying the idempotency key (verified against
 * `@restatedev/restate-sdk-clients` 1.14.5: `IDEMPOTENCY_KEY_HEADER`). Lower-cased
 * — HTTP header names are case-insensitive and the SDK stores them lower-cased. */
const IDEMPOTENCY_KEY_HEADER = 'idempotency-key'

/**
 * Read the idempotency key off the ORIGINAL invocation request headers (decision
 * 0014, #5). It rides as the `idempotency-key` header on the original invocation
 * (NOT the attempt headers), so it is replay-stable across attempts. Defensive:
 * `ctx.request()` may be unavailable on a non-handler context shape — returns
 * `undefined` rather than throwing, so the boundary never fails on a missing key.
 */
const readIdempotencyKeyHeader = (ctx: restate.Context): string | undefined => {
  try {
    const headers = (
      ctx as { request?: () => { headers?: ReadonlyMap<string, string> } }
    ).request?.()?.headers
    if (headers === undefined) return undefined
    const direct = headers.get(IDEMPOTENCY_KEY_HEADER)
    if (direct !== undefined) return direct
    /* Be tolerant of a non-lower-cased header key. */
    for (const [k, v] of headers) {
      if (k.toLowerCase() === IDEMPOTENCY_KEY_HEADER) return v
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * A per-invocation Effect transform applied to the user's program right before
 * it runs on the captured runtime — the inbound bridge seam (R23, §10). The
 * `./otel` module supplies one that captures `trace.getActiveSpan()?.spanContext()`
 * (the OTel attempt span the hook set active) and reparents the Effect program
 * under it. Pure in the core: a `<A, E, R>(effect) => Effect<A, E, R>` with NO
 * otel type — so the core stays dependency-light while `./otel` owns the bridge.
 */
export type HandlerWrap = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>

/**
 * A Restate `HooksProvider` (re-exported as a TYPE so `EndpointOptions.hooks`
 * carries it without the core importing any otel package). The `./otel` module
 * builds these via `@restatedev/restate-sdk-opentelemetry`'s `openTelemetryHook`.
 */
export type EndpointHooks = restate.HooksProvider

/**
 * Per-invocation identity the boundary hands the {@link BoundaryObserver} (R23,
 * §10, decision 0014): the construct name (`service`), the handler name, the
 * Object/Workflow `key` (undefined for plain Services), the WORKFLOW ID (the key
 * of a Workflow handler — undefined for Services/Objects), and the IDEMPOTENCY KEY
 * (from the original invocation's `idempotency-key` header, undefined when none).
 * The `./otel` observer stamps these as span attributes (`restate.service` /
 * `restate.handler` / `restate.object.key` / `restate.workflow.id` /
 * `restate.idempotency.key`) and metric labels. PURE in the core (no otel type).
 *
 * `workflowId` / `idempotencyKey` are IDENTITY values (an opaque key + a
 * caller-chosen dedup key), never a `sensitive`/redacted FIELD value — so stamping
 * them does not violate the "never a redacted field on a span" rule (decision
 * 0014): a redacted field is encrypted in the serde and never reaches this seam.
 */
export interface BoundaryInfo {
  readonly service: string
  readonly handler: string
  readonly key: string | undefined
  readonly workflowId: string | undefined
  readonly idempotencyKey: string | undefined
}

/**
 * The observability seam the boundary calls ONCE PER INVOCATION (R23, §10,
 * decision 0014). A factory `(info) => (outcome) => void`: invoked at handler
 * ENTRY with the {@link BoundaryInfo} (so the `./otel` impl can stamp identity
 * attributes / start a timer), returning a callback invoked at handler EXIT with
 * the classified {@link BoundaryOutcome} (so it can stamp `restate.error.{tag,
 * class}` on the active span and emit the per-invocation outcome metric).
 *
 * The boundary observer fires on EVERY attempt (it has no replay knowledge); the
 * `./otel` impl gates exactly-once invocation metrics on the SDK's non-replay
 * signal. PURE in the core: a `(BoundaryInfo) => (BoundaryOutcome) => void` with
 * NO otel type, so the core stays dependency-light while `./otel` owns the impl.
 */
export type BoundaryObserver = (info: BoundaryInfo) => (outcome: BoundaryOutcome) => void

/* The empty capability-marker value: markers gate type-legality, not runtime
 * behavior (the raw `ctx` does the work), so each provides an empty record. The
 * marker value types now carry a DESCRIPTIVE phantom brand (for readable
 * violation messages), so the provided runtime value is cast to the marker's
 * value type (it is never read at runtime). */
const emptyMarker = {} as never

/**
 * Which handler kind a materialized handler runs as — selects WHICH capability
 * markers are provided over the user's Effect (spec §3). The single source of
 * truth for the per-kind marker subset, shared by the real boundary
 * ({@link provideHandlerCaps} in `runEffectHandler`) and the in-memory test
 * dispatch (`TestEnv`'s mock backend) so the two stay in lock-step.
 */
export type HandlerMarkers =
  | 'service'
  | 'objectExclusive'
  | 'objectShared'
  | 'workflowRun'
  | 'workflowShared'

/**
 * Provide the capability markers legal for `markers` (spec §3) over a handler
 * effect, EXACTLY mirroring what each `materialize*` grants per kind — the single
 * source of truth reused by both the real boundary (`runEffectHandler`) and the
 * in-memory mock dispatch (`TestEnv`). `RestateContext` itself is provided by the
 * caller (it differs per backend: the raw SDK `ctx` on the server, the in-memory
 * fake on the mock). The markers are phantom empty values; only their presence
 * gates type-legality, so an illegal `State.set` in a shared handler is a COMPILE
 * error and the residual `R` collapses to `AppR` at runtime.
 */
export const provideHandlerCaps = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  markers: HandlerMarkers,
  key: string | undefined,
): Effect.Effect<A, E, R> => {
  let provided = effect
  if (markers !== 'service') {
    provided = provided.pipe(
      Effect.provideService(ObjectKey, { key: key ?? '' }),
      Effect.provideService(StateRead, emptyMarker),
    )
  }
  if (markers === 'objectExclusive' || markers === 'workflowRun') {
    provided = provided.pipe(Effect.provideService(StateWrite, emptyMarker))
  }
  if (markers === 'workflowRun' || markers === 'workflowShared') {
    provided = provided.pipe(Effect.provideService(DurablePromise, emptyMarker))
  }
  return provided
}

/**
 * Provide `RestateContext` (always) plus the capability markers legal for this
 * handler kind (spec §3), the per-invocation determinism layer (journaled
 * Clock/Random, R17) and the cancellation↔interruption bridge (R31), run the
 * user's Effect on the captured runtime, and map the exit to a return value or a
 * thrown `TerminalError`/retryable error. The `provide` set is per-kind so an
 * illegal `State.set` in a shared handler is a COMPILE error and the residual `R`
 * collapses to `AppR` at runtime.
 *
 * The sync-clock frozen base is seeded ONCE here at handler entry from
 * `ctx.date.now()` (journaled), so `Clock.unsafeCurrentTime*` reads are
 * replay-stable and do not advance mid-attempt (R17, decision 0004).
 */
const runEffectHandler =
  <AppR>(opts: {
    readonly service: string
    readonly handler: string
    readonly run: EffectHandler
    readonly errorSchema: Schema.Schema<any, any> | undefined
    readonly runtime: Runtime.Runtime<AppR>
    readonly markers: HandlerMarkers
    /* The inbound-bridge transform (`./otel` supplies it; undefined in the
     * otel-free core). Applied INSIDE the handler so `trace.getActiveSpan()`
     * (the hook's attempt span, set active via `context.with` around this fn)
     * resolves at capture time and reparents the Effect program (R23, §10). */
    readonly inboundBridge: HandlerWrap | undefined
    /* The observability boundary observer (`./otel` supplies it; undefined in the
     * otel-free core). Invoked at entry with the per-invocation identity, then at
     * exit with the classified outcome, so `./otel` stamps span attributes + emits
     * the per-invocation metric (decision 0014). */
    readonly boundaryObserver: BoundaryObserver | undefined
  }) =>
  async (ctx: restate.Context, input: unknown): Promise<unknown> => {
    /* Seed the per-attempt frozen monotonic base ONCE from journaled time. */
    const frozenBaseMillis = await ctx.date.now()
    /* Open the boundary observation at handler ENTRY (the hook's attempt span is
     * active here), with the construct/handler identity + Object/Workflow key. A
     * plain Service has no `key` (undefined). The WORKFLOW ID is the key of a
     * Workflow handler (markers `workflowRun`/`workflowShared`); the IDEMPOTENCY KEY
     * comes from the original-invocation header (auto-stamped so consumers do not
     * hand-roll them, #5). */
    const key = opts.markers !== 'service' ? (ctx as restate.ObjectContext).key : undefined
    const isWorkflow = opts.markers === 'workflowRun' || opts.markers === 'workflowShared'
    const onOutcome =
      opts.boundaryObserver !== undefined
        ? opts.boundaryObserver({
            service: opts.service,
            handler: opts.handler,
            key,
            workflowId: isWorkflow ? key : undefined,
            idempotencyKey: readIdempotencyKeyHeader(ctx),
          })
        : undefined
    /* AUTO baseline metrics (decision 0014): the per-attempt counter at ENTRY +
     * the per-invocation outcome/duration at EXIT, run on the CAPTURED runtime so
     * they reach the bound OTel meter (when `RestateOtel.layer` provides it; a
     * harmless in-memory Effect metric otherwise). Both are exactly-once-gated on
     * `ctx.isProcessing()` inside the emit (replays do not re-increment). The
     * start is a monotonic real-time read — only used on a real (non-replay) emit. */
    const attemptStartMs = monotonicMs()
    Runtime.runSync(opts.runtime)(
      emitAttempt(ctx, { service: opts.service, handler: opts.handler }),
    )
    const effect = provideHandlerCaps(
      opts.run(input).pipe(Effect.provideService(RestateContext, ctx)),
      opts.markers,
      opts.markers !== 'service' ? (ctx as restate.ObjectContext).key : undefined,
    )
    /* Bridge the attempt-completed signal to interruption (R31), then provide the
     * journaled Clock/Random (R17) AND the replay-aware logger (decision 0015 —
     * routes `Effect.log*` through `ctx.console`, suppressed on replay) over the
     * handler. The per-invocation layers wrap OUTSIDE the interruption bridge so
     * the forked fiber inherits them. */
    const bridged = withAttemptInterruption(ctx, effect).pipe(
      Effect.provide(Layer.merge(determinismLayer(ctx, frozenBaseMillis), loggerLayer(ctx))),
    )
    /* Reparent under the OTel attempt span (no-op in the core; `./otel` supplies
     * the transform). Applied last so the active span is read at runtime, inside
     * the hook's `context.with` window, just before the program runs (R23). */
    const program = opts.inboundBridge !== undefined ? opts.inboundBridge(bridged) : bridged
    const exit = await Runtime.runPromiseExit(opts.runtime)(
      program as Effect.Effect<unknown, unknown, AppR>,
    )
    const emitInvocation = (
      outcomeTag: 'success' | 'terminal' | 'retryable' | 'cancelled',
    ): void => {
      Runtime.runSync(opts.runtime)(
        emitInvocationMetrics(ctx, {
          service: opts.service,
          handler: opts.handler,
          outcome: outcomeTag,
          durationMs: monotonicMs() - attemptStartMs,
        }),
      )
    }
    if (Exit.isSuccess(exit) === true) {
      onOutcome?.({ _tag: 'success' })
      emitInvocation('success')
      return exit.value
    }
    const outcome = classifyOutcome(exit.cause, opts.errorSchema)
    onOutcome?.(outcome)
    /* Count a TERMINAL outcome (success/terminal/cancelled — the invocation truly
     * ends) or a retryable failed attempt; `suspended`/`defect` are NOT terminal
     * outcomes (the invocation parks/retries), so they are not counted here. */
    if (
      outcome._tag === 'terminal' ||
      outcome._tag === 'retryable' ||
      outcome._tag === 'cancelled'
    ) {
      emitInvocation(outcome._tag)
    }
    throw outcome._tag === 'success' ? undefined : outcome.thrown
  }

/* Map the typed `retryPolicy` option to the SDK `RetryPolicy` (decision 0006,
 * spec §7). Intervals are already millis (the SDK accepts a number = millis). */
const mapRetryPolicy = (p: RetryPolicyOptions): Record<string, unknown> => ({
  ...(p.maxAttempts !== undefined ? { maxAttempts: p.maxAttempts } : {}),
  ...(p.onMaxAttempts !== undefined ? { onMaxAttempts: p.onMaxAttempts } : {}),
  ...(p.initialIntervalMillis !== undefined ? { initialInterval: p.initialIntervalMillis } : {}),
  ...(p.maxIntervalMillis !== undefined ? { maxInterval: p.maxIntervalMillis } : {}),
  ...(p.exponentiationFactor !== undefined ? { exponentiationFactor: p.exponentiationFactor } : {}),
})

/* Map a `Restate.retention` annotation (decision 0011) to the SDK retention
 * options. `workflow` is dropped unless the construct is a Workflow (the caller
 * decides via `includeWorkflow`). Builder `options` win over the annotation. */
const mapRetention = (
  retention: RetentionOptions,
  includeWorkflow: boolean,
): Record<string, unknown> => {
  const toMillis = (d: Duration.DurationInput): number => Duration.toMillis(Duration.decode(d))
  return {
    ...(retention.idempotency !== undefined
      ? { idempotencyRetention: toMillis(retention.idempotency) }
      : {}),
    ...(retention.journal !== undefined ? { journalRetention: toMillis(retention.journal) } : {}),
    ...(includeWorkflow && retention.workflow !== undefined
      ? { workflowRetention: toMillis(retention.workflow) }
      : {}),
  }
}

/**
 * Map a handler spec's serde (R07) + surfaced R35/retry options into the SDK opts
 * bag. The `retention` annotation on the handler's INPUT schema (decision 0011)
 * is folded in first; explicit `spec.options` (incl. its own retention) win.
 * `redaction` (resolved from the runtime context at `materialize`) is threaded
 * into the I/O serdes so `sensitive` fields are encrypted on the wire (spec §4).
 */
const handlerOpts = (
  spec: {
    readonly input: Schema.Schema<any, any>
    readonly success: Schema.Schema<any, any>
    readonly options?: HandlerOptions
  },
  redaction: RedactionCipher | undefined,
): Record<string, unknown> => {
  const serdeOpts = redaction !== undefined ? { redaction } : undefined
  const annotated = readRetention(spec.input.ast).pipe(Option.getOrUndefined)
  return {
    input: ingressSerde(spec.input, serdeOpts),
    output: ingressSerde(spec.success, serdeOpts),
    ...(annotated !== undefined ? mapRetention(annotated, false) : {}),
    ...mapHandlerOptions(spec.options),
  }
}

const mapHandlerOptions = (o?: HandlerOptions): Record<string, unknown> =>
  o === undefined
    ? {}
    : {
        ...(o.idempotencyRetentionMillis !== undefined
          ? { idempotencyRetention: o.idempotencyRetentionMillis }
          : {}),
        ...(o.journalRetentionMillis !== undefined
          ? { journalRetention: o.journalRetentionMillis }
          : {}),
        ...(o.inactivityTimeoutMillis !== undefined
          ? { inactivityTimeout: o.inactivityTimeoutMillis }
          : {}),
        ...(o.abortTimeoutMillis !== undefined ? { abortTimeout: o.abortTimeoutMillis } : {}),
        ...(o.ingressPrivate !== undefined ? { ingressPrivate: o.ingressPrivate } : {}),
        ...(o.enableLazyState !== undefined ? { enableLazyState: o.enableLazyState } : {}),
        ...(o.explicitCancellation !== undefined
          ? { explicitCancellation: o.explicitCancellation }
          : {}),
        ...(o.retryPolicy !== undefined ? { retryPolicy: mapRetryPolicy(o.retryPolicy) } : {}),
        ...(o.asTerminalError !== undefined ? { asTerminalError: o.asTerminalError } : {}),
      }

const mapServiceOptions = (o?: ServiceLevelOptions): Record<string, unknown> | undefined =>
  o === undefined
    ? undefined
    : {
        ...mapHandlerOptions(o),
        ...(o.workflowRetentionMillis !== undefined
          ? { workflowRetention: o.workflowRetentionMillis }
          : {}),
      }

/**
 * The endpoint-level wiring `materialize*` thread into every service: the
 * Restate `hooks` (e.g. the otel `openTelemetryHook`, attached SERVICE-level so
 * they wrap every handler) and the per-invocation inbound-bridge transform. Both
 * are supplied by `layer`/`serve` (and ultimately the `./otel` module); the core
 * itself imports no otel package.
 */
export interface MaterializeWiring {
  readonly hooks?: ReadonlyArray<EndpointHooks> | undefined
  readonly inboundBridge?: HandlerWrap | undefined
  readonly boundaryObserver?: BoundaryObserver | undefined
}

/**
 * Resolve the optional `RestateRedaction` cipher from the captured runtime's
 * context (decision 0011, spec §4). It is OPTIONAL: a schema with no `sensitive`
 * field never needs it, so the application Layer need not provide one. When a
 * served schema DOES have a sensitive field but the cipher is absent, the serde
 * fails with a clear `RedactionCipherMissingError` at encode/decode — never
 * plaintext (see `./Redaction.ts`). Resolved once per `materialize*`.
 */
const resolveRedaction = <AppR>(runtime: Runtime.Runtime<AppR>): RedactionCipher | undefined =>
  Context.getOption(runtime.context, RestateRedaction).pipe(Option.getOrUndefined)

/* Build the service-level `options.hooks` fragment from the wiring (omitted when
 * no hooks are configured, so the otel-free path produces an identical bag). The
 * array is copied to a mutable `HooksProvider[]` (the SDK's expected shape). */
const serviceHooksOptions = (
  wiring?: MaterializeWiring,
): { readonly options?: { readonly hooks: Array<EndpointHooks> } } =>
  wiring?.hooks !== undefined && wiring.hooks.length > 0
    ? { options: { hooks: [...wiring.hooks] } }
    : {}

/* Merge the wiring's service-level `hooks` into an existing service-options bag
 * (Objects/Workflows already build one from `ServiceLevelOptions`). */
const withHooks = (
  serviceOptions: Record<string, unknown> | undefined,
  wiring?: MaterializeWiring,
): Record<string, unknown> | undefined => {
  const hooks =
    wiring?.hooks !== undefined && wiring.hooks.length > 0 ? [...wiring.hooks] : undefined
  if (hooks === undefined) return serviceOptions
  return { ...serviceOptions, hooks }
}

/**
 * Materialize a Service `ServiceImplementation` into a runtime `restate.service`.
 * Each handler runs the user's Effect on the CAPTURED runtime (built once from
 * the application Layer), with `RestateContext` provided PER INVOCATION, and
 * maps the exit to a return value or a thrown `TerminalError`/retryable error.
 *
 * `AppR` is EXPLICIT (from `Runtime.Runtime<AppR>`) — never inferred from
 * handler bodies (decision 0002). The contract's precise phantom map survives on
 * the public type; only this boundary widens to `any` (invisible to users).
 */
export const materialize = <AppR>(
  implementation: ServiceImplementation<Contract<string, HandlerSpecMap>, AppR>,
  runtime: Runtime.Runtime<AppR>,
  wiring?: MaterializeWiring,
): restate.ServiceDefinition<string, unknown> => {
  const { contract, impl } = implementation
  const redaction = resolveRedaction(runtime)
  const handlers = Object.fromEntries(
    Object.entries(contract.handlers).map(([name, spec]: [string, HandlerSpec]) => {
      const run = (impl as Record<string, EffectHandler>)[name]!
      return [
        name,
        restate.handlers.handler(
          handlerOpts(spec, redaction),
          runEffectHandler({
            service: contract.name,
            handler: name,
            run,
            errorSchema: spec.error,
            runtime,
            markers: 'service',
            inboundBridge: wiring?.inboundBridge,
            boundaryObserver: wiring?.boundaryObserver,
          }),
        ),
      ]
    }),
  )
  const serviceOptions = withHooks(mapServiceOptions(contract.options), wiring)
  return restate.service({
    name: contract.name,
    handlers,
    ...(serviceOptions !== undefined ? { options: serviceOptions } : serviceHooksOptions(wiring)),
  } as unknown as Parameters<typeof restate.service>[0]) as restate.ServiceDefinition<
    string,
    unknown
  >
}

/**
 * Materialize an `ObjectImplementation` into a runtime `restate.object`. Each
 * EXCLUSIVE handler gets `ObjectKey + StateRead + StateWrite`; each `shared: true`
 * handler is wrapped with `restate.handlers.object.shared(...)` and gets
 * `ObjectKey + StateRead` only (read-only — a `State.set` there does not
 * typecheck). `AppR` is explicit (decision 0002).
 */
export const materializeObject = <AppR>(
  implementation: ObjectImplementation<
    ObjectContract<string, Record<string, Schema.Schema<any, any>>, ObjectHandlerSpecMap>,
    AppR
  >,
  runtime: Runtime.Runtime<AppR>,
  wiring?: MaterializeWiring,
): restate.VirtualObjectDefinition<string, unknown> => {
  const { contract, impl } = implementation
  const redaction = resolveRedaction(runtime)
  const handlers = Object.fromEntries(
    Object.entries(contract.handlers).map(([name, spec]: [string, ObjectHandlerSpec]) => {
      const run = (impl as Record<string, EffectHandler>)[name]!
      const opts = handlerOpts(spec, redaction)
      const handler =
        spec.shared === true
          ? restate.handlers.object.shared(
              opts,
              runEffectHandler({
                service: contract.name,
                handler: name,
                run,
                errorSchema: spec.error,
                runtime,
                markers: 'objectShared',
                inboundBridge: wiring?.inboundBridge,
                boundaryObserver: wiring?.boundaryObserver,
              }),
            )
          : restate.handlers.object.exclusive(
              opts,
              runEffectHandler({
                service: contract.name,
                handler: name,
                run,
                errorSchema: spec.error,
                runtime,
                markers: 'objectExclusive',
                inboundBridge: wiring?.inboundBridge,
                boundaryObserver: wiring?.boundaryObserver,
              }),
            )
      return [name, handler]
    }),
  )
  const serviceOptions = withHooks(mapServiceOptions(contract.options), wiring)
  return restate.object({
    name: contract.name,
    handlers,
    ...(serviceOptions !== undefined ? { options: serviceOptions } : {}),
  } as unknown as Parameters<typeof restate.object>[0]) as restate.VirtualObjectDefinition<
    string,
    unknown
  >
}

/**
 * Materialize a `WorkflowImplementation` into a runtime `restate.workflow`. The
 * single `run` handler gets the full set (`ObjectKey + StateRead + StateWrite +
 * DurablePromise`); each signal/query is wrapped with
 * `restate.handlers.workflow.shared(...)` and gets `ObjectKey + StateRead +
 * DurablePromise` (read-only State + durable promises). `AppR` is explicit.
 */
export const materializeWorkflow = <AppR>(
  implementation: WorkflowImplementation<
    WorkflowContract<
      string,
      Record<string, Schema.Schema<any, any>>,
      WorkflowHandlerSpec,
      WorkflowHandlerSpecMap,
      WorkflowHandlerSpecMap
    >,
    AppR
  >,
  runtime: Runtime.Runtime<AppR>,
  wiring?: MaterializeWiring,
): restate.WorkflowDefinition<string, unknown> => {
  const { contract, impl } = implementation
  const redaction = resolveRedaction(runtime)
  const implMap = impl as Record<string, EffectHandler>
  const runSpec = contract.run
  const runHandler = restate.handlers.workflow.workflow(
    handlerOpts(runSpec, redaction),
    runEffectHandler({
      service: contract.name,
      handler: 'run',
      run: implMap['run']!,
      errorSchema: runSpec.error,
      runtime,
      markers: 'workflowRun',
      inboundBridge: wiring?.inboundBridge,
      boundaryObserver: wiring?.boundaryObserver,
    }),
  )
  const shared = (specs: WorkflowHandlerSpecMap): Array<[string, unknown]> =>
    Object.entries(specs).map(([name, spec]: [string, WorkflowHandlerSpec]) => [
      name,
      restate.handlers.workflow.shared(
        handlerOpts(spec, redaction),
        runEffectHandler({
          service: contract.name,
          handler: name,
          run: implMap[name]!,
          errorSchema: spec.error,
          runtime,
          markers: 'workflowShared',
          inboundBridge: wiring?.inboundBridge,
          boundaryObserver: wiring?.boundaryObserver,
        }),
      ),
    ])
  const handlers = Object.fromEntries([
    ['run', runHandler],
    ...shared(contract.signals),
    ...shared(contract.queries),
  ])
  const serviceOptions = withHooks(mapServiceOptions(contract.options), wiring)
  return restate.workflow({
    name: contract.name,
    handlers,
    ...(serviceOptions !== undefined ? { options: serviceOptions } : {}),
  } as unknown as Parameters<typeof restate.workflow>[0]) as restate.WorkflowDefinition<
    string,
    unknown
  >
}

/**
 * Any bound implementation servable on an endpoint. `materializeAny` dispatches on
 * the `_tag` to the right `materialize*`, so `layer` / `serve` accept a mixed
 * `services` array of Services, Objects, and Workflows.
 */
export type AnyImplementation<AppR> =
  | ServiceImplementation<Contract<string, HandlerSpecMap>, AppR>
  | ObjectImplementation<
      ObjectContract<string, Record<string, Schema.Schema<any, any>>, ObjectHandlerSpecMap>,
      AppR
    >
  | WorkflowImplementation<
      WorkflowContract<
        string,
        Record<string, Schema.Schema<any, any>>,
        WorkflowHandlerSpec,
        WorkflowHandlerSpecMap,
        WorkflowHandlerSpecMap
      >,
      AppR
    >

/** Dispatch a bound implementation to the right `materialize*` by its `_tag`. */
export const materializeAny = <AppR>(
  implementation: AnyImplementation<AppR>,
  runtime: Runtime.Runtime<AppR>,
  wiring?: MaterializeWiring,
):
  | restate.ServiceDefinition<string, unknown>
  | restate.VirtualObjectDefinition<string, unknown>
  | restate.WorkflowDefinition<string, unknown> => {
  switch (implementation._tag) {
    case 'ServiceImplementation':
      return materialize(implementation, runtime, wiring)
    case 'ObjectImplementation':
      return materializeObject(implementation, runtime, wiring)
    case 'WorkflowImplementation':
      return materializeWorkflow(implementation, runtime, wiring)
  }
}

/* eslint-enable @typescript-eslint/no-explicit-any */

/* eslint-disable @typescript-eslint/no-explicit-any -- the AppR extractor walks heterogeneous implementations */

/**
 * The UNION of every served implementation's app requirement `AppR` — the
 * combined requirement `layer`/`serve` need the captured runtime to provide. A
 * homogeneous array collapses to one `AppR`; a HETEROGENEOUS array (services with
 * differing `AppR`s) widens to the union, so a runtime providing all of them is
 * required (fixes the docs-worker mixed-`AppR` array friction — `AppR` no longer
 * forced to a single element via `ReadonlyArray<AnyImplementation<AppR>>`
 * inference). Relies on `_Implementation._AppR` being covariant.
 */
export type AppROf<Services extends ReadonlyArray<AnyImplementation<any>>> =
  Services[number] extends AnyImplementation<infer R> ? R : never

/* eslint-enable @typescript-eslint/no-explicit-any */

/** Options for the endpoint server layer / `serve`. */
export interface EndpointOptions<AppR> {
  /** A mixed array of Service / Object / Workflow implementations to serve. */
  readonly services: ReadonlyArray<AnyImplementation<AppR>>
  /**
   * The handler-endpoint port the server listens on. Either a literal `number`
   * or a `Config<number>` (e.g. `Config.integer('PORT')`) resolved on layer
   * acquisition — so the port can come from the environment without a separate
   * read. A `Config` that fails (unset / unparseable) fails the layer with a
   * `ConfigError`.
   */
  readonly port: number | Config.Config<number>
  /**
   * Restate `HooksProvider`s attached SERVICE-level to every materialized
   * service (so they wrap every handler). The `./otel` module supplies the
   * `openTelemetryHook` here; the otel-free core leaves this undefined (§10).
   */
  readonly hooks?: ReadonlyArray<EndpointHooks>
  /**
   * Per-invocation inbound-bridge transform applied to every handler's program
   * (the `./otel` module's attempt-span → Effect-parent bridge, R23 §10). A pure
   * `<A, E, R>(effect) => Effect<A, E, R>`; undefined in the otel-free core.
   */
  readonly inboundBridge?: HandlerWrap
  /**
   * Per-invocation observability observer (the `./otel` module's boundary span
   * stamping + per-invocation outcome metric, R23 §10, decision 0014). A pure
   * `(BoundaryInfo) => (BoundaryOutcome) => void`; undefined in the otel-free core.
   */
  readonly boundaryObserver?: BoundaryObserver
  /**
   * Restate REQUEST-IDENTITY public keys (ED25519, v1 — e.g.
   * `publickeyv1_2G8dCQhArfvGpzPw5Vx2ALciR4xCLHfS5YaT93XjNxX9`), threaded into the
   * SDK endpoint's `identityKeys` (spec §8, decision 0016). When set, the SDK
   * REJECTS any inbound request not signed by the matching private key (the
   * `x-restate-signature-scheme: v1` + `x-restate-jwt-v1` JWT check) — closing the
   * otherwise-unauthenticated handler-endpoint hole. Pure passthrough; the SDK
   * owns the verification. Leave unset for a trusted local network.
   */
  readonly identityKeys?: ReadonlyArray<string>
}

/**
 * A scoped `Layer` that binds the given service implementations to an h2c
 * (cleartext HTTP/2 prior-knowledge) server on `opts.port` and serves the
 * Restate discovery/invocation protocol.
 *
 * The shared application runtime is captured once (`Effect.runtime<AppR>()`),
 * each implementation materialized, the server started on acquire, and a
 * finalizer closes it on scope teardown — so the endpoint participates in
 * graceful (SIGTERM-driven) shutdown when launched via `serve` +
 * `NodeRuntime.runMain`.
 *
 * The failure channel is `RestateError` (a bind/listen failure) plus
 * `ConfigError` — the latter only ever fails when `port` is a `Config<number>`
 * that the environment does not satisfy (a literal-`number` port never produces
 * one).
 *
 * `bidirectional` is left UNSET so the SDK negotiates full `BIDI_STREAM` over
 * h2c prior-knowledge (DQ7, spec §8).
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- the services-tuple AppR extractor */
export const layer = <const S extends ReadonlyArray<AnyImplementation<any>>>(
  opts: Omit<EndpointOptions<AppROf<S>>, 'services'> & { readonly services: S },
): Layer.Layer<never, RestateError | ConfigError.ConfigError, AppROf<S>> =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      type AppR = AppROf<S>
      /* Resolve a `Config<number>` port (e.g. `Config.integer('PORT')`) on
       * acquisition; a literal `number` passes through. A failing Config fails
       * the layer with a `ConfigError`. */
      const port = typeof opts.port === 'number' ? opts.port : yield* opts.port
      const runtime = yield* Effect.runtime<AppR>()
      const wiring: MaterializeWiring = {
        hooks: opts.hooks,
        inboundBridge: opts.inboundBridge,
        boundaryObserver: opts.boundaryObserver,
      }
      const fn = createEndpointHandler({
        services: opts.services.map((s) => materializeAny(s, runtime, wiring)),
        ...(opts.identityKeys !== undefined ? { identityKeys: [...opts.identityKeys] } : {}),
      })
      const server = http2.createServer(fn as Parameters<typeof http2.createServer>[0])

      yield* Effect.acquireRelease(
        Effect.async<typeof server, RestateError>((resume) => {
          const onError = (cause: Error) => {
            server.off('error', onError)
            resume(
              Effect.fail(new RestateError({ reason: 'EndpointFailed', method: 'listen', cause })),
            )
          }
          server.once('error', onError)
          server.listen(port, () => {
            server.off('error', onError)
            resume(Effect.succeed(server))
          })
        }),
        (s) =>
          Effect.async<void>((resume) => {
            s.close(() => resume(Effect.void))
          }),
      )

      yield* Effect.logInfo(`restate-effect endpoint listening on http://localhost:${port}`)
    }),
  )

/**
 * Long-lived production entrypoint: launch the endpoint `layer` and block until
 * interrupted, running finalizers (graceful server close + all scoped
 * application resources) on SIGTERM.
 *
 * ```ts
 * serve({ services: [GreeterLive], port: 9080 }).pipe(
 *   Effect.provide(AppLayer),
 *   NodeRuntime.runMain,
 * )
 * ```
 */
export const serve = <const S extends ReadonlyArray<AnyImplementation<any>>>(
  opts: Omit<EndpointOptions<AppROf<S>>, 'services'> & { readonly services: S },
): Effect.Effect<never, RestateError | ConfigError.ConfigError, AppROf<S>> =>
  Layer.launch(layer(opts))
/* eslint-enable @typescript-eslint/no-explicit-any */
