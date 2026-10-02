import { describe, expect, it } from '@effect/vitest'
import { Deferred, Effect, Fiber, Schema } from 'effect'

import { makeRpcClient, type MessageEndpoint } from './rpc.ts'
import { serveWorker } from './worker.ts'

// An in-memory MessagePort transport, exercising the real protocol and Effect server.
const ports = () => {
  const left = new Set<(message: unknown) => void>()
  const right = new Set<(message: unknown) => void>()
  const endpoint = (
    incoming: Set<(message: unknown) => void>,
    outgoing: Set<(message: unknown) => void>,
  ): MessageEndpoint => ({
    postMessage: (message) => {
      for (const listener of outgoing) listener(message)
    },
    subscribe: (message) => {
      incoming.add(message)
      return () => {
        incoming.delete(message)
      }
    },
    close: () => {
      incoming.clear()
    },
  })
  return { client: endpoint(left, right), server: endpoint(right, left) }
}

describe('dedicated worker protocol', () => {
  it.effect('releases completed synchronous jobs before a request id is reused', () =>
    Effect.gen(function* () {
      const pair = ports()
      const received: unknown[] = []
      pair.client.subscribe(
        (message) => {
          received.push(message)
        },
        () => undefined,
      )
      yield* serveWorker(
        pair.server,
        { request: Schema.Int, response: Schema.Int, error: Schema.Never },
        Effect.succeed,
      )
      // eslint-disable-next-line unicorn/require-post-message-target-origin -- In-memory MessageEndpoint models a worker transport, not a Window.
      pair.client.postMessage({ _tag: 'Request', id: 1, payload: 12 })
      // eslint-disable-next-line unicorn/require-post-message-target-origin -- In-memory MessageEndpoint models a worker transport, not a Window.
      pair.client.postMessage({ _tag: 'Request', id: 1, payload: 34 })
      expect(received).toEqual([
        { _tag: 'Success', id: 1, payload: 12 },
        { _tag: 'Success', id: 1, payload: 34 },
      ])
    }),
  )

  it.effect('acknowledges cancellation only after the remote finalizer quiesces', () =>
    Effect.gen(function* () {
      const pair = ports()
      const started = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      let live = 0
      const schemas = { request: Schema.Int, response: Schema.Int, error: Schema.Never }
      yield* serveWorker(pair.server, schemas, () =>
        Effect.acquireRelease(
          Effect.sync(() => {
            live++
            Deferred.doneUnsafe(started, Effect.void)
          }),
          () =>
            Deferred.await(finish).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  live--
                }),
              ),
            ),
        ).pipe(Effect.andThen(Effect.never), Effect.scoped),
      )
      const client = yield* makeRpcClient(pair.client, schemas)
      const request = yield* client.request(12).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      let interrupted = false
      const cancellation = yield* Fiber.interrupt(request).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            interrupted = true
          }),
        ),
        Effect.forkChild({ startImmediately: true }),
      )
      yield* Effect.yieldNow
      expect(interrupted).toBe(false)
      expect(live).toBe(1)
      yield* Deferred.succeed(finish, undefined)
      yield* Fiber.join(cancellation)
      expect(interrupted).toBe(true)
      expect(live).toBe(0)
    }),
  )

  it.effect('invalid remote responses fail with Transport, not a domain error or defect', () =>
    Effect.gen(function* () {
      const pair = ports()
      pair.server.subscribe(
        // eslint-disable-next-line unicorn/require-post-message-target-origin -- In-memory MessageEndpoint models a worker transport, not a Window.
        () => pair.server.postMessage({ _tag: 'Success', id: 1, payload: 'not an integer' }),
        () => undefined,
      )
      const client = yield* makeRpcClient(pair.client, {
        request: Schema.Int,
        response: Schema.Int,
        error: Schema.Never,
      })
      const error = yield* client.request(12).pipe(Effect.flip)
      expect(error._tag).toBe('Transport')
      if (error._tag === 'Transport') expect(error.operation).toBe('response')
    }),
  )
})
