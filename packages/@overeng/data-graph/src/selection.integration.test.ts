import { NodeServices } from '@effect/platform-node'
import { it } from '@effect/vitest'
import { Effect, FileSystem, Option, Schema } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { expect } from 'vitest'

import { utf8Bytes } from '@overeng/content-address'

import { DataGraph, GraphExecutionError, GraphStore, NodeKind, type NodeDef } from './mod.ts'

it.effect('durable status exposes stale acceptance and rejection across service restart', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped({ prefix: 'data-graph-selection-' })
    const kind = Schema.decodeUnknownSync(NodeKind)('selection')
    let version = '1'
    let outcome: 'accept' | 'reject' | 'fail' = 'accept'
    let calls = 0
    const node: NodeDef = {
      _tag: 'Observe', kind, outputs: ['value'], inputs: () => ({}),
      recipe: () => ({ kind, version, config: {} }),
      execute: () => Effect.gen(function* () {
        calls++
        if (outcome === 'fail') return yield* new GraphExecutionError({ message: 'unavailable' })
        if (outcome === 'reject') return { _tag: 'Rejected', reason: 'policy denied', receipts: [] }
        return { _tag: 'Accepted', receipts: [], outputs: {
          value: { bytes: utf8Bytes('same bytes'), mediaType: 'text/plain' },
        } }
      }),
    }
    const target = DataGraph.ref(node, {}, 'value')
    const refresh = { refresh: [DataGraph.nodeId({ kind, scope: {} })] }
    const pull = () => DataGraph.materialize(target, refresh).pipe(Effect.provide(GraphStore.fileSystem(root)))
    const status = () => DataGraph.getSelectionStatus(target).pipe(Effect.provide(GraphStore.fileSystem(root)))
    yield* pull()
    const first = yield* status()
    expect(first.acceptance).toBe('Current')
    yield* TestClock.adjust('1 second')
    yield* pull()
    const second = yield* status()
    const before = Option.getOrThrow(first.head)
    const confirmed = Option.getOrThrow(second.head)
    expect(confirmed.lastConfirmedAt).toBe(before.lastConfirmedAt! + 1000)
    expect(confirmed.materialization.digest).toBe(before.materialization.digest)
    expect(confirmed.action.digest).toBe(before.action.digest)
    const callCount = calls
    expect(DataGraph.checkFreshness({ status: second, now: confirmed.lastConfirmedAt! + 100, maxAge: 1000 })).toBe(true)
    expect(DataGraph.checkFreshness({ status: second, now: confirmed.lastConfirmedAt! + 1000, maxAge: 1000 })).toBe(false)
    expect(calls).toBe(callCount)
    outcome = 'fail'
    yield* TestClock.adjust('1 second')
    expect((yield* pull().pipe(Effect.result))._tag).toBe('Failure')
    const failed = yield* status()
    expect(Option.getOrThrow(failed.head)).toEqual(confirmed)
    expect(Option.getOrThrow(failed.latestAttempt)._tag).toBe('Failed')
    version = '2'
    outcome = 'reject'
    yield* pull()
    const rejected = yield* status()
    expect(rejected.acceptance).toBe('StaleAction')
    expect(Option.getOrThrow(rejected.head)).toEqual(confirmed)
    expect(Option.getOrThrow(rejected.latestAttempt)).toMatchObject({ _tag: 'Rejected', reason: 'policy denied' })
    expect(DataGraph.checkFreshness({ status: rejected, now: confirmed.lastConfirmedAt!, maxAge: 1000 })).toBe(false)
    expect((yield* DataGraph.materialize(target).pipe(Effect.provide(GraphStore.fileSystem(root)), Effect.result))._tag).toBe('Failure')
    outcome = 'accept'
    yield* pull()
    expect((yield* status()).acceptance).toBe('Current')
    expect(Option.getOrThrow((yield* status()).latestAttempt)._tag).toBe('Accepted')
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  { timeout: 60_000 },
)

it.effect('prioritizes opaque consumer tiers then overdue age within budget', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped({ prefix: 'data-graph-tiers-' })
    yield* Effect.gen(function* () {
      const kind = Schema.decodeUnknownSync(NodeKind)('tiers')
      const node: NodeDef = {
        _tag: 'Observe', kind, outputs: ['value'], inputs: () => ({}),
        recipe: () => ({ kind, version: '1', config: {} }),
        execute: () => Effect.succeed({ _tag: 'Accepted', receipts: [], outputs: {
          value: { bytes: utf8Bytes('tier'), mediaType: 'text/plain' },
        } }),
      }
      const heads = []
      for (const scope of ['low', 'high-old', 'high-new']) {
        yield* DataGraph.materialize(DataGraph.ref(node, scope, 'value'), { refresh: [DataGraph.nodeId({ kind, scope })] })
        heads.push(Option.getOrThrow(yield* DataGraph.getHead({ kind, scope })))
        yield* TestClock.adjust('1 second')
      }
      const planned = DataGraph.planRefresh({
        heads, now: heads[2]!.lastConfirmedAt! + 10_000, budget: 2,
        policy: (key) => ({ tier: key.scope === 'low' ? 'secondary' : 'primary', maxAge: 1000 }),
        compareTiers: (left, right) => Number(left === 'secondary') - Number(right === 'secondary'),
      })
      expect(planned.map((request) => request.key.scope)).toEqual(['high-old', 'high-new'])
      expect(planned.map((request) => request.tier)).toEqual(['primary', 'primary'])
    }).pipe(Effect.provide(GraphStore.fileSystem(root)))
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  { timeout: 60_000 },
)
