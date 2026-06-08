import * as http2 from 'node:http2'

import * as restate from '@restatedev/restate-sdk'
import { createEndpointHandler } from '@restatedev/restate-sdk/node'
import { Cause, Chunk, Duration, Effect, Exit, Layer, Option, Runtime, Schema } from 'effect'

import { readErrorClass } from './Annotations.ts'
import { ObjectKey, RestateContext, StateRead, StateWrite } from './RestateContext.ts'
import { DurablePromise } from './RestateContext.ts'
import { RestateError } from './RestateError.ts'
import { determinismLayer, withAttemptInterruption } from './Runtime.ts'
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
  ServiceImplementation,
  ServiceLevelOptions,
  WorkflowContract,
  WorkflowHandlerSpec,
  WorkflowHandlerSpecMap,
  WorkflowImplementation,
} from './Service.ts'

/* eslint-disable @typescript-eslint/no-explicit-any -- the materialize boundary deliberately erases the contract's phantom map (invisible to users; the public Contract type stays precise) */

/**
 * Map an Effect failure `Cause` to a Restate handler outcome (spec §5). Reads
 * the failing error's `terminal`/`retryable` annotation to decide errorCode vs
 * a retryable throw.
 *
 * - Typed domain failure (declared `error` schema): encode it and throw a
 *   `restate.TerminalError`. The encoded body AND its `_tag` ride in the message
 *   BODY (JSON) — the only channel an ingress caller's `responseText` can read.
 *   `errorCode` comes from the error's `terminal` annotation (default 500);
 *   `_tag` is ALSO mirrored into `metadata` best-effort (server ≥1.6).
 * - `retryable`-annotated domain failure → throw `RetryableError` (Restate
 *   retries), honoring `retryAfter`.
 * - A Restate suspension (`isSuspendedError`) → re-thrown as-is, never terminalized.
 * - An Effect INTERRUPTION (Restate cancellation bridged to the handler fiber, or
 *   an in-handler interrupt) → re-thrown as a `CancelledError` (which `extends
 *   TerminalError`), so the SDK does NOT retry it. It is neither a domain failure
 *   nor a defect: finalizers/compensations have already run at the interruption
 *   point (R31, spec §5a). If the underlying cause is itself a Restate suspension
 *   (the attempt is being torn down), that suspension is re-thrown as-is.
 * - Anything else (defect) → return the squashed cause so the SDK throws it as a
 *   normal error and RETRIES.
 */
export const toTerminal = (
  cause: Cause.Cause<unknown>,
  errorSchema?: Schema.Schema<any, any>,
): unknown => {
  /* A Restate suspension (a durable op suspending the attempt) may arrive as a
   * DEFECT (a durable combinator re-throws it verbatim via `Effect.die`, see
   * `awaitDurable`). Re-throw it AS-IS so the SDK suspends/resumes — never
   * terminalize or retry it (R15). Checked first: a suspension defect is not a
   * domain failure. */
  const suspensionDefect = Chunk.findFirst(Cause.defects(cause), (d) =>
    restate.internal.isSuspendedError(d),
  )
  if (Option.isSome(suspensionDefect) === true) return suspensionDefect.value

  const failure = Cause.failureOption(cause)
  if (failure._tag === 'Some') {
    const error = failure.value
    /* A Restate suspension is never a real failure — never terminalize it. */
    if (restate.internal.isSuspendedError(error) === true) return Cause.squash(cause)

    const classification =
      errorSchema !== undefined
        ? readErrorClass(errorSchema.ast).pipe(Option.getOrElse(() => undefined))
        : undefined

    if (classification?._tag === 'retryable') {
      const retryAfter =
        classification.retryAfter !== undefined
          ? Duration.toMillis(Duration.decode(classification.retryAfter))
          : undefined
      return restate.RetryableError.from(error, retryAfter !== undefined ? { retryAfter } : {})
    }

    const errorCode = classification?._tag === 'terminal' ? classification.errorCode : 500
    const tag =
      typeof error === 'object' && error !== null && '_tag' in error
        ? String((error as { _tag: unknown })._tag)
        : undefined
    const body = errorSchema !== undefined ? Schema.encodeSync(errorSchema)(error) : error
    return new restate.TerminalError(JSON.stringify(body), {
      errorCode,
      ...(tag !== undefined ? { metadata: { _tag: tag } } : {}),
    })
  }
  /* An interruption (Restate cancellation bridged to the fiber, or an in-handler
   * interrupt — incl. a durable op that rejected with `CancelledError`) is neither
   * a domain failure nor a defect: finalizers/compensations already ran.
   * Terminalize as a `CancelledError` so the SDK does NOT retry it (R31, §5a).
   * (A suspension is already handled above as a defect, never reaching here.) */
  if (Cause.isInterrupted(cause) === true) return new restate.CancelledError()
  /* Defect → let the SDK retry. */
  return Cause.squash(cause)
}

