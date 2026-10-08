import { Deferred, Effect, Layer, Stream } from 'effect'
import { Headers } from 'effect/http'
import { Rpc, RpcMessage } from 'effect/rpc'

import type { InspectorGroup } from './inspector.ts'

/** Revision cursor shared by local and remote explorer clients. */
export interface ExplorerWatchCursor {
  readonly afterRevision?: number | undefined
  readonly descriptorRevision?: number | undefined
}
/** Transport-neutral frames remain unknown until the UI decoder validates them. */
export interface ExplorerClient {
  readonly getSnapshot: () => Promise<unknown>
  readonly watch: (cursor: ExplorerWatchCursor) => AsyncIterable<unknown>
  readonly clearHistory: () => Promise<unknown>
}

const unary = <TValue, TError>(result: TValue | Deferred.Deferred<TValue, TError>) =>
  Deferred.isDeferred<TValue, TError>(result) === true
    ? Deferred.await(result)
    : Effect.succeed(result)

/** Binds inspector handlers directly, without observing diagnostic RPC traffic. */
export const makeExplorerClient = Effect.fn('RpcExplorer.makeClient')(function* ({
  inspector,
}: {
  readonly inspector: InspectorGroup
}) {
  const context = yield* Layer.build(inspector.layer)
  const services = yield* Effect.context<never>()
  const closed = yield* Deferred.make<void>()
  let released = false
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      released = true
    }).pipe(Effect.andThen(Deferred.succeed(closed, undefined))),
  )
  const options = {
    client: new Rpc.ServerClient(0),
    requestId: RpcMessage.RequestId(0),
    headers: Headers.empty,
  }
  const snapshot = yield* inspector.group
    .accessHandler('RpcExplorer.GetSnapshot')
    .pipe(Effect.provide(context))
  const watch = yield* inspector.group
    .accessHandler('RpcExplorer.Watch')
    .pipe(Effect.provide(context))
  const clear = yield* inspector.group
    .accessHandler('RpcExplorer.ClearHistory')
    .pipe(Effect.provide(context))
  const client: ExplorerClient = {
    getSnapshot: () =>
      Effect.runPromiseWith(services)(
        Effect.suspend(() =>
          released === true
            ? Effect.die(new TypeError('Explorer client scope is closed'))
            : snapshot({}, options).pipe(Effect.flatMap(unary)),
        ),
      ),
    clearHistory: () =>
      Effect.runPromiseWith(services)(
        Effect.suspend(() =>
          released === true
            ? Effect.die(new TypeError('Explorer client scope is closed'))
            : clear({}, options).pipe(Effect.flatMap(unary)),
        ),
      ),
    watch: (cursor) => {
      if (released === true) return Stream.toAsyncIterable(Stream.empty)
      const result = watch(
        {
          ...(cursor.afterRevision === undefined ? {} : { afterRevision: cursor.afterRevision }),
          ...(cursor.descriptorRevision === undefined
            ? {}
            : { descriptorRevision: cursor.descriptorRevision }),
        },
        options,
      )
      const stream =
        Stream.isStream(result) === true
          ? result
          : Stream.unwrap(Effect.map(result, (queue) => Stream.fromQueue(queue)))
      return Stream.toAsyncIterableWith(
        stream.pipe(Stream.interruptWhen(Deferred.await(closed))),
        services,
      )
    },
  }
  return client
})
