import { describe, expect, it } from '@effect/vitest'
import { Effect, Exit, Scope } from 'effect'

import { makeSeries, type Sample, type StatusValue } from '../../series/index.ts'
import { testPlatform } from '../../session/_test-platform.ts'
import { makeMeters } from '../../session/index.ts'
import { statusSource } from './index.ts'

describe('host status without transport', () => {
  it.effect(
    'only subscribes to host events and does not infer sync completion from connection',
    () =>
      Effect.gen(function* () {
        const host = testPlatform()
        const series = makeSeries<StatusValue>({
          id: 'status',
          label: 'Sync',
          unit: 'status',
          capacity: 10,
        })
        let emit: ((sample: Sample<StatusValue>) => void) | undefined
        let hooks = 0
        const source = statusSource({
          id: 'status',
          series,
          subscribe: ({ emit: listener }) =>
            Effect.acquireRelease(
              Effect.sync(() => {
                emit = listener
                hooks++
              }),
              () =>
                Effect.sync(() => {
                  emit = undefined
                  hooks--
                }),
            ).pipe(Effect.asVoid),
        })
        const meters = makeMeters({ platform: host.platform, sources: [source] })
        expect(hooks).toBe(0)
        const scope = yield* Scope.make()
        yield* Scope.provide(meters.start, scope)
        expect(hooks).toBe(1)
        expect(host.requests).toBe(0)
        host.advance(10)
        emit?.({
          _tag: 'Value',
          atMs: -100,
          value: { _tag: 'Status', state: 'Connected', label: 'Connected' },
        })
        expect(meters.store.read({ series }).latest).toEqual({
          _tag: 'Value',
          atMs: 10,
          value: { _tag: 'Status', state: 'Connected', label: 'Connected' },
        })
        host.advance(10)
        emit?.({
          _tag: 'Value',
          atMs: 1000,
          value: { _tag: 'Status', state: 'Synced', label: 'Synced' },
        })
        expect(meters.store.read({ series }).latest).toEqual({
          _tag: 'Value',
          atMs: 20,
          value: { _tag: 'Status', state: 'Synced', label: 'Synced' },
        })
        const stale = emit
        yield* Scope.close(scope, Exit.succeed(undefined))
        expect(hooks).toBe(0)
        const revision = meters.store.getRevision()
        stale?.({
          _tag: 'Value',
          atMs: 0,
          value: { _tag: 'Status', state: 'Error', label: 'Error' },
        })
        expect(meters.store.getRevision()).toBe(revision)
        expect(host.observers).toBe(0)
      }),
  )
  it.effect('reports not configured without installing any host adapter', () =>
    Effect.gen(function* () {
      const host = testPlatform()
      const series = makeSeries<StatusValue>({
        id: 'status',
        label: 'Sync',
        unit: 'status',
        capacity: 1,
      })
      const meters = makeMeters({
        platform: host.platform,
        sources: [statusSource({ id: 'status', series })],
      })
      yield* meters.start
      expect(meters.store.read({ series }).latest).toEqual({
        _tag: 'Unavailable',
        atMs: 0,
        reason: 'NotConfigured',
      })
      expect(host.requests).toBe(0)
    }).pipe(Effect.scoped),
  )
})
