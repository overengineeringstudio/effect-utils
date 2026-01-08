import { make as makeRpc } from '@effect/rpc/Rpc'
import { make as makeRpcGroup } from '@effect/rpc/RpcGroup'
import { Schema } from 'effect'

/**
 * Example: shared RPC schema for WS client + server.
 *
 * Demonstrates:
 * - defining typed RPC payloads with `Schema`
 * - grouping procedures with `RpcGroup`
 *
 * Expected logs (example):
 * - (none, this file is shared schema only)
 */
export const Ping = makeRpc('ping', {
  payload: Schema.Struct({ message: Schema.String }),
  success: Schema.Struct({ reply: Schema.String }),
})

/** RPC procedure for adding two numbers */
export const Add = makeRpc('math.add', {
  payload: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
  success: Schema.Number,
})

/** RPC group containing all API procedures (Ping, Add) */
export const Api = makeRpcGroup(Ping, Add)
