import { describe, it } from '@effect/vitest'
import { Duration, Effect, Schema } from 'effect'
import { Rpc, RpcGroup, RpcSerialization } from 'effect/rpc'
import type { RpcClient, RpcMessage } from 'effect/rpc'
import { TestClock } from 'effect/testing'
import { expect } from 'vitest'

import { defaultNormalizationBounds } from '@overeng/effect-rpc-explorer'
import type { RequestIdentity } from '@overeng/effect-rpc-observer'
import { makeMeters } from '@overeng/meters'

import { makeRpcDevtools, makeRpcSource } from './core.ts'
import { testPlatform } from './session/_test-platform.ts'

const config = {
  id: 'rpc',
  metrics: ['inFlight', 'durationP95', 'errorsPerSecond'] as const,
  windowMillis: 1000,
  maxCompletions: 16,
  historyCapacity: 16,
}
const identity = (value: number): RequestIdentity => ({
  observerSide: 'client',
  connectionId: '0',
  direction: 'clientToServer',
  requestId: { _tag: 'Number', value },
})
const at = (millis: number) => ({ monotonicNanos: String(millis * 1e6), wallClockMillis: millis })

describe('RPC devtools', () => {
  it.effect('balances in-flight and excludes cancellation from errors and successful latency', () =>
    Effect.gen(function* () {
      const rpc = yield* makeRpcSource(config)
      const host = testPlatform()
      const meters = makeMeters({ sources: rpc.sources, platform: host.platform })
      yield* meters.start
      const latest = (index: number) =>
        meters.store.read({ series: rpc.sources[index]!.series }).latest
      expect(latest(1)).toMatchObject({ _tag: 'Unavailable', reason: 'NoSamples' })
      for (let id = 1; id <= 3; id++)
        rpc.sink.onRequest({ identity: identity(id), at: at(0), tag: 'Echo', notification: false })
      expect(latest(0)).toMatchObject({ _tag: 'Value', value: 3 })
      yield* TestClock.adjust(Duration.millis(100))
      host.advance(100)
      rpc.sink.onTerminal({
        identity: identity(1),
        at: at(100),
        outcome: 'success',
        durationSeconds: 0.1,
      })
      rpc.sink.onTerminal({
        identity: identity(2),
        at: at(100),
        outcome: 'typedFailure',
        durationSeconds: 0.1,
      })
      rpc.sink.onTerminal({
        identity: identity(3),
        at: at(100),
        outcome: 'interrupted',
        durationSeconds: 0.1,
      })
      rpc.sink.onTerminal({
        identity: identity(2),
        at: at(100),
        outcome: 'typedFailure',
        durationSeconds: 0.1,
      })
      expect(latest(0)).toMatchObject({ _tag: 'Value', value: 0 })
      expect(latest(1)).toMatchObject({ _tag: 'Value', value: 0.1 })
      expect(latest(2)).toMatchObject({ _tag: 'Value', value: 1 })
      host.advance(1001)
      yield* TestClock.adjust(Duration.millis(1001))
      expect(latest(1)).toMatchObject({ _tag: 'Unavailable', reason: 'NoSamples' })
      expect(latest(2)).toMatchObject({ _tag: 'Value', value: 0 })
    }).pipe(Effect.scoped),
  )

  it.effect('fans one decoration out to meters and explorer', () =>
    Effect.gen(function* () {
      const tools = yield* makeRpcDevtools({
        side: 'client',
        group: RpcGroup.make(Rpc.make('Echo', { payload: Schema.String, success: Schema.String })),
        meters: config,
        config: {
          instanceId: 'test',
          telemetry: {
            registerRetainedGauge: () => () => {},
            registerNormalizationHistogram: () => () => {},
          },
          bounds: {
            active: { maxCount: 16, maxAge: Duration.seconds(10) },
            completed: { maxCount: 16, maxAge: Duration.seconds(10) },
            deltas: { maxCount: 16, maxAge: Duration.seconds(10) },
            streamValuesPerRecord: 16,
            subscriberQueue: 16,
            normalized: defaultNormalizationBounds,
          },
        },
      })
      const host = testPlatform()
      const meters = makeMeters({ sources: tools.sources, platform: host.platform })
      yield* meters.start
      let receive: (message: RpcMessage.FromServerEncoded) => Effect.Effect<void> = () =>
        Effect.void
      let sends = 0
      const raw: RpcClient.Protocol['Service'] = {
        // oxlint-disable-next-line overeng/named-args -- Effect protocol callback signature.
        run: (_id, callback) =>
          Effect.sync(() => {
            receive = callback
          }).pipe(Effect.andThen(Effect.never)),
        send: () =>
          Effect.sync(() => {
            sends++
          }),
        supportsAck: true,
        supportsTransferables: true,
        codecFor: RpcSerialization.json.codecFor,
      }
      const protocol = tools.decorateClientProtocol(raw)
      yield* protocol.run(0, () => Effect.void).pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      yield* protocol.send(0, {
        _tag: 'Request',
        id: 1,
        tag: 'Echo',
        payload: 'hello',
        headers: [],
      })
      expect(meters.store.read({ series: tools.sources[0]!.series }).latest).toMatchObject({
        value: 1,
      })
      yield* receive({ _tag: 'Exit', requestId: 1, exit: { _tag: 'Success', value: 'reply' } })
      expect(sends).toBe(1)
      expect(meters.store.read({ series: tools.sources[0]!.series }).latest).toMatchObject({
        value: 0,
      })
      const snapshot = yield* Effect.promise(() => tools.client.getSnapshot())
      expect(snapshot).toMatchObject({ completed: [{ state: 'succeeded' }] })
    }).pipe(Effect.scoped),
  )

  it.effect('imports and factory descriptions acquire nothing', () =>
    Effect.gen(function* () {
      const host = testPlatform()
      const module = yield* Effect.promise(() => import('./core.ts'))
      const description = module.makeRpcSource(config)
      expect(Effect.isEffect(description)).toBe(true)
      expect(host.requests).toBe(0)
      expect(host.observers).toBe(0)
    }),
  )
})
