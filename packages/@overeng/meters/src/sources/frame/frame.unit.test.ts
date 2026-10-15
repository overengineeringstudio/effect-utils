import { describe, expect, it } from '@effect/vitest'
import { Effect, Exit, Scope } from 'effect'

import { makeSeries } from '../../series/index.ts'
import { testPlatform } from '../../session/_test-platform.ts'
import { makeMeters } from '../../session/index.ts'
import { frameSource, type FpsValue } from './index.ts'

describe('frame source entrypoint', () => {
  it.effect('reuses the shared scoped session clock and cancels on release', () =>
    Effect.gen(function* () {
      const host = testPlatform()
      const series = makeSeries<FpsValue>({ id: 'fps', label: 'FPS', unit: 'fps', capacity: 2400 })
      const meters = makeMeters({
        sources: [frameSource({ id: 'fps', series })],
        platform: host.platform,
      })
      expect(host.requests).toBe(0)
      const scope = yield* Scope.make()
      yield* Scope.provide(meters.start, scope)
      yield* Scope.provide(meters.clock.subscribe({ phase: 'Draw', listener: () => {} }), scope)
      host.tick(16)
      expect(meters.store.read({ series }).latest).toBeUndefined()
      host.tick(16)
      expect(host.peakPending).toBe(1)
      expect(meters.store.read({ series }).latest?._tag).toBe('Value')
      expect(meters.store.read({ series }).latest).toMatchObject({
        _tag: 'Value',
        value: { _tag: 'Fps', durationMs: 16, framesCaptured: 2 },
      })
      yield* Scope.close(scope, Exit.succeed(undefined))
      expect(host.pending).toBe(0)
      expect(host.observers).toBe(0)
    }),
  )

  it.effect('reports unavailable frame capabilities without scheduling work', () =>
    Effect.gen(function* () {
      const host = testPlatform()
      const series = makeSeries<FpsValue>({ id: 'fps', label: 'FPS', unit: 'fps', capacity: 2400 })
      const meters = makeMeters({
        sources: [frameSource({ id: 'fps', series })],
        platform: {
          ...host.platform,
          supportsFrames: () => false,
        },
      })
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* meters.start
          expect(meters.store.read({ series }).latest).toEqual({
            _tag: 'Unavailable',
            atMs: 0,
            reason: 'Unsupported',
          })
          expect(host.requests).toBe(0)
        }),
      )
    }),
  )
})
