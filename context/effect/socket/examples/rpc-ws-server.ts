import { NodeRuntime } from '@effect/platform-node'
import { layerWebSocket } from '@effect/platform-node/NodeSocketServer'
import { layerJson } from '@effect/rpc/RpcSerialization'
import { layer, layerProtocolSocketServer } from '@effect/rpc/RpcServer'
import { Effect, Layer } from 'effect'
import { Api } from './rpc-schema.ts'

/**
 * Example: Effect RPC server over WebSocket.
 *
 * Demonstrates:
 * - defining RPC procedures with schemas
 * - binding handlers with `RpcGroup`
 * - websocket protocol via `RpcServer.layerProtocolSocketServer`
 */
const port = 8794

const pingHandler = Effect.fn('rpc.ping')((payload: { message: string }) =>
  Effect.succeed({ reply: `pong:${payload.message}` }),
)

const addHandler = Effect.fn('rpc.math.add')((payload: { a: number; b: number }) =>
  Effect.succeed(payload.a + payload.b),
)

const protocolLayer = layerProtocolSocketServer.pipe(
  Layer.provide(
    Layer.mergeAll(layerJson, layerWebSocket({ port, host: '127.0.0.1', path: '/rpc' })),
  ),
)

const program = layer(Api).pipe(
  Layer.provide(
    Layer.mergeAll(
      Api.toLayer({
        ping: pingHandler,
        'math.add': addHandler,
      }),
      protocolLayer,
    ),
  ),
  Layer.launch,
)

/**
 * Expected logs (example):
 * - (no logs until requests are made)
 */
NodeRuntime.runMain(program)
