import { Cause, Context, Effect, Fiber, Layer, Option, Schema } from 'effect'

import { Init } from './errors.ts'
import { makeRpcClient, RequestMessage, type MessageEndpoint, type ProcessClient, type RpcSchemas } from './rpc.ts'

export type { MessageEndpoint } from './rpc.ts'

export interface WorkerLayerOptions<TRequest, TResponse, TError, TService> extends RpcSchemas<TRequest, TResponse, TError> {
  /** Must create a dedicated Worker; each Layer acquisition owns and terminates it. */
  readonly load: () => MessageEndpoint | PromiseLike<MessageEndpoint>
  readonly make: (client: ProcessClient<TRequest, TResponse, TError>) => TService
}
const worker = <TId, TService, TRequest, TResponse, TError>(runtimeName: string, Service: Context.Key<TId, TService>, options: WorkerLayerOptions<TRequest, TResponse, TError, TService>): Layer.Layer<TId, Init> =>
  Layer.effect(Service, Effect.gen(function* () {
    const endpoint = yield* Effect.tryPromise({ try: async () => options.load(), catch: (cause) => new Init({ runtime: runtimeName, message: 'Unable to start dedicated worker', cause }) })
    const client = yield* makeRpcClient(endpoint, options)
    return yield* Effect.try({ try: () => options.make(client), catch: (cause) => new Init({ runtime: runtimeName, message: 'Unable to construct worker service', cause }) })
  }).pipe(Effect.uninterruptible))

export const workerLayer = {
  browser: <TId, TService, TRequest, TResponse, TError>(Service: Context.Key<TId, TService>, options: WorkerLayerOptions<TRequest, TResponse, TError, TService>) => worker('worker.browser', Service, options),
  node: <TId, TService, TRequest, TResponse, TError>(Service: Context.Key<TId, TService>, options: WorkerLayerOptions<TRequest, TResponse, TError, TService>) => worker('worker.node', Service, options),
} as const

/** DOM Worker adapter; no runtime imports enter browser bundles. */
export const browserWorkerEndpoint = (worker: Worker): MessageEndpoint => ({
  postMessage: (message) => worker.postMessage(message),
  subscribe: (message, failure) => {
    const onMessage = (event: MessageEvent<unknown>) => { message(event.data) }
    const onError = (event: ErrorEvent) => { failure(event.error ?? event.message) }
    const onMessageError = (event: MessageEvent<unknown>) => { failure(event.data) }
    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onError)
    worker.addEventListener('messageerror', onMessageError)
    return () => { worker.removeEventListener('message', onMessage); worker.removeEventListener('error', onError); worker.removeEventListener('messageerror', onMessageError) }
  },
  close: () => worker.terminate(),
})
export interface NodeWorker {
  readonly postMessage: (message: unknown) => void
  readonly on: (event: 'message' | 'error' | 'messageerror' | 'exit', listener: (value: unknown) => void) => unknown
  readonly off: (event: 'message' | 'error' | 'messageerror' | 'exit', listener: (value: unknown) => void) => unknown
  readonly terminate: () => Promise<number>
}
export const nodeWorkerEndpoint = (worker: NodeWorker): MessageEndpoint => ({
  postMessage: (message) => worker.postMessage(message),
  subscribe: (message, failure) => {
    const onExit = (code: unknown) => { failure(new Error(`Interop worker exited (${String(code)})`)) }
    worker.on('message', message); worker.on('error', failure); worker.on('messageerror', failure); worker.on('exit', onExit)
    return () => { worker.off('message', message); worker.off('error', failure); worker.off('messageerror', failure); worker.off('exit', onExit) }
  },
  close: async () => { await worker.terminate() },
})

/** Install inside a dedicated Worker. Cancel acknowledgment follows all Rust/Effect finalizers. */
export const serveWorker = Effect.fn('effect-rust.serveWorker')(function* <TRequest, TResponse, TError, TServices>(
  endpoint: MessageEndpoint,
  schemas: RpcSchemas<TRequest, TResponse, TError>,
  handle: (request: TRequest) => Effect.Effect<TResponse, TError, TServices>,
) {
  const context = yield* Effect.context<TServices>()
  const fork = Effect.runForkWith(context)
  const jobs = new Map<number, Fiber.Fiber<void>>()
  const cancel = Effect.fn('effect-rust.worker.cancel')(function* (id: number) {
    const job = jobs.get(id)
    if (job !== undefined) yield* Fiber.interrupt(job)
    jobs.delete(id)
    endpoint.postMessage({ _tag: 'Cancelled', id })
  })
  const unsubscribe = endpoint.subscribe((raw) => {
    const decoded = Schema.decodeUnknownExit(RequestMessage, { onExcessProperty: 'error' })(raw)
    if (decoded._tag === 'Failure') return
    const message = decoded.value
    if (message._tag === 'Cancel') { fork(cancel(message.id)); return }
    if (jobs.has(message.id)) { endpoint.postMessage({ _tag: 'Defect', id: message.id, message: 'Duplicate request id' }); return }
    const task = Effect.gen(function* () {
      const result = yield* Effect.exit(Schema.decodeUnknownEffect(schemas.request)(message.payload).pipe(Effect.orDie, Effect.flatMap(handle)))
      if (result._tag === 'Success') {
        const payload = yield* Schema.encodeUnknownEffect(schemas.response)(result.value).pipe(Effect.orDie)
        endpoint.postMessage({ _tag: 'Success', id: message.id, payload })
      } else if (!Cause.hasInterruptsOnly(result.cause)) {
        const error = Cause.findErrorOption(result.cause)
        if (Option.isSome(error) && !Cause.hasDies(result.cause)) {
          const payload = yield* Schema.encodeUnknownEffect(schemas.error)(error.value).pipe(Effect.orDie)
          endpoint.postMessage({ _tag: 'Failure', id: message.id, payload })
        } else endpoint.postMessage({ _tag: 'Defect', id: message.id, message: String(Cause.squash(result.cause)) })
      }
    }).pipe(
      Effect.catchCause((cause) => Effect.sync(() => {
        if (!Cause.hasInterruptsOnly(cause)) endpoint.postMessage({ _tag: 'Defect', id: message.id, message: String(Cause.squash(cause)) })
      })),
    )
    const fiber = fork(task)
    jobs.set(message.id, fiber)
    // runFork can complete synchronously; observe after registration to avoid retained jobs.
    fiber.addObserver(() => { jobs.delete(message.id) })
  }, () => { for (const fiber of jobs.values()) fork(Fiber.interrupt(fiber).pipe(Effect.asVoid)) })
  yield* Effect.addFinalizer(() => Effect.gen(function* () {
    unsubscribe()
    yield* Effect.forEach(jobs.values(), Fiber.interrupt, { discard: true })
    jobs.clear()
    yield* Effect.promise(async () => { await endpoint.close() })
  }))
})
