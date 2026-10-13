import { type Context, Effect, Layer, Queue, Stream } from 'effect'
import type { ChildProcess, ChildProcessSpawner } from 'effect/process'

import { canonicalJson, parseJson } from '../schema/json.ts'
import { Init } from './errors.ts'
import { makeRpcClient, type MessageEndpoint, type ProcessClient, type RpcSchemas } from './rpc.ts'

export type { ProcessClient } from './rpc.ts'

/** Process command and codecs used to construct a scoped service client. */
export interface ProcessLayerOptions<TRequest, TResponse, TError, TService> extends RpcSchemas<
  TRequest,
  TResponse,
  TError
> {
  readonly command: ChildProcess.Command
  readonly make: (client: ProcessClient<TRequest, TResponse, TError>) => TService
}

const process = <TId, TService, TRequest, TResponse, TError>({
  runtimeName,
  Service,
  options,
}: {
  readonly runtimeName: string
  readonly Service: Context.Key<TId, TService>
  readonly options: ProcessLayerOptions<TRequest, TResponse, TError, TService>
}): Layer.Layer<TId, Init, ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const child = yield* options.command.pipe(
        Effect.mapError(
          (cause) =>
            new Init({ runtime: runtimeName, message: 'Unable to start interop process', cause }),
        ),
      )
      const outgoing = yield* Queue.bounded<Uint8Array>(128)
      const runPromise = Effect.runPromiseWith(
        yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>(),
      )
      const messages = new Set<(message: unknown) => void>()
      const failures = new Set<(cause: unknown) => void>()
      const report = (cause: unknown) =>
        Effect.sync(() => {
          for (const failure of failures) failure(cause)
        })
      const endpoint: MessageEndpoint = {
        postMessage: (message) => {
          const line = canonicalJson(message)
          if (Queue.offerUnsafe(outgoing, new TextEncoder().encode(`${line}\n`)) === false)
            throw new Error('Interop process write queue is full or closed')
        },
        // eslint-disable-next-line overeng/named-args -- MessageEndpoint.subscribe preserves the public positional message/failure callbacks.
        subscribe: (message, failure) => {
          messages.add(message)
          failures.add(failure)
          return () => {
            messages.delete(message)
            failures.delete(failure)
          }
        },
        close: async () => {
          Queue.shutdownUnsafe(outgoing)
          await runPromise(child.kill({ killSignal: 'SIGKILL' }).pipe(Effect.ignore))
          await runPromise(child.exitCode.pipe(Effect.ignore))
        },
      }
      const client = yield* makeRpcClient(endpoint, options)
      yield* Stream.run(Stream.fromQueue(outgoing), child.stdin).pipe(
        Effect.catchCause(report),
        Effect.forkScoped,
      )
      yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) =>
          Effect.sync(() => {
            const message = parseJson(line)
            for (const listener of messages) listener(message)
          }),
        ),
        Effect.catchCause(report),
        Effect.andThen(report(new Error('Interop process stdout closed'))),
        Effect.forkScoped,
      )
      yield* Stream.runDrain(child.stderr).pipe(Effect.catchCause(report), Effect.forkScoped)
      return yield* Effect.try({
        try: () => options.make(client),
        catch: (cause) =>
          new Init({ runtime: runtimeName, message: 'Unable to construct process service', cause }),
      })
    }),
  )

/** Supply the runtime's explicit ChildProcessSpawner layer (NodeServices/BunServices). */
export const processLayer = {
  // eslint-disable-next-line overeng/named-args -- Public processLayer.node preserves the SDK's (Service, options) signature.
  node: <TId, TService, TRequest, TResponse, TError>(
    Service: Context.Key<TId, TService>,
    options: ProcessLayerOptions<TRequest, TResponse, TError, TService>,
  ) => process({ runtimeName: 'process.node', Service, options }),
  // eslint-disable-next-line overeng/named-args -- Public processLayer.bun preserves the SDK's (Service, options) signature.
  bun: <TId, TService, TRequest, TResponse, TError>(
    Service: Context.Key<TId, TService>,
    options: ProcessLayerOptions<TRequest, TResponse, TError, TService>,
  ) => process({ runtimeName: 'process.bun', Service, options }),
} as const
