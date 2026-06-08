import * as clients from '@restatedev/restate-sdk-clients'
import { Context, Effect, Layer, Option, Schema } from 'effect'

import { RestateError } from './RestateError.ts'
import { ingressSerde } from './Serde.ts'
import type { Contract, ErrorOf, HandlerSpecMap, InputOf, MethodsOf, SuccessOf } from './Service.ts'

/**
 * The service shape held by the `RestateIngress` Tag — the connected SDK
 * ingress used by `call` / `callTyped`.
 */
export interface RestateIngressService {
  readonly ingress: clients.Ingress
}

/* Service to make typed ingress calls against a `restate-server` ingress URL.
 * Build the layer with `RestateIngress.layer({ url })` and `yield* RestateIngress`
 * (or thread `call` / `callTyped`, which require it in `R`). */
export class RestateIngress extends Context.Tag('@overeng/restate-effect/RestateIngress')<
  RestateIngress,
  RestateIngressService
>() {
  /** Build a `RestateIngress` layer bound to a `restate-server` ingress URL. */
  static layer = (opts: { readonly url: string }): Layer.Layer<RestateIngress> =>
    Layer.succeed(RestateIngress, { ingress: clients.connect({ url: opts.url }) })
}

/**
 * Typed request-response ingress call derived from the contract + method
 * (decision 0008): the input is encoded through the contract's input serde and
 * the result decoded through its success serde. A `TerminalError` body is NOT
 * auto-decoded here (the raw transport `HttpCallError` surfaces); use
 * `decodeTerminalError` / `callTyped` to recover the typed tagged error.
 */
export const call = <C extends Contract<string, HandlerSpecMap>, M extends MethodsOf<C>>(
  contract: C,
  method: M,
  input: InputOf<C, M>,
): Effect.Effect<SuccessOf<C, M>, RestateError, RestateIngress> =>
  Effect.gen(function* () {
    const self = yield* RestateIngress
    const spec = contract.handlers[method]!
    const result = yield* Effect.tryPromise({
      try: () =>
        self.ingress.call<unknown, unknown>({
          service: contract.name,
          handler: method,
          parameter: input,
          opts: clients.Opts.from({
            input: ingressSerde(spec.input),
            output: ingressSerde(spec.success),
          }),
        }),
      catch: (cause) =>
        new RestateError({
          reason: 'IngressFailed',
          method: `call(${contract.name}.${method})`,
          cause,
        }),
    })
    return result as SuccessOf<C, M>
  })

/**
 * Decode a transport-level ingress error into the contract's typed tagged
 * error (R14, decision 0003). It catches a `HttpCallError`, `JSON.parse`s the
 * `responseText` (the `TerminalError` message body), and re-`Schema.decode`s it
 * through the contract's `error` schema. On a match it FAILS the Effect with the
 * typed error so a caller can `catchTag` it; otherwise the original
 * `RestateError` propagates unchanged.
 */
export const decodeTerminalError =
  <C extends Contract<string, HandlerSpecMap>, M extends MethodsOf<C>>(contract: C, method: M) =>
  <A, R>(
    self: Effect.Effect<A, RestateError, R>,
  ): Effect.Effect<A, RestateError | ErrorOf<C, M>, R> =>
    self.pipe(
      Effect.catchAll((restateError) => decodeError<C, M, A>(contract, method, restateError)),
    )

/**
 * Typed ingress call that recovers the contract's tagged `error` from a terminal
 * body (R14): `call` followed by `decodeTerminalError`. A caller `catchTag`s the
 * domain error rather than a raw transport error.
 */
export const callTyped = <C extends Contract<string, HandlerSpecMap>, M extends MethodsOf<C>>(
  contract: C,
  method: M,
  input: InputOf<C, M>,
): Effect.Effect<SuccessOf<C, M>, RestateError | ErrorOf<C, M>, RestateIngress> =>
  call(contract, method, input).pipe(decodeTerminalError(contract, method))

const decodeError = <C extends Contract<string, HandlerSpecMap>, M extends MethodsOf<C>, A = never>(
  contract: C,
  method: M,
  restateError: RestateError,
): Effect.Effect<A, RestateError | ErrorOf<C, M>> => {
  const spec = contract.handlers[method]!
  const errorSchema = spec.error
  const responseText = httpErrorBody(restateError.cause)
  if (errorSchema === undefined || responseText === undefined) {
    return Effect.fail(restateError)
  }
  const decode = (value: unknown) => Schema.decodeUnknown(errorSchema)(value)
  return Effect.sync(() => terminalBodyCandidates(responseText)).pipe(
    Effect.flatMap((candidates) =>
      /* Try each candidate body (the `responseText` may be the raw `_tag` body OR
       * the ingress envelope `{ code, message, metadata }` whose `message` is the
       * JSON-encoded body). Succeed on the first that decodes; else keep the
       * transport error so the caller still sees a `RestateError`. */
      Effect.firstSuccessOf([
        ...candidates.map((c) => decode(c).pipe(Effect.map((decoded) => decoded as ErrorOf<C, M>))),
        Effect.fail(restateError),
      ]),
    ),
    Effect.matchEffect({
      onFailure: () => Effect.fail(restateError),
      onSuccess: (decoded) => Effect.fail(decoded as ErrorOf<C, M>),
    }),
  )
}

/**
 * The plausible terminal-error bodies inside an ingress `responseText`: the raw
 * parsed value, and — when the transport wraps it in `{ code, message, metadata
 * }` — the JSON-parsed `message` string (the actual `toTerminal` body).
 */
const terminalBodyCandidates = (responseText: string): ReadonlyArray<unknown> => {
  const parsedOuter = tryParse(responseText)
  if (parsedOuter === undefined) return []
  const candidates: unknown[] = [parsedOuter]
  if (
    typeof parsedOuter === 'object' &&
    parsedOuter !== null &&
    'message' in parsedOuter &&
    typeof (parsedOuter as { message: unknown }).message === 'string'
  ) {
    const inner = tryParse((parsedOuter as { message: string }).message)
    if (inner !== undefined) candidates.push(inner)
  }
  return candidates
}

const tryParse = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** Pull the `responseText` off a transport `HttpCallError` carried in the cause. */
const httpErrorBody = (cause: unknown): string | undefined =>
  Option.fromNullable(cause)
    .pipe(
      Option.filter((c): c is clients.HttpCallError => c instanceof clients.HttpCallError),
      Option.map((c) => c.responseText),
    )
    .pipe(Option.getOrUndefined)
