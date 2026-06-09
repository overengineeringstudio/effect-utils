import * as restate from '@restatedev/restate-sdk'
import { Cause, Chunk, Effect, Option, Schema } from 'effect'

import { DurablePromise, ObjectKey, StateRead, StateWrite } from '../authoring/RestateContext.ts'
import { readErrorClass, readRetryAfterMillis } from '../schema/Annotations.ts'

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

/* eslint-enable @typescript-eslint/no-explicit-any */
