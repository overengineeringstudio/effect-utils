import { Effect, Schema } from 'effect'

import { Input, Transport } from './errors.ts'

/** Requests and cancellation commands accepted by the remote isolate. */
export const RequestMessage = Schema.Union([
  Schema.TaggedStruct('Request', { id: Schema.Int, payload: Schema.Unknown }),
  Schema.TaggedStruct('Cancel', { id: Schema.Int }),
])
/** Results and quiescence acknowledgments returned by the remote isolate. */
export const ResponseMessage = Schema.Union([
  Schema.TaggedStruct('Success', { id: Schema.Int, payload: Schema.Unknown }),
  Schema.TaggedStruct('Failure', { id: Schema.Int, payload: Schema.Unknown }),
  Schema.TaggedStruct('Defect', { id: Schema.Int, message: Schema.String }),
  Schema.TaggedStruct('Cancelled', { id: Schema.Int }),
])

/** Ordered message transport whose close waits for remote termination. */
export interface MessageEndpoint {
  readonly postMessage: (message: unknown) => void
  readonly subscribe: (
    message: (message: unknown) => void,
    failure: (cause: unknown) => void,
  ) => () => void
  /** Resolves only after the worker/process has stopped. */
  readonly close: () => void | PromiseLike<void>
}
/** Codecs for request payloads, successful results, and typed failures. */
export interface RpcSchemas<TRequest, TResponse, TError> {
  readonly request: Schema.Codec<TRequest, unknown>
  readonly response: Schema.Codec<TResponse, unknown>
  readonly error: Schema.Codec<TError, unknown>
}
/** Effect-facing request client with acknowledged cancellation. */
export interface ProcessClient<TRequest, TResponse, TError> {
  readonly request: (request: TRequest) => Effect.Effect<TResponse, TError | Input | Transport>
}
interface Pending<TResponse, TError> {
  readonly finish: (result: Effect.Effect<TResponse, TError | Transport>) => void
  readonly acknowledge: () => void
  readonly quiesced: Promise<void>
}

const noop = (): void => {}
/** Acquire a scoped RPC client and terminate its endpoint on scope closure. */
export const makeRpcClient = Effect.fn('effect-rust.rpcClient')(function* <
  TRequest,
  TResponse,
  TError,
>(endpoint: MessageEndpoint, schemas: RpcSchemas<TRequest, TResponse, TError>) {
  const jobs = new Map<number, Pending<TResponse, TError>>()
  let nextId = 0
  let closed = false
  let failed: Transport | undefined
  let termination: Promise<void> | undefined
  const terminate = () => (termination ??= Promise.resolve().then(() => endpoint.close()))
  const failAll = (cause: unknown) => {
    failed = new Transport({ operation: 'receive', message: 'Interop transport failed', cause })
    const pending = Array.from(jobs.values())
    for (const job of pending) job.finish(Effect.fail(failed))
    jobs.clear()
    // Transport failure cannot acknowledge cancellation until the isolate is stopped.
    void terminate().then(
      () => {
        for (const job of pending) job.acknowledge()
      },
      () => {
        for (const job of pending) job.acknowledge()
      },
    )
  }
  let unsubscribe: () => void = noop
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      closed = true
      unsubscribe()
      try {
        await terminate()
      } finally {
        failAll(new Error('Interop transport scope closed'))
      }
    }),
  )
  unsubscribe = endpoint.subscribe((raw) => {
    const decoded = Schema.decodeUnknownExit(ResponseMessage, { onExcessProperty: 'error' })(raw)
    if (decoded._tag === 'Failure') {
      failAll(decoded.cause)
      return
    }
    const message = decoded.value
    const job = jobs.get(message.id)
    if (job === undefined) return
    jobs.delete(message.id)
    job.acknowledge()
    switch (message._tag) {
      case 'Cancelled':
        job.finish(Effect.die(new Error('Remote job cancelled without a local interruption')))
        break
      case 'Defect':
        job.finish(Effect.die(new Error(message.message)))
        break
      case 'Success':
        job.finish(
          Schema.decodeUnknownEffect(schemas.response)(message.payload).pipe(
            Effect.mapError(
              (cause) =>
                new Transport({
                  operation: 'response',
                  message: 'Invalid interop response',
                  cause,
                }),
            ),
          ),
        )
        break
      case 'Failure':
        job.finish(
          Schema.decodeUnknownEffect(schemas.error)(message.payload).pipe(
            Effect.mapError(
              (cause) =>
                new Transport({ operation: 'error', message: 'Invalid interop error', cause }),
            ),
            Effect.flatMap(Effect.fail),
          ),
        )
        break
    }
  }, failAll)
  const request = Effect.fn('effect-rust.rpc.request')(function* (value: TRequest) {
    const payload = yield* Schema.encodeUnknownEffect(schemas.request)(value).pipe(
      Effect.mapError(
        (cause) => new Input({ operation: 'request', message: 'Invalid interop request', cause }),
      ),
    )
    return yield* Effect.callback<TResponse, TError | Transport>((resume) => {
      if (closed === true || failed !== undefined) {
        resume(
          Effect.fail(
            failed ??
              new Transport({
                operation: 'request',
                message: 'Interop transport scope closed',
                cause: undefined,
              }),
          ),
        )
        return
      }
      const id = ++nextId
      let active = true
      let acknowledge: () => void = noop
      const quiesced = new Promise<void>((resolve) => {
        acknowledge = resolve
      })
      const job: Pending<TResponse, TError> = {
        finish: (result) => {
          if (active === true) {
            active = false
            resume(result)
          }
        },
        acknowledge,
        quiesced,
      }
      jobs.set(id, job)
      try {
        // eslint-disable-next-line unicorn/require-post-message-target-origin -- MessageEndpoint is a worker/process transport, not a Window.
        endpoint.postMessage({ _tag: 'Request', id, payload })
      } catch (cause) {
        jobs.delete(id)
        acknowledge()
        job.finish(
          Effect.fail(
            new Transport({ operation: 'send', message: 'Unable to send interop request', cause }),
          ),
        )
      }
      return Effect.promise(async () => {
        active = false
        if (jobs.has(id) === true) {
          try {
            // eslint-disable-next-line unicorn/require-post-message-target-origin -- MessageEndpoint is a worker/process transport, not a Window.
            endpoint.postMessage({ _tag: 'Cancel', id })
          } catch (cause) {
            failAll(cause)
          }
        }
        if (failed !== undefined) await terminate()
        // Remote acknowledgment is sent after Rust quiescence, not when Cancel arrives.
        await quiesced
      })
    })
  })
  const client: ProcessClient<TRequest, TResponse, TError> = { request }
  return client
})
