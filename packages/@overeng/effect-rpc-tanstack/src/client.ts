/**
 * Client-side utilities for Effect RPC with TanStack Start
 *
 * @since 0.1.0
 */

import { FetchHttpClient } from '@effect/platform'
import type * as HttpClient from '@effect/platform/HttpClient'
import { RpcClient, RpcClientError, RpcSerialization } from '@effect/rpc'
import { Layer } from 'effect'

/**
 * Re-export RpcClientError for convenience
 */
export { RpcClientError }

/** Configuration options for creating an RPC client layer */
export type ClientLayerOptions = {
  readonly url: string
  readonly transformClient?: <TError, TRuntime>(
    client: HttpClient.HttpClient.With<TError, TRuntime>,
  ) => HttpClient.HttpClient.With<TError, TRuntime>
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient, never, never>
  readonly serializationLayer?: Layer.Layer<RpcSerialization.RpcSerialization, never, never>
}

/**
 * Creates an RpcClient.Protocol layer that uses the Effect HTTP RPC protocol.
 */
export const layerClient: (
  options: ClientLayerOptions,
) => Layer.Layer<RpcClient.Protocol, never, never> = (options) => {
  const serializationLayer = options.serializationLayer ?? RpcSerialization.layerNdjson
  const httpClientLayer = options.httpClientLayer ?? FetchHttpClient.layer

  const protocolOptions = {
    url: options.url,
    ...(options.transformClient ? { transformClient: options.transformClient } : {}),
  }

  return RpcClient.layerProtocolHttp(protocolOptions).pipe(
    Layer.provide(serializationLayer),
    Layer.provide(httpClientLayer),
  )
}
