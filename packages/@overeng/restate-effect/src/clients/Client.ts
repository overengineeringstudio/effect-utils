import * as clients from '@restatedev/restate-sdk-clients'
import { Config, type ConfigError, Context, Effect, Layer, Option, Redacted, Schema } from 'effect'

import {
  type AwakeableId,
  type Descriptor,
  inHandlerClients,
  type RestateContext,
  type SendOptions,
  type StateSchemas,
} from '../authoring/RestateContext.ts'
import type {
  Contract,
  ErrorOf,
  HandlerSpec,
  HandlerSpecMap,
  InputOf,
  MethodsOf,
  ObjectContract,
  ObjectErrorOf,
  ObjectInputOf,
  ObjectMethodsOf,
  ObjectSuccessOf,
  SuccessOf,
  WorkflowContract,
  WorkflowRunErrorOf,
  WorkflowRunInputOf,
  WorkflowRunSuccessOf,
  WorkflowSignalInputOf,
  WorkflowSignalQueryOf,
  WorkflowSignalSuccessOf,
} from '../authoring/Service.ts'
import { type RedactionCipher, RestateRedaction } from '../schema/Redaction.ts'
import { RestateError } from '../schema/RestateError.ts'
import {
  type ContractSerdeFactory,
  contractSerdeFactory,
  ingressCallOpts,
  ingressSendOpts,
} from './InvocationPolicy.ts'

/**
 * The service shape held by the `RestateIngress` Tag — the connected SDK
 * ingress used by `call` / `callTyped`, PLUS the redaction cipher threaded into
 * every client serde via the contract-invocation policy (decision 0020). The
 * cipher is OPTIONAL: a contract with no `Restate.sensitive` field never needs
 * one; a contract WITH a sensitive field fails LOUDLY at encode/decode when the
 * cipher is absent (`RedactionCipherMissingError`), never silent plaintext.
 */
export interface RestateIngressService {
  readonly ingress: clients.Ingress
  readonly redaction?: RedactionCipher
}

/* Service to make typed ingress calls against a `restate-server` ingress URL.
 * Build the layer with `RestateIngress.layer({ url, apiKey? })` (or the
 * env-driven `RestateIngress.layerConfig`) and `yield* RestateIngress` (or thread
 * `call` / `callTyped`, which require it in `R`). */
export class RestateIngress extends Context.Tag('@overeng/restate-effect/RestateIngress')<
  RestateIngress,
  RestateIngressService
>() {
  /**
   * Build a `RestateIngress` layer bound to a `restate-server` ingress URL. The
   * PRIMITIVE form (a thin wrapper over `clients.connect`).
   *
   * For a SECURED / Restate Cloud ingress, pass `apiKey` (a `Redacted<string>`,
   * so the key never prints in logs/error messages): it is sent as the
   * `Authorization: Bearer <key>` header on every ingress request. Extra
   * `headers` are merged in (the bearer header wins). When neither is set the
   * connection is unauthenticated (a local dev server).
   */
  static layer = (opts: {
    readonly url: string
    readonly apiKey?: Redacted.Redacted<string>
    readonly headers?: Readonly<Record<string, string>>
  }): Layer.Layer<RestateIngress> =>
    /* Resolve an OPTIONAL `RestateRedaction` cipher from the surrounding context
     * and thread it into the ingress, so a `Restate.sensitive` field is encrypted
     * on the wire (decision 0020). Absent → no cipher (fine unless a served
     * contract marks a field sensitive, which then fails loudly at encode/decode). */
    Layer.effect(
      RestateIngress,
      Effect.serviceOption(RestateRedaction).pipe(
        Effect.map((redaction) =>
          makeIngress({
            ...opts,
            ...(Option.isSome(redaction) === true ? { redaction: redaction.value } : {}),
          }),
        ),
      ),
    )

  /**
   * Build a `RestateIngress` layer from `Config` (env-driven): the ingress URL
   * from `RESTATE_INGRESS_URL` and an OPTIONAL bearer API key from
   * `RESTATE_INGRESS_KEY` (read as a `Config.redacted`, so the secret stays a
   * `Redacted` and never prints). A thin `Config`-then-literal wrapper over
   * {@link RestateIngress.layer} — secured/Cloud ingress with zero call-site
   * secret handling. Fails the layer with a `ConfigError` if `RESTATE_INGRESS_URL`
   * is unset.
   */
  static layerConfig = (): Layer.Layer<RestateIngress, ConfigError.ConfigError> =>
    Layer.effect(
      RestateIngress,
      Effect.gen(function* () {
        const url = yield* Config.url('RESTATE_INGRESS_URL')
        const apiKey = yield* Config.option(Config.redacted('RESTATE_INGRESS_KEY'))
        const redaction = yield* Effect.serviceOption(RestateRedaction)
        return makeIngress({
          url: url.toString(),
          ...(Option.isSome(apiKey) === true ? { apiKey: apiKey.value } : {}),
          ...(Option.isSome(redaction) === true ? { redaction: redaction.value } : {}),
        })
      }),
    )
}

