/**
 * Client-side utilities for Effect RPC with TanStack Start
 *
 * @since 0.1.0
 */

import { FetchHttpClient } from '@effect/platform'
import type * as HttpClient from '@effect/platform/HttpClient'
import { RpcClient, RpcSerialization } from '@effect/rpc'
import { Layer } from 'effect'

type FetchLike = typeof globalThis.fetch

/** Configuration options for creating an RPC client layer */
export type ClientLayerOptions = {
  readonly url: string
  readonly transformClient?: <TError, TRuntime>(
    client: HttpClient.HttpClient.With<TError, TRuntime>,
  ) => HttpClient.HttpClient.With<TError, TRuntime>
  /**
   * Custom fetch implementation used when `httpClientLayer` is not provided.
   * Useful for SSR transports that need to route requests in-process.
   */
  readonly fetch?: FetchLike
  /**
   * Default fetch options used when `httpClientLayer` is not provided.
   */
  readonly requestInit?: globalThis.RequestInit
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient, never, never>
  readonly serializationLayer?: Layer.Layer<RpcSerialization.RpcSerialization, never, never>
}

/**
 * Adapts a web `Request -> Response` handler to a fetch-compatible function.
 */
export const fetchFromWebHandler = (
  handler: (request: Request) => Promise<Response>,
): FetchLike => {
  const fetch = (...args: [input: URL | RequestInfo, init?: RequestInit]): Promise<Response> => {
    const [input, init] = args
    return handler(
      input instanceof Request && init === undefined ? input : new Request(input, init),
    )
  }

  return fetch as FetchLike
}

/**
 * Creates an RpcClient.Protocol layer that uses the Effect HTTP RPC protocol.
 */
export const layerClient: (
  options: ClientLayerOptions,
) => Layer.Layer<RpcClient.Protocol, never, never> = (options) => {
  const serializationLayer = options.serializationLayer ?? RpcSerialization.layerNdjson
  const httpClientLayer =
    options.httpClientLayer ??
    FetchHttpClient.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          options.fetch !== undefined
            ? Layer.succeed(FetchHttpClient.Fetch, options.fetch)
            : Layer.empty,
          options.requestInit !== undefined
            ? Layer.succeed(FetchHttpClient.RequestInit, options.requestInit)
            : Layer.empty,
        ),
      ),
    )

  const protocolOptions = {
    url: options.url,
    ...(options.transformClient !== undefined ? { transformClient: options.transformClient } : {}),
  }

  return RpcClient.layerProtocolHttp(protocolOptions).pipe(
    Layer.provide(serializationLayer),
    Layer.provide(httpClientLayer),
  )
}
