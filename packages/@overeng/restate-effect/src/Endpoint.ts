import * as http2 from 'node:http2'

import * as restate from '@restatedev/restate-sdk'
import { createEndpointHandler } from '@restatedev/restate-sdk/node'
import { Cause, Duration, Effect, Exit, Layer, Option, Runtime, Schema } from 'effect'

import { readErrorClass } from './Annotations.ts'
import { RestateContext } from './RestateContext.ts'
import { RestateError } from './RestateError.ts'
import { ingressSerde } from './Serde.ts'
import type { Contract, HandlerSpec, HandlerSpecMap, ServiceImplementation } from './Service.ts'

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
 * - Anything else (defect / interrupt) → return the squashed cause so the SDK
 *   throws it as a normal error and RETRIES.
 */
export const toTerminal = (
  cause: Cause.Cause<unknown>,
  errorSchema?: Schema.Schema<any, any>,
): unknown => {
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
  /* Defect / interrupt → let the SDK retry. */
  return Cause.squash(cause)
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
      const run = (
        impl as Record<string, (input: unknown) => Effect.Effect<unknown, unknown, any>>
      )[name]!
      return [
        name,
        restate.handlers.handler(
          { input: ingressSerde(spec.input), output: ingressSerde(spec.success) },
          async (ctx: restate.Context, input: unknown) => {
            const discharged = run(input).pipe(Effect.provideService(RestateContext, ctx))
            const exit = await Runtime.runPromiseExit(runtime)(
              discharged as Effect.Effect<unknown, unknown, AppR>,
            )
            if (Exit.isSuccess(exit) === true) return exit.value
            throw toTerminal(exit.cause, spec.error)
          },
        ),
      ]
    }),
  )
  return restate.service({ name: contract.name, handlers }) as restate.ServiceDefinition<
    string,
    unknown
  >
}

/* eslint-enable @typescript-eslint/no-explicit-any */

/** Options for the endpoint server layer / `serve`. */
export interface EndpointOptions<AppR> {
  readonly services: ReadonlyArray<ServiceImplementation<Contract<string, HandlerSpecMap>, AppR>>
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
        services: opts.services.map((s) => materialize(s, runtime)),
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