/* An untyped Effect handler bound to a single contract handler. */
type EffectHandler = (input: unknown) => Effect.Effect<unknown, unknown, any>

/* The empty capability-marker value: markers gate type-legality, not runtime
 * behavior (the raw `ctx` does the work), so each provides an empty record. */
const emptyMarker = {} as Record<never, never>

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
    readonly run: EffectHandler
    readonly errorSchema: Schema.Schema<any, any> | undefined
    readonly runtime: Runtime.Runtime<AppR>
    readonly markers:
      | 'service'
      | 'objectExclusive'
      | 'objectShared'
      | 'workflowRun'
      | 'workflowShared'
  }) =>
  async (ctx: restate.Context, input: unknown): Promise<unknown> => {
    /* Seed the per-attempt frozen monotonic base ONCE from journaled time. */
    const frozenBaseMillis = await ctx.date.now()
    let effect = opts.run(input).pipe(Effect.provideService(RestateContext, ctx))
    if (opts.markers !== 'service') {
      effect = effect.pipe(
        Effect.provideService(ObjectKey, { key: (ctx as restate.ObjectContext).key }),
        Effect.provideService(StateRead, emptyMarker),
      )
    }
    if (opts.markers === 'objectExclusive' || opts.markers === 'workflowRun') {
      effect = effect.pipe(Effect.provideService(StateWrite, emptyMarker))
    }
    if (opts.markers === 'workflowRun' || opts.markers === 'workflowShared') {
      effect = effect.pipe(Effect.provideService(DurablePromise, emptyMarker))
    }
    /* Bridge the attempt-completed signal to interruption (R31), then provide the
     * journaled Clock/Random over the handler (R17). The determinism layer wraps
     * OUTSIDE the interruption bridge so its forked fiber inherits the layer. */
    const bridged = withAttemptInterruption(ctx, effect).pipe(
      Effect.provide(determinismLayer(ctx, frozenBaseMillis)),
    )
    const exit = await Runtime.runPromiseExit(opts.runtime)(
      bridged as Effect.Effect<unknown, unknown, AppR>,
    )
    if (Exit.isSuccess(exit) === true) return exit.value
    throw toTerminal(exit.cause, opts.errorSchema)
  }

