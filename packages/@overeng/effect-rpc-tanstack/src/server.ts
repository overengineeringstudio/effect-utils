/**
 * Server-side utilities for Effect RPC with TanStack Start
 *
 * @since 0.1.0
 */

import { NodeHttpServer } from '@effect/platform-node'
import type * as HttpApp from '@effect/platform/HttpApp'
import type * as HttpRouter from '@effect/platform/HttpRouter'
import { Rpc, type RpcGroup, RpcSerialization, RpcServer } from '@effect/rpc'
import type * as Context from 'effect/Context'
import * as Layer from 'effect/Layer'

/** Web handler interface returned by makeHandler for use in TanStack Start API routes */
export type RpcWebHandler = {
  readonly handler: (
    request: Request,
    context?: Context.Context<never> | undefined,
  ) => Promise<Response>
  readonly dispose: () => Promise<void>
}

type HandlerLayer<TRpcs extends Rpc.Any, TError, TRuntime> = Layer.Layer<
  Rpc.ToHandler<TRpcs> | Rpc.Middleware<TRpcs>,
  TError,
  TRuntime
>

type HandlerBaseOptions<TRpcs extends Rpc.Any, TError> = {
  readonly group: RpcGroup.RpcGroup<TRpcs>
  readonly handlerLayer: HandlerLayer<TRpcs, TError, never>
  readonly routerLayer?: Layer.Layer<HttpRouter.HttpRouter.DefaultServices, never, never>
  readonly serializationLayer?: Layer.Layer<RpcSerialization.RpcSerialization, never, never>
  readonly disableTracing?: boolean | undefined
  readonly spanPrefix?: string | undefined
  readonly spanAttributes?: Record<string, unknown> | undefined
  readonly disableFatalDefects?: boolean | undefined
  readonly middleware?: (
    httpApp: HttpApp.Default,
  ) => HttpApp.Default<never, HttpRouter.HttpRouter.DefaultServices>
  readonly memoMap?: Layer.MemoMap
}

type HandlerOptions<TRpcs extends Rpc.Any, TError> = HandlerBaseOptions<TRpcs, TError>

type HandlerOptionsWithRuntime<TRpcs extends Rpc.Any, TRuntime, TError> = Omit<
  HandlerBaseOptions<TRpcs, TError>,
  'handlerLayer'
> & {
  readonly handlerLayer: HandlerLayer<TRpcs, TError, TRuntime>
  readonly runtimeLayer: Layer.Layer<TRuntime, never, never>
}

const buildHandlerLayer = <TRpcs extends Rpc.Any, TRuntime, TError>(
  options: HandlerOptions<TRpcs, TError> | HandlerOptionsWithRuntime<TRpcs, TRuntime, TError>,
): Layer.Layer<
  | Rpc.ToHandler<TRpcs>
  | Rpc.Middleware<TRpcs>
  | RpcSerialization.RpcSerialization
  | HttpRouter.HttpRouter.DefaultServices,
  TError,
  never
> => {
  const handlerLayer =
    'runtimeLayer' in options
      ? Layer.provide(options.handlerLayer, options.runtimeLayer)
      : options.handlerLayer

  const serializationLayer = options.serializationLayer ?? RpcSerialization.layerNdjson
  const routerLayer = options.routerLayer ?? NodeHttpServer.layerContext

  return Layer.mergeAll(handlerLayer, serializationLayer, routerLayer)
}

/**
 * Creates a web handler for TanStack Start API routes using Effect RPC's HTTP protocol.
 */
export const makeHandler: {
  <TRpcs extends Rpc.Any, TError>(options: HandlerOptions<TRpcs, TError>): RpcWebHandler
  <TRpcs extends Rpc.Any, TRuntime, TError>(
    options: HandlerOptionsWithRuntime<TRpcs, TRuntime, TError>,
  ): RpcWebHandler
} = <TRpcs extends Rpc.Any, TRuntime, TError>(
  options: HandlerOptions<TRpcs, TError> | HandlerOptionsWithRuntime<TRpcs, TRuntime, TError>,
): RpcWebHandler => {
  const layer = buildHandlerLayer(options)

  const handlerOptions = {
    layer,
    ...(options.disableTracing === undefined ? {} : { disableTracing: options.disableTracing }),
    ...(options.spanPrefix === undefined ? {} : { spanPrefix: options.spanPrefix }),
    ...(options.spanAttributes === undefined ? {} : { spanAttributes: options.spanAttributes }),
    ...(options.disableFatalDefects === undefined
      ? {}
      : { disableFatalDefects: options.disableFatalDefects }),
    ...(options.middleware === undefined ? {} : { middleware: options.middleware }),
    ...(options.memoMap === undefined ? {} : { memoMap: options.memoMap }),
  }

  return RpcServer.toWebHandler(options.group, handlerOptions)
}

/**
 * Creates a handler with a provided runtime for dependency injection.
 */
export const makeHandlerWithRuntime: <TRpcs extends Rpc.Any, TRuntime, TError>(options: {
  readonly group: RpcGroup.RpcGroup<TRpcs>
  readonly handlerLayer: HandlerLayer<TRpcs, TError, TRuntime>
  readonly runtimeLayer: Layer.Layer<TRuntime, never, never>
  readonly routerLayer?: Layer.Layer<HttpRouter.HttpRouter.DefaultServices, never, never>
  readonly serializationLayer?: Layer.Layer<RpcSerialization.RpcSerialization, never, never>
  readonly disableTracing?: boolean | undefined
  readonly spanPrefix?: string | undefined
  readonly spanAttributes?: Record<string, unknown> | undefined
  readonly disableFatalDefects?: boolean | undefined
  readonly middleware?: (
    httpApp: HttpApp.Default,
  ) => HttpApp.Default<never, HttpRouter.HttpRouter.DefaultServices>
  readonly memoMap?: Layer.MemoMap
}) => RpcWebHandler = (options) =>
  makeHandler({
    group: options.group,
    handlerLayer: options.handlerLayer,
    runtimeLayer: options.runtimeLayer,
    ...(options.routerLayer === undefined ? {} : { routerLayer: options.routerLayer }),
    ...(options.serializationLayer === undefined
      ? {}
      : { serializationLayer: options.serializationLayer }),
    ...(options.disableTracing === undefined ? {} : { disableTracing: options.disableTracing }),
    ...(options.spanPrefix === undefined ? {} : { spanPrefix: options.spanPrefix }),
    ...(options.spanAttributes === undefined ? {} : { spanAttributes: options.spanAttributes }),
    ...(options.disableFatalDefects === undefined
      ? {}
      : { disableFatalDefects: options.disableFatalDefects }),
    ...(options.middleware === undefined ? {} : { middleware: options.middleware }),
    ...(options.memoMap === undefined ? {} : { memoMap: options.memoMap }),
  })
