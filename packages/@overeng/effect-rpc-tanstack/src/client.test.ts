import { Rpc, RpcGroup, RpcClient } from '@effect/rpc'
import { Chunk, Effect, Schema, Stream } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import { layerClient, fetchFromWebHandler } from './client.ts'
import { makeHandler } from './server.ts'

describe('effect-rpc-tanstack client', () => {
  it('supports a custom fetch transport', async () => {
    const GetGreeting = Rpc.make('GetGreeting', {
      payload: {},
      success: Schema.String,
      error: Schema.Never,
    })

    const Api = RpcGroup.make(GetGreeting)
    const handlers = Api.toLayer(
      Effect.succeed(
        Api.of({
          GetGreeting: () => Effect.succeed('hello'),
        }),
      ),
    )

    const { handler, dispose } = makeHandler({
      group: Api,
      handlerLayer: handlers,
    })

    const fetch = vi.fn(fetchFromWebHandler(handler))

    try {
      const greeting = await Effect.gen(function* () {
        const client = yield* RpcClient.make(Api)
        return yield* client.GetGreeting({})
      }).pipe(
        Effect.provide(
          layerClient({
            url: 'http://localhost/api/rpc',
            fetch,
            requestInit: { credentials: 'include' },
          }),
        ),
        Effect.scoped,
        Effect.runPromise,
      )

      expect(greeting).toBe('hello')
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(fetch.mock.calls[0]?.[1]?.credentials).toBe('include')
    } finally {
      await dispose()
    }
  })

  it('streams responses through a custom fetch transport', async () => {
    const StreamNumbers = Rpc.make('StreamNumbers', {
      payload: {},
      success: Schema.Number,
      stream: true,
    })

    const Api = RpcGroup.make(StreamNumbers)
    const handlers = Api.toLayer(
      Effect.succeed(
        Api.of({
          StreamNumbers: () => Stream.make(1, 2, 3),
        }),
      ),
    )

    const { handler, dispose } = makeHandler({
      group: Api,
      handlerLayer: handlers,
    })

    try {
      const numbers = await Effect.gen(function* () {
        const client = yield* RpcClient.make(Api)
        return yield* client.StreamNumbers({}).pipe(Stream.runCollect)
      }).pipe(
        Effect.provide(
          layerClient({
            url: 'http://localhost/api/rpc',
            fetch: fetchFromWebHandler(handler),
          }),
        ),
        Effect.scoped,
        Effect.runPromise,
      )

      expect(Chunk.toReadonlyArray(numbers)).toEqual([1, 2, 3])
    } finally {
      await dispose()
    }
  })
})