/* Map a handler spec's serde (R07) + surfaced R35 options into the SDK opts bag. */
const handlerOpts = (spec: {
  readonly input: Schema.Schema<any, any>
  readonly success: Schema.Schema<any, any>
  readonly options?: HandlerOptions
}): Record<string, unknown> => ({
  input: ingressSerde(spec.input),
  output: ingressSerde(spec.success),
  ...mapHandlerOptions(spec.options),
})

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
): restate.ServiceDefinition<string, unknown> => {
  const { contract, impl } = implementation
  const handlers = Object.fromEntries(
    Object.entries(contract.handlers).map(([name, spec]: [string, HandlerSpec]) => {
      const run = (impl as Record<string, EffectHandler>)[name]!
      return [
        name,
        restate.handlers.handler(
          handlerOpts(spec),
          runEffectHandler({ run, errorSchema: spec.error, runtime, markers: 'service' }),
        ),
      ]
    }),
  )
  return restate.service({ name: contract.name, handlers }) as restate.ServiceDefinition<
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
): restate.VirtualObjectDefinition<string, unknown> => {
  const { contract, impl } = implementation
  const handlers = Object.fromEntries(
    Object.entries(contract.handlers).map(([name, spec]: [string, ObjectHandlerSpec]) => {
      const run = (impl as Record<string, EffectHandler>)[name]!
      const opts = handlerOpts(spec)
      const handler =
        spec.shared === true
          ? restate.handlers.object.shared(
              opts,
              runEffectHandler({ run, errorSchema: spec.error, runtime, markers: 'objectShared' }),
            )
          : restate.handlers.object.exclusive(
              opts,
              runEffectHandler({
                run,
                errorSchema: spec.error,
                runtime,
                markers: 'objectExclusive',
              }),
            )
      return [name, handler]
    }),
  )
  const serviceOptions = mapServiceOptions(contract.options)
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
): restate.WorkflowDefinition<string, unknown> => {
  const { contract, impl } = implementation
  const implMap = impl as Record<string, EffectHandler>
  const runSpec = contract.run
  const runHandler = restate.handlers.workflow.workflow(
    handlerOpts(runSpec),
    runEffectHandler({
      run: implMap['run']!,
      errorSchema: runSpec.error,
      runtime,
      markers: 'workflowRun',
    }),
  )
  const shared = (specs: WorkflowHandlerSpecMap): Array<[string, unknown]> =>
    Object.entries(specs).map(([name, spec]: [string, WorkflowHandlerSpec]) => [
      name,
      restate.handlers.workflow.shared(
        handlerOpts(spec),
        runEffectHandler({
          run: implMap[name]!,
          errorSchema: spec.error,
          runtime,
          markers: 'workflowShared',
        }),
      ),
    ])
  const handlers = Object.fromEntries([
    ['run', runHandler],
    ...shared(contract.signals),
    ...shared(contract.queries),
  ])
  const serviceOptions = mapServiceOptions(contract.options)
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
):
  | restate.ServiceDefinition<string, unknown>
  | restate.VirtualObjectDefinition<string, unknown>
  | restate.WorkflowDefinition<string, unknown> => {
  switch (implementation._tag) {
    case 'ServiceImplementation':
      return materialize(implementation, runtime)
    case 'ObjectImplementation':
      return materializeObject(implementation, runtime)
    case 'WorkflowImplementation':
      return materializeWorkflow(implementation, runtime)
  }
}

/* eslint-enable @typescript-eslint/no-explicit-any */

/** Options for the endpoint server layer / `serve`. */
export interface EndpointOptions<AppR> {
  /** A mixed array of Service / Object / Workflow implementations to serve. */
  readonly services: ReadonlyArray<AnyImplementation<AppR>>
  readonly port: number
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
 * `bidirectional` is left UNSET so the SDK negotiates full `BIDI_STREAM` over
 * h2c prior-knowledge (DQ7, spec §8).
 */
export const layer = <AppR>(opts: EndpointOptions<AppR>): Layer.Layer<never, RestateError, AppR> =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const runtime = yield* Effect.runtime<AppR>()
      const fn = createEndpointHandler({
        services: opts.services.map((s) => materializeAny(s, runtime)),
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
          server.listen(opts.port, () => {
            server.off('error', onError)
            resume(Effect.succeed(server))
          })
        }),
        (s) =>
          Effect.async<void>((resume) => {
            s.close(() => resume(Effect.void))
          }),
      )

      yield* Effect.logInfo(`restate-effect endpoint listening on http://localhost:${opts.port}`)
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
export const serve = <AppR>(
  opts: EndpointOptions<AppR>,
): Effect.Effect<never, RestateError, AppR> => Layer.launch(layer(opts))
