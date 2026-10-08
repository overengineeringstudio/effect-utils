import { describe, it } from '@effect/vitest'
import { Duration, Effect } from 'effect'
import { TestClock } from 'effect/testing'
import { expect } from 'vitest'

import type { RequestIdentity } from '@overeng/effect-rpc-observer'
import { makeMeters } from '@overeng/meters'

import { testPlatform } from './session/_test-platform.ts'
import { makeRpcSource } from './source.ts'

const identity = (value: number): RequestIdentity => ({
  observerSide: 'client',
  connectionId: '0',
  direction: 'clientToServer',
  requestId: { _tag: 'Number', value },
})
const timestamp = { monotonicNanos: '0', wallClockMillis: 0 }

describe('bounded RPC source', () => {
  it.effect('uses nearest-rank successful latency and excludes notifications', () =>
    Effect.gen(function* () {
      const rpc = yield* makeRpcSource({
        id: 'rpc',
        metrics: ['durationP95', 'requestsPerSecond'],
        windowMillis: 1000,
        maxCompletions: 32,
        historyCapacity: 32,
      })
      const meters = makeMeters({ sources: rpc.sources, platform: testPlatform().platform })
      yield* meters.start
      for (let id = 1; id <= 20; id++) {
        rpc.sink.onRequest({
          identity: identity(id),
          at: timestamp,
          tag: 'Echo',
          notification: false,
        })
        rpc.sink.onTerminal({
          identity: identity(id),
          at: timestamp,
          outcome: 'success',
          durationSeconds: id / 100,
        })
      }
      rpc.sink.onRequest({
        identity: identity(21),
        at: timestamp,
        tag: 'Notify',
        notification: true,
      })
      rpc.sink.onTerminal({
        identity: identity(21),
        at: timestamp,
        outcome: 'success',
        durationSeconds: 100,
      })
      expect(meters.store.read({ series: rpc.sources[0]!.series }).latest).toMatchObject({
        value: 0.19,
      })
      expect(meters.store.read({ series: rpc.sources[1]!.series }).latest).toMatchObject({
        value: 21,
      })
    }).pipe(Effect.scoped),
  )

  it.effect('reports truncated windows until exact coverage returns', () =>
    Effect.gen(function* () {
      const rpc = yield* makeRpcSource({
        id: 'rpc',
        metrics: ['requestsPerSecond', 'durationP95', 'inFlight'],
        windowMillis: 1000,
        maxCompletions: 1,
        historyCapacity: 16,
      })
      const host = testPlatform()
      const meters = makeMeters({ sources: rpc.sources, platform: host.platform })
      yield* meters.start
      for (let id = 1; id <= 2; id++) {
        rpc.sink.onRequest({
          identity: identity(id),
          at: timestamp,
          tag: 'Echo',
          notification: false,
        })
        rpc.sink.onTerminal({
          identity: identity(id),
          at: timestamp,
          outcome: 'success',
          durationSeconds: 0.1,
        })
      }
      expect(meters.store.read({ series: rpc.sources[0]!.series }).latest).toMatchObject({
        _tag: 'Unavailable',
        reason: 'HistoryLost',
      })
      expect(meters.store.read({ series: rpc.sources[1]!.series }).latest).toMatchObject({
        _tag: 'Unavailable',
        reason: 'HistoryLost',
      })
      expect(meters.store.read({ series: rpc.sources[2]!.series }).latest).toMatchObject({
        value: 0,
      })
      host.advance(1001)
      yield* TestClock.adjust(Duration.millis(1001))
      expect(meters.store.read({ series: rpc.sources[0]!.series }).latest).toMatchObject({
        _tag: 'Value',
        value: 0,
      })
      expect(meters.store.read({ series: rpc.sources[1]!.series }).latest).toMatchObject({
        _tag: 'Unavailable',
        reason: 'NoSamples',
      })
    }).pipe(Effect.scoped),
  )

  it.effect('an empty selection installs no meter registrations', () =>
    Effect.gen(function* () {
      const rpc = yield* makeRpcSource({
        id: 'rpc',
        metrics: [],
        windowMillis: 1000,
        maxCompletions: 1,
        historyCapacity: 1,
      })
      expect(rpc.sources).toEqual([])
    }).pipe(Effect.scoped),
  )
})
