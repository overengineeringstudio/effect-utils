import { performance } from 'node:perf_hooks'

import { NodeServices } from '@effect/platform-node'
import { it } from '@effect/vitest'
import { Effect, FileSystem, Option, Schema } from 'effect'
import { expect } from 'vitest'

import { canonicalJsonBytes } from '@overeng/content-address'

import { DataGraph, GraphStore, NodeKind, type Head, type NodeDef, type NodeRef } from './mod.ts'

/** One opaque-scope observation per item, pulled through a single deterministic aggregate. */
const scaleScenario = Effect.fn('DataGraph.scaleScenario')(function* (size: number) {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.makeTempDirectoryScoped({ prefix: `data-graph-scale-${size}-` })
  return yield* Effect.gen(function* () {
    let observationCalls = 0
    let aggregateCalls = 0
    const observationKind = Schema.decodeUnknownSync(NodeKind)('synthetic-scope-observation')
    const aggregateKind = Schema.decodeUnknownSync(NodeKind)('synthetic-scope-aggregate')
    const observation: NodeDef = {
      _tag: 'Observe',
      kind: observationKind,
      outputs: ['value'],
      inputs: () => ({}),
      recipe: (scope) => ({ kind: observationKind, version: '1', config: scope }),
      execute: Effect.fn('Scale.observe')(function* ({ scope }) {
        observationCalls++
        return {
          _tag: 'Accepted',
          outputs: {
            value: {
              bytes: canonicalJsonBytes({ schema: Schema.Json, value: scope }),
              mediaType: 'application/json',
              codec: 'canonical-json',
              schemaVersion: 1,
            },
          },
          receipts: [],
        }
      }),
    }
    const references: NodeRef[] = []
    const inputs: Record<string, NodeRef> = Object.create(null)
    const tiers = new Map<string, number>()
    for (let index = 0; index < size; index++) {
      const scope = { tenant: 'synthetic', entity: `item-${index.toString().padStart(5, '0')}` }
      const reference = DataGraph.ref(observation, scope, 'value')
      references.push(reference)
      inputs[`item-${index.toString().padStart(5, '0')}`] = reference
      tiers.set(DataGraph.nodeId({ kind: observationKind, scope }), index % 2)
    }
    const aggregate: NodeDef = {
      _tag: 'Derive',
      kind: aggregateKind,
      outputs: ['value'],
      inputs: () => inputs,
      recipe: () => ({ kind: aggregateKind, version: '1', config: { size } }),
      execute: Effect.fn('Scale.aggregate')(function* ({ inputs }) {
        aggregateCalls++
        const digests: Record<string, Schema.Json> = Object.create(null)
        for (const [name, descriptor] of Object.entries(inputs)) digests[name] = descriptor.digest
        return {
          _tag: 'Accepted',
          outputs: {
            value: {
              bytes: canonicalJsonBytes({ schema: Schema.Json, value: digests }),
              mediaType: 'application/json',
              codec: 'canonical-json',
              schemaVersion: 1,
            },
          },
          receipts: [],
        }
      }),
    }
    const target = DataGraph.ref(aggregate, { tenant: 'synthetic', size }, 'value')
    const refresh = references.map(({ node, scope }) =>
      DataGraph.nodeId({ kind: node.kind, scope }),
    )
    const coldStart = performance.now()
    const cold = yield* DataGraph.materialize(target, { refresh })
    const coldMillis = performance.now() - coldStart
    expect(cold.trace).toHaveLength(size + 1)
    expect(cold.trace.every((entry) => entry.outcome._tag === 'Executed')).toBe(true)
    expect(observationCalls).toBe(size)
    expect(aggregateCalls).toBe(1)

    const store = yield* GraphStore
    let reads = 0
    let writes = 0
    let pins = 0
    let lookups = 0
    const readDigests = new Set<string>()
    const profiled = {
      ...store,
      get: (descriptor: Parameters<typeof store.get>[0]) => {
        reads++
        readDigests.add(descriptor.digest)
        return store.get(descriptor)
      },
      put: (...args: Parameters<typeof store.put>) => {
        writes++
        return store.put(...args)
      },
      manifest: (...args: Parameters<typeof store.manifest>) => {
        writes++
        return store.manifest(...args)
      },
      pin: (...args: Parameters<typeof store.pin>) => {
        pins++
        return store.pin(...args)
      },
      lookup: (...args: Parameters<typeof store.lookup>) => {
        lookups++
        return store.lookup(...args)
      },
    }
    const warmStart = performance.now()
    const warm = yield* DataGraph.materialize(target).pipe(
      Effect.provideService(GraphStore, profiled),
    )
    const warmMillis = performance.now() - warmStart
    expect(warm.trace).toHaveLength(size + 1)
    expect(warm.trace.every((entry) => entry.outcome._tag === 'Reused')).toBe(true)
    expect(warm.output.digest).toBe(cold.output.digest)
    expect(warm.materialization.digest).toBe(cold.materialization.digest)
    expect(observationCalls).toBe(size)
    expect(aggregateCalls).toBe(1)

    // Inventory is caller-supplied but contains real persisted observation heads, not fabricated records.
    const heads: Head[] = []
    const inventoryStart = performance.now()
    for (const reference of references)
      heads.push(
        Option.getOrThrow(
          yield* DataGraph.getHead({ kind: reference.node.kind, scope: reference.scope }),
        ),
      )
    const inventoryMillis = performance.now() - inventoryStart
    expect(heads).toHaveLength(size)
    const now = Math.max(...heads.map((head) => head.lastConfirmedAt ?? 0)) + 1_000
    const planningStart = performance.now()
    const requests = DataGraph.planRefresh({
      now,
      heads,
      policy: (key) => ({ tier: tiers.get(DataGraph.nodeId(key)) ?? 1, maxAge: 100 }),
      compareTiers: (left, right) => left - right,
      budget: 32,
    })
    const planningMillis = performance.now() - planningStart
    expect(requests).toHaveLength(32)
    expect(requests.every((request) => request.tier === 0 && request.overdueBy >= 900)).toBe(true)
    expect(new Set(requests.map((request) => request.nodeId)).size).toBe(32)
    for (let index = 1; index < requests.length; index++) {
      const previous = requests[index - 1]!
      const current = requests[index]!
      expect(previous.overdueBy).toBeGreaterThanOrEqual(current.overdueBy)
      if (previous.overdueBy === current.overdueBy)
        expect(previous.nodeId < current.nodeId).toBe(true)
    }
    // Bypass test-console suppression: benchmark evidence must reach process output.
    yield* Effect.sync(() =>
      process.stdout.write(
        `data-graph scale scopes=${size} nodes=${size + 1} cold=${coldMillis.toFixed(2)}ms ` +
          `warm-all-reused=${warmMillis.toFixed(2)}ms inventory=${inventoryMillis.toFixed(2)}ms ` +
          `planRefresh=${planningMillis.toFixed(2)}ms planned=${requests.length} ` +
          `warm-cas-gets=${reads} unique-read-digests=${readDigests.size} ` +
          `warm-object-writes=${writes} pins=${pins} pin-lookups=${lookups}\n`,
      ),
    )
  }).pipe(Effect.provide(GraphStore.fileSystem(root)))
})

it.effect(
  'materializes 1k opaque scopes, reuses every warm node and times inventory refresh planning',
  () => scaleScenario(1_000).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 300_000 },
)

// Opt in explicitly: DATA_GRAPH_SCALE_10K=1 vitest run src/scale.integration.test.ts.
it.effect.skipIf(process.env.DATA_GRAPH_SCALE_10K !== '1')(
  'benchmarks 10k opaque scopes with cold materialization, all-Reused warm pull and planRefresh',
  () => scaleScenario(10_000).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 1_800_000 },
)