/* Connect the SDK ingress client, threading an optional bearer API key + extra
 * headers into `clients.connect({ headers })`. The `apiKey` is unwrapped from its
 * `Redacted` only HERE, at the connect boundary (never logged). The optional
 * `redaction` cipher rides on the service so every client serde encrypts a
 * `Restate.sensitive` field on the wire (decision 0020). */
const makeIngress = (opts: {
  readonly url: string
  readonly apiKey?: Redacted.Redacted<string>
  readonly headers?: Readonly<Record<string, string>>
  readonly redaction?: RedactionCipher
}): RestateIngressService => {
  const headers: Record<string, string> = {
    ...opts.headers,
    ...(opts.apiKey !== undefined
      ? { Authorization: `Bearer ${Redacted.value(opts.apiKey)}` }
      : {}),
  }
  return {
    ingress: clients.connect({
      url: opts.url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    }),
    ...(opts.redaction !== undefined ? { redaction: opts.redaction } : {}),
  }
}

/* The contract-invocation policy's serde factory bound to this ingress's
 * (optional) redaction cipher (decision 0020) — the SINGLE place every ingress
 * client path derives its redaction-threaded serdes + idempotency opts from. */
const serdesOf = (self: RestateIngressService): ContractSerdeFactory =>
  contractSerdeFactory(self.redaction)

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
          /* The contract-invocation policy folds the redaction-threaded I/O serdes
           * AND the `Restate.idempotencyKey`-field extraction into one opts bag
           * (decision 0020) — so a Service `call` encrypts a `sensitive` field and
           * dedupes on its idempotency key, exactly like `objectCall`. */
          opts: ingressCallOpts({
            serdes: serdesOf(self),
            inputSchema: spec.input,
            outputSchema: spec.success,
            input,
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
): Effect.Effect<A, RestateError | ErrorOf<C, M>> =>
  decodeErrorWith<ErrorOf<C, M>, A>(contract.handlers[method]!.error, restateError)

/**
 * Re-decode a transport `RestateError`'s `TerminalError` body into the declared
 * tagged error via `errorSchema` (R14, decision 0003). On a match, FAIL with the
 * typed error so a caller can `catchTag` it; otherwise the original
 * `RestateError` propagates. Schema-driven so Service / Object / Workflow /
 * `result` paths all share it.
 */
export const decodeErrorWith = <DomE, A = never>(
  errorSchema: Schema.Schema<DomE, any> | undefined,
  restateError: RestateError,
): Effect.Effect<A, RestateError | DomE> => {
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
        ...candidates.map((c) => decode(c).pipe(Effect.map((decoded) => decoded as DomE))),
        Effect.fail(restateError),
      ]),
    ),
    Effect.matchEffect({
      onFailure: () => Effect.fail(restateError),
      onSuccess: (decoded) => Effect.fail(decoded as DomE),
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

/* ════════════════════════════════════════════════════════════════════════
 * Virtual Object ingress client (keyed call / send).
 * ════════════════════════════════════════════════════════════════════════ */

/* eslint-disable @typescript-eslint/no-explicit-any -- generic-ingress boundary; the public Object/Workflow types stay precise */

/**
 * Typed request-response call to a Virtual Object handler, routed by the
 * contract's name + the per-invocation `key` (decision 0008). Input encoded /
 * success decoded via the contract's serde; the idempotency key is read from the
 * annotated input field. Same contract-invocation policy as Service `call`
 * (decision 0020). A `TerminalError` body is NOT auto-decoded here — use
 * `objectCallTyped` to recover the typed tagged error.
 */
export const objectCall = <
  C extends ObjectContract<string, any, any>,
  M extends ObjectMethodsOf<C>,
>(
  contract: C,
  key: string,
  method: M,
  input: ObjectInputOf<C, M>,
): Effect.Effect<ObjectSuccessOf<C, M>, RestateError, RestateIngress> =>
  Effect.gen(function* () {
    const self = yield* RestateIngress
    const spec = contract.handlers[method] as HandlerSpec
    const result = yield* Effect.tryPromise({
      try: () =>
        self.ingress.call<unknown, unknown>({
          service: contract.name,
          handler: method,
          parameter: input,
          key,
          opts: ingressCallOpts({
            serdes: serdesOf(self),
            inputSchema: spec.input,
            outputSchema: spec.success,
            input,
          }),
        }),
      catch: (cause) =>
        new RestateError({
          reason: 'IngressFailed',
          method: `objectCall(${contract.name}.${method})`,
          cause,
        }),
    })
    return result as ObjectSuccessOf<C, M>
  })

/** `objectCall` that recovers the contract's typed tagged error from the terminal body (R14). */
export const objectCallTyped = <
  C extends ObjectContract<string, any, any>,
  M extends ObjectMethodsOf<C>,
>(
  contract: C,
  key: string,
  method: M,
  input: ObjectInputOf<C, M>,
): Effect.Effect<ObjectSuccessOf<C, M>, RestateError | ObjectErrorOf<C, M>, RestateIngress> =>
  objectCall(contract, key, method, input).pipe(
    Effect.catchAll((restateError) =>
      decodeErrorWith<ObjectErrorOf<C, M>, ObjectSuccessOf<C, M>>(
        (contract.handlers[method] as HandlerSpec).error,
        restateError,
      ),
    ),
  )

/**
 * One-way (fire-and-forget) send to a Virtual Object handler. Returns the SDK
 * `Send` handle (an invocation id + status); use `result` to attach to its output
 * later (requires an idempotency key for output retention).
 */
export const objectSend = <
  C extends ObjectContract<string, any, any>,
  M extends ObjectMethodsOf<C>,
>(
  contract: C,
  key: string,
  method: M,
  input: ObjectInputOf<C, M>,
  opts?: { readonly delayMillis?: number },
): Effect.Effect<clients.Send, RestateError, RestateIngress> =>
  Effect.gen(function* () {
    const self = yield* RestateIngress
    const spec = contract.handlers[method] as HandlerSpec
    return yield* Effect.tryPromise({
      try: () =>
        self.ingress.send<unknown>({
          service: contract.name,
          handler: method,
          parameter: input,
          key,
          opts: ingressSendOpts({
            serdes: serdesOf(self),
            inputSchema: spec.input,
            input,
            ...(opts?.delayMillis !== undefined ? { delayMillis: opts.delayMillis } : {}),
          }),
        }),
      catch: (cause) =>
        new RestateError({
          reason: 'IngressFailed',
          method: `objectSend(${contract.name}.${method})`,
          cause,
        }),
    })
  })

/* ════════════════════════════════════════════════════════════════════════
 * Workflow ingress client (submit / attach / output; `run` omitted, R32).
 * Plus typed signal/query calls (the shared handlers).
 * ════════════════════════════════════════════════════════════════════════ */

/* The SDK workflow ingress client surface (submit/attach/output + signal/query). */
type WorkflowIngressClient = clients.IngressWorkflowClient<Record<string, never>> &
  Record<string, (...args: ReadonlyArray<unknown>) => Promise<unknown>>

const workflowClient = (
  self: RestateIngressService,
  contract: WorkflowContract<string, StateSchemas, any, any, any>,
  key: string,
): WorkflowIngressClient =>
  self.ingress.workflowClient<Record<string, never>>(
    { name: contract.name },
    key,
  ) as unknown as WorkflowIngressClient

/**
 * Submit a Workflow `run` for a workflow ID (idempotent; returns immediately with
 * a `WorkflowSubmission` handle, R32). The `run` input is encoded via the
 * contract's `payload` serde; the idempotency key defaults to the annotated input
 * field, else the workflow `key`.
 */
export const workflowSubmit = <C extends WorkflowContract<string, any, any, any, any>>(
  contract: C,
  key: string,
  input: WorkflowRunInputOf<C>,
): Effect.Effect<
  clients.WorkflowSubmission<WorkflowRunSuccessOf<C>>,
  RestateError,
  RestateIngress
> =>
  Effect.gen(function* () {
    const self = yield* RestateIngress
    const client = workflowClient(self, contract, key)
    return yield* Effect.tryPromise({
      try: () =>
        client.workflowSubmit(
          input,
          ingressSendOpts({
            serdes: serdesOf(self),
            inputSchema: contract.run.input,
            input,
          }),
        ) as Promise<clients.WorkflowSubmission<WorkflowRunSuccessOf<C>>>,
      catch: (cause) =>
        new RestateError({
          reason: 'IngressFailed',
          method: `workflowSubmit(${contract.name})`,
          cause,
        }),
    })
  })

/**
 * Attach to a submitted Workflow and AWAIT its completion (retry-safe, R32),
 * returning the typed `run` success or — on a terminal failure — the DECODED
 * tagged error (same decode helper as R14).
 */
export const workflowAttach = <C extends WorkflowContract<string, any, any, any, any>>(
  contract: C,
  key: string,
): Effect.Effect<WorkflowRunSuccessOf<C>, RestateError | WorkflowRunErrorOf<C>, RestateIngress> =>
  Effect.gen(function* () {
    const self = yield* RestateIngress
    const client = workflowClient(self, contract, key)
    return yield* Effect.tryPromise({
      try: () =>
        client.workflowAttach(
          clients.Opts.from({
            output: serdesOf(self).forSchema(contract.run.success, 'ingress'),
          }),
        ) as Promise<WorkflowRunSuccessOf<C>>,
      catch: (cause) =>
        new RestateError({
          reason: 'IngressFailed',
          method: `workflowAttach(${contract.name})`,
          cause,
        }),
    })
  }).pipe(
    Effect.catchAll((restateError) =>
      decodeErrorWith<WorkflowRunErrorOf<C>, WorkflowRunSuccessOf<C>>(
        (contract.run as HandlerSpec).error,
        restateError,
      ),
    ),
  )

/**
 * Non-blocking peek at a Workflow's output (R32): `{ ready, result }`. `result`
 * is the typed `run` success when `ready` is true. Does NOT decode a terminal
 * error — a failed workflow surfaces the transport error on access; use
 * `workflowAttach` for the typed terminal decode.
 */
export const workflowOutput = <C extends WorkflowContract<string, any, any, any, any>>(
  contract: C,
  key: string,
): Effect.Effect<clients.Output<WorkflowRunSuccessOf<C>>, RestateError, RestateIngress> =>
  Effect.gen(function* () {
    const self = yield* RestateIngress
    const client = workflowClient(self, contract, key)
    return yield* Effect.tryPromise({
      try: () =>
        client.workflowOutput(
          clients.Opts.from({
            output: serdesOf(self).forSchema(contract.run.success, 'ingress'),
          }),
        ) as Promise<clients.Output<WorkflowRunSuccessOf<C>>>,
      catch: (cause) =>
        new RestateError({
          reason: 'IngressFailed',
          method: `workflowOutput(${contract.name})`,
          cause,
        }),
    })
  })

/**
 * Call a Workflow SIGNAL or QUERY handler (the shared handlers) for a workflow ID
 * — e.g. resolve a durable promise (signal) or read State (query). The `run`
 * handler is NOT in this surface (R32 — use `workflowSubmit`).
 */
export const workflowCall = <
  C extends WorkflowContract<string, any, any, any, any>,
  M extends WorkflowSignalQueryOf<C>,
>(
  contract: C,
  key: string,
  method: M,
  input: WorkflowSignalInputOf<C, M>,
): Effect.Effect<WorkflowSignalSuccessOf<C, M>, RestateError, RestateIngress> =>
  Effect.gen(function* () {
    const self = yield* RestateIngress
    const spec = (contract.signals[method] ?? contract.queries[method]) as HandlerSpec
    const result = yield* Effect.tryPromise({
      try: () =>
        self.ingress.call<unknown, unknown>({
          service: contract.name,
          handler: method,
          parameter: input,
          key,
          opts: ingressCallOpts({
            serdes: serdesOf(self),
            inputSchema: spec.input,
            outputSchema: spec.success,
            input,
          }),
        }),
      catch: (cause) =>
        new RestateError({
          reason: 'IngressFailed',
          method: `workflowCall(${contract.name}.${method})`,
          cause,
        }),
    })
    return result as WorkflowSignalSuccessOf<C, M>
  })

/* ════════════════════════════════════════════════════════════════════════
 * Awakeable external completion (R33) + invocation attach/result (R32).
 * ════════════════════════════════════════════════════════════════════════ */

/** Resolve an awakeable from ingress with a typed payload (encoded via `schema`). */
export const resolveAwakeable = <T, I>(
  schema: Schema.Schema<T, I>,
  id: AwakeableId<T>,
  payload: T,
): Effect.Effect<void, RestateError, RestateIngress> =>
  Effect.gen(function* () {
    const self = yield* RestateIngress
    yield* Effect.tryPromise({
      try: () =>
        self.ingress.resolveAwakeable<T>(
          id,
          payload,
          serdesOf(self).forSchema(schema as Schema.Schema<unknown, unknown>, 'ingress') as never,
        ),
      catch: (cause) =>
        new RestateError({ reason: 'IngressFailed', method: `resolveAwakeable(${id})`, cause }),
    })
  })

/** Reject an awakeable from ingress (the awaiting handler fails terminally). */
export const rejectAwakeable = <T>(
  id: AwakeableId<T>,
  reason: string,
): Effect.Effect<void, RestateError, RestateIngress> =>
  Effect.gen(function* () {
    const self = yield* RestateIngress
    yield* Effect.tryPromise({
      try: () => self.ingress.rejectAwakeable(id, reason),
      catch: (cause) =>
        new RestateError({ reason: 'IngressFailed', method: `rejectAwakeable(${id})`, cause }),
    })
  })

/**
 * Attach to a prior `send` / workflow submission and await its output (get-output
 * by invocation id / idempotency key, R32), returning the typed success decoded
 * via `outputSchema`. A `TerminalError` body is NOT auto-decoded — wrap with the
 * relevant `*Typed`/`decodeTerminalError` if you need the tagged error.
 */
export const result = <T, I>(
  /* The send/submission is an opaque handle — `T` is inferred from `outputSchema`,
   * not the (often `unknown`-typed) `Send` returned by `objectSend`/`send`. */
  send: clients.Send<unknown> | clients.WorkflowSubmission<unknown>,
  outputSchema: Schema.Schema<T, I>,
): Effect.Effect<T, RestateError, RestateIngress> =>
  Effect.gen(function* () {
    const self = yield* RestateIngress
    return yield* Effect.tryPromise({
      try: () =>
        self.ingress.result<T>(
          send as clients.Send<T>,
          serdesOf(self).forSchema(
            outputSchema as Schema.Schema<unknown, unknown>,
            'ingress',
          ) as never,
        ),
      catch: (cause) => new RestateError({ reason: 'IngressFailed', method: 'result', cause }),
    })
  })

/* ════════════════════════════════════════════════════════════════════════
 * In-handler service-to-service clients (require `RestateContext`, docs/vrs/05-clients/spec.md §2).
 * Typed from the target contract; idempotency from the annotated input field.
 * ════════════════════════════════════════════════════════════════════════ */

/** In-handler request/response call to a stateless Service handler. */
export const callService = <C extends Contract<string, HandlerSpecMap>, M extends MethodsOf<C>>(
  contract: C,
  method: M,
  input: InputOf<C, M>,
): Effect.Effect<SuccessOf<C, M>, never, RestateContext> => {
  const spec = contract.handlers[method]!
  return inHandlerClients.callRpc<InputOf<C, M>, unknown, SuccessOf<C, M>, unknown>({
    service: contract.name,
    handler: method,
    inputSchema: spec.input,
    outputSchema: spec.success,
    input,
  })
}

/** In-handler one-way (optionally delayed) send to a stateless Service handler. */
export const sendService = <C extends Contract<string, HandlerSpecMap>, M extends MethodsOf<C>>(
  contract: C,
  method: M,
  input: InputOf<C, M>,
  opts?: SendOptions,
): Effect.Effect<void, RestateError, RestateContext> =>
  inHandlerClients.sendRpc<InputOf<C, M>, unknown>({
    service: contract.name,
    handler: method,
    inputSchema: contract.handlers[method]!.input,
    input,
    ...(opts?.delayMillis !== undefined ? { delayMillis: opts.delayMillis } : {}),
  })

/**
 * A typed in-handler service `call` issued as a `Descriptor` (#2), so a peer call
 * joins `Restate.all`/`race`/`any` deterministically (issued in source order,
 * awaited once). Same typing + idempotency path as `callService`.
 */
export const callServiceDescriptor = <
  C extends Contract<string, HandlerSpecMap>,
  M extends MethodsOf<C>,
>(
  contract: C,
  method: M,
  input: InputOf<C, M>,
): Descriptor<SuccessOf<C, M>> => {
  const spec = contract.handlers[method]!
  return inHandlerClients.callDescriptor<InputOf<C, M>, unknown, SuccessOf<C, M>, unknown>({
    service: contract.name,
    handler: method,
    inputSchema: spec.input,
    outputSchema: spec.success,
    input,
  })
}

/** In-handler request/response call to a keyed Virtual Object handler. */
export const callObject = <
  C extends ObjectContract<string, any, any>,
  M extends ObjectMethodsOf<C>,
>(
  contract: C,
  key: string,
  method: M,
  input: ObjectInputOf<C, M>,
): Effect.Effect<ObjectSuccessOf<C, M>, never, RestateContext> => {
  const spec = contract.handlers[method] as HandlerSpec
  return inHandlerClients.callRpc<ObjectInputOf<C, M>, unknown, ObjectSuccessOf<C, M>, unknown>({
    service: contract.name,
    handler: method,
    inputSchema: spec.input,
    outputSchema: spec.success,
    input,
    key,
  })
}

/** A typed in-handler Object `call` issued as a `Descriptor` for the deterministic combinators (#2). */
export const callObjectDescriptor = <
  C extends ObjectContract<string, any, any>,
  M extends ObjectMethodsOf<C>,
>(
  contract: C,
  key: string,
  method: M,
  input: ObjectInputOf<C, M>,
): Descriptor<ObjectSuccessOf<C, M>> => {
  const spec = contract.handlers[method] as HandlerSpec
  return inHandlerClients.callDescriptor<
    ObjectInputOf<C, M>,
    unknown,
    ObjectSuccessOf<C, M>,
    unknown
  >({
    service: contract.name,
    handler: method,
    inputSchema: spec.input,
    outputSchema: spec.success,
    input,
    key,
  })
}

/** In-handler one-way (optionally delayed) send to a keyed Virtual Object handler. */
export const sendObject = <
  C extends ObjectContract<string, any, any>,
  M extends ObjectMethodsOf<C>,
>(
  contract: C,
  key: string,
  method: M,
  input: ObjectInputOf<C, M>,
  opts?: SendOptions,
): Effect.Effect<void, RestateError, RestateContext> =>
  inHandlerClients.sendRpc<ObjectInputOf<C, M>, unknown>({
    service: contract.name,
    handler: method,
    inputSchema: (contract.handlers[method] as HandlerSpec).input,
    input,
    key,
    ...(opts?.delayMillis !== undefined ? { delayMillis: opts.delayMillis } : {}),
  })

/** In-handler submit (one-way send to `run`) of a Workflow for a workflow ID. */
export const sendWorkflowRun = <C extends WorkflowContract<string, any, any, any, any>>(
  contract: C,
  key: string,
  input: WorkflowRunInputOf<C>,
  opts?: SendOptions,
): Effect.Effect<void, RestateError, RestateContext> =>
  inHandlerClients.sendRpc<WorkflowRunInputOf<C>, unknown>({
    service: contract.name,
    handler: 'run',
    inputSchema: contract.run.input,
    input,
    key,
    ...(opts?.delayMillis !== undefined ? { delayMillis: opts.delayMillis } : {}),
  })

/** In-handler call to a Workflow signal/query handler for a workflow ID. */
export const callWorkflowSignal = <
  C extends WorkflowContract<string, any, any, any, any>,
  M extends WorkflowSignalQueryOf<C>,
>(
  contract: C,
  key: string,
  method: M,
  input: WorkflowSignalInputOf<C, M>,
): Effect.Effect<WorkflowSignalSuccessOf<C, M>, never, RestateContext> => {
  const spec = (contract.signals[method] ?? contract.queries[method]) as HandlerSpec
  return inHandlerClients.callRpc<
    WorkflowSignalInputOf<C, M>,
    unknown,
    WorkflowSignalSuccessOf<C, M>,
    unknown
  >({
    service: contract.name,
    handler: method,
    inputSchema: spec.input,
    outputSchema: spec.success,
    input,
    key,
  })
}

/* eslint-enable @typescript-eslint/no-explicit-any */
