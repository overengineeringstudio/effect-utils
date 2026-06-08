import * as http2 from 'node:http2'

import * as restate from '@restatedev/restate-sdk'
import { createEndpointHandler } from '@restatedev/restate-sdk/node'
import { Cause, Effect, Exit, Layer, Runtime, Schema } from 'effect'

import { RestateContext } from './RestateContext.ts'
import { RestateError } from './RestateError.ts'
import { effectSerde } from './Serde.ts'
import type { HandlerDef, ServiceDef } from './Service.ts'

/**
 * Maps an Effect failure `Cause` to a Restate handler outcome.
 *
 * - A typed/expected failure (`Cause.failureOption` is `Some`) is the handler's
 *   declared `E` — a deterministic domain failure. Encode it (via the handler's
 *   `error` schema when present) and throw a `restate.TerminalError` so it
 *   propagates to the caller WITHOUT retry. The error `_tag` is surfaced as
 *   metadata for callers on server ≥1.6.
 * - Anything else (defect, interrupt) is unexpected/transient — return the
 *   squashed cause so the SDK throws it as a normal error and RETRIES.
 *
 * A Restate suspension is never a failure: never convert `isSuspendedError`
 * into a terminal error.
 */
export const toTerminal = (
  cause: Cause.Cause<unknown>,
  errorSchema?: Schema.Schema<unknown, unknown>,
): unknown => {
  const failure = Cause.failureOption(cause)
  if (failure._tag === 'Some') {
    const error = failure.value
    /* A Restate suspension is never a real failure — never terminalize it. */
    if (restate.internal.isSuspendedError(error) === true) return Cause.squash(cause)
    const body = errorSchema !== undefined ? Schema.encodeSync(errorSchema)(error) : error
    const tag =
      typeof error === 'object' && error !== null && '_tag' in error
        ? String((error as { _tag: unknown })._tag)
        : undefined
    return new restate.TerminalError(JSON.stringify(body), {
      errorCode: 500,
      ...(tag !== undefined ? { metadata: { _tag: tag } } : {}),
    })
  }
  /* Defect / interrupt → let the SDK retry. Preserve a suspension as-is. */
  return Cause.squash(cause)
}

/**
 * Materializes a Schema-typed `ServiceDef` into a runtime `restate.service`
 * definition. Each handler runs the user's Effect on the *captured* runtime
 * (built once from the application `Layer`), provides the per-invocation
 * `RestateContext`, and maps the exit to a return value or a thrown
 * `TerminalError`/retryable error via `toTerminal`.
 *
 * The phantom `ServiceDefinition` returned by `restate.service` only carries
 * `{ name }` at runtime; the handler-map type is erased. We keep the authoring
 * API (`Service.handler`) fully typed and accept localized casts here, at the
 * widened boundary.
 */
export const materialize = <R>(
  def: ServiceDef<R>,
  runtime: Runtime.Runtime<R>,
): restate.ServiceDefinition<string, unknown> => {
  const handlers = Object.fromEntries(
    Object.entries(def.handlers).map(([name, hd]: [string, HandlerDef<R>]) => [
      name,
      restate.handlers.handler(
        { input: effectSerde(hd.input), output: effectSerde(hd.success) },
        async (ctx: restate.Context, input: unknown) => {
          const exit = await Runtime.runPromiseExit(runtime)(
            hd.run(input).pipe(Effect.provideService(RestateContext, ctx)),
          )
          if (Exit.isSuccess(exit) === true) return exit.value
          throw toTerminal(exit.cause, hd.error as Schema.Schema<unknown, unknown> | undefined)
        },
      ),
    ]),
  )
  return restate.service({ name: def.name, handlers }) as restate.ServiceDefinition<string, unknown>
}

/** Options for the endpoint server layer / `serve`. */
export interface EndpointOptions<R> {
  readonly services: ReadonlyArray<ServiceDef<R>>
  readonly port: number
}

/**
 * A scoped `Layer` that binds the given services to an h2c (cleartext HTTP/2)
 * server on `opts.port` and serves the Restate discovery/invocation protocol.
 *
 * The shared application runtime is captured once (`Effect.runtime<R>()`), the
 * server is started on acquire, and a finalizer closes it on scope teardown —
 * so the endpoint participates in graceful (SIGTERM-driven) shutdown when
 * launched via `serve` + `NodeRuntime.runMain`.
 */
export const layer = <R>(opts: EndpointOptions<R>): Layer.Layer<never, RestateError, R> =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const runtime = yield* Effect.runtime<R>()
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
 * Long-lived production entrypoint: launches the endpoint `layer` and blocks
 * until interrupted, running finalizers (graceful server close + all scoped
 * application resources) on SIGTERM.
 *
 * Consumers run it via `@effect/platform-node`'s `NodeRuntime.runMain` after
 * `Effect.provide(AppLayer)`:
 *
 * ```ts
 * serve({ services: [greeter], port: 9080 }).pipe(
 *   Effect.provide(AppLayer),
 *   NodeRuntime.runMain,
 * )
 * ```
 */
export const serve = <R>(opts: EndpointOptions<R>): Effect.Effect<never, RestateError, R> =>
  Layer.launch(layer(opts))
