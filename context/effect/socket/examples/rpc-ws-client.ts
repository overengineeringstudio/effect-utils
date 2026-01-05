import { NodeRuntime } from '@effect/platform-node'
import { layerWebSocket, layerWebSocketConstructorGlobal } from '@effect/platform/Socket'
import { layerProtocolSocket, make as makeRpcClient } from '@effect/rpc/RpcClient'
import { layerJson } from '@effect/rpc/RpcSerialization'
import { Effect, Layer } from 'effect'

import { Api } from './rpc-schema.ts'

/**
 * Example: Effect RPC client over WebSocket.
 *
 * Demonstrates:
 * - typed RPC client generated from `RpcGroup`
 * - websocket protocol via `RpcClient.layerProtocolSocket`
 * - schema-driven request/response
 */
const url = 'ws://127.0.0.1:8794/rpc'

const webSocketLayer = layerWebSocket(url).pipe(Layer.provide(layerWebSocketConstructorGlobal))

const rpcProtocolLayer = layerProtocolSocket().pipe(
  Layer.provide(Layer.mergeAll(webSocketLayer, layerJson)),
)

const program = Effect.scoped(
  Effect.gen(function* () {
    const client = yield* makeRpcClient(Api)

    const pong = yield* client.ping({ message: 'hello' })
    yield* Effect.log(pong)

    const sum = yield* client.math.add({ a: 2, b: 3 })
    yield* Effect.log(`sum ${sum}`)
  }).pipe(Effect.withSpan('rpc.ws.client')),
).pipe(Effect.provide(rpcProtocolLayer))

/**
 * Expected logs (example):
 * - { reply: "pong:hello" }
 * - sum 5
 */
NodeRuntime.runMain(program)
