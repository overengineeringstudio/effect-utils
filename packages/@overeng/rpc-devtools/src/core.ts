import { Effect } from 'effect'
import type { RpcClient, RpcGroup, RpcServer, RpcMiddleware } from 'effect/rpc'

import { makeExplorer, makeExplorerClient } from '@overeng/effect-rpc-explorer'
import type {
  ExplorerConfig,
  ExplorerEncodedDecodersByTag,
  ExplorerServices,
  ExplorerClient,
} from '@overeng/effect-rpc-explorer'
import {
  decorateClientProtocol,
  decorateServerProtocol,
  makeProtocolObserver,
  makeServerObserverMiddleware,
} from '@overeng/effect-rpc-observer'
import type { ObserverSide, ProtocolObserver } from '@overeng/effect-rpc-observer'
import type { Source } from '@overeng/meters'

import { makeRpcSource } from './source.ts'
import type { RpcMetersConfig } from './source.ts'
export { makeRpcSource } from './source.ts'
export type { RpcMetric, RpcMetersConfig, RpcSource } from './source.ts'

/** One scoped observer composition and its host-owned meter registrations. */
export interface RpcDevtools {
  readonly explorer: ExplorerServices
  readonly observer: ProtocolObserver
  readonly client: ExplorerClient
  readonly sources: readonly Source<number>[]
  readonly decorateClientProtocol: (
    protocol: RpcClient.Protocol['Service'],
  ) => RpcClient.Protocol['Service']
  readonly decorateServerProtocol: (options: {
    readonly protocol: RpcServer.Protocol['Service']
    readonly requestObservation?: 'protocol' | 'middleware'
  }) => RpcServer.Protocol['Service']
  readonly middleware: RpcMiddleware.RpcMiddleware<never, never, never>
}

/** Acquires one observer feeding both explorer capture and metadata-only meters. */
export const makeRpcDevtools = Effect.fn('RpcDevtools.make')(function* (options: {
  readonly group: RpcGroup.Any
  readonly config: ExplorerConfig
  readonly side: ObserverSide
  readonly encodedDecodersByTag?: ExplorerEncodedDecodersByTag
  readonly meters: RpcMetersConfig
}) {
  const explorer = yield* makeExplorer({ group: options.group, config: options.config })
  const rpc = yield* makeRpcSource(options.meters)
  const observer = yield* makeProtocolObserver({
    side: options.side,
    capacity: options.config.bounds.active.maxCount,
    sinks: [
      {
        capture: true,
        sink: explorer.makeCaptureSink({
          side: options.side,
          encodedDecodersByTag: options.encodedDecodersByTag,
        }),
      },
      { capture: false, sink: rpc.sink },
    ],
  })
  const client = yield* makeExplorerClient({ inspector: explorer.inspector })
  return {
    explorer,
    observer,
    client,
    sources: rpc.sources,
    decorateClientProtocol: (protocol: RpcClient.Protocol['Service']) => {
      if (options.side !== 'client')
        throw new TypeError('Client decoration requires client-side RPC devtools')
      return decorateClientProtocol({ protocol, observer })
    },
    decorateServerProtocol: (input: {
      readonly protocol: RpcServer.Protocol['Service']
      readonly requestObservation?: 'protocol' | 'middleware'
    }) => {
      if (options.side !== 'server')
        throw new TypeError('Server decoration requires server-side RPC devtools')
      return decorateServerProtocol({ ...input, observer })
    },
    get middleware() {
      if (options.side !== 'server')
        throw new TypeError('RPC observer middleware requires server-side devtools')
      return makeServerObserverMiddleware({ observer })
    },
  } satisfies RpcDevtools
})
