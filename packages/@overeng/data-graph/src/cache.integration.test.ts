import { NodeServices } from '@effect/platform-node'
import { it } from '@effect/vitest'
import { Effect, FileSystem, Option, Schema } from 'effect'
import { expect } from 'vitest'

import { objectPathForDigest, utf8Bytes } from '@overeng/content-address'

import { DataGraph, GraphStore, NodeKind, type NodeDef } from './mod.ts'

it.effect(
  'verifies descriptors once per pull, resolves shared inputs once, and does not rewrite a warm selection',
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: 'data-graph-read-cache-' })
      yield* Effect.gen(function* () {
        const kind = yield* Schema.decodeEffect(NodeKind)('shared-source')
        const consumerKind = yield* Schema.decodeEffect(NodeKind)('shared-consumer')
        let sourceCalls = 0
        let consumerCalls = 0
        const source: NodeDef = {
          _tag: 'Derive',
          kind,
          outputs: ['value'],
          inputs: () => ({}),
          recipe: () => ({ kind, version: '1', config: {} }),
          execute: () =>
            Effect.sync(() => {
              sourceCalls++
              return {
                _tag: 'Accepted' as const,
                receipts: [],
                outputs: {
                  value: { bytes: utf8Bytes('shared'), mediaType: 'text/plain' },
                },
              }
            }),
        }
        const consumer: NodeDef = {
          _tag: 'Derive',
          kind: consumerKind,
          outputs: ['value'],
          inputs: () => ({
            left: DataGraph.ref(source, {}, 'value'),
            right: DataGraph.ref(source, {}, 'value'),
          }),
          recipe: () => ({ kind: consumerKind, version: '1', config: {} }),
          execute: () =>
            Effect.sync(() => {
              consumerCalls++
              return {
                _tag: 'Accepted' as const,
                receipts: [],
                outputs: {
                  value: { bytes: utf8Bytes('consumer'), mediaType: 'text/plain' },
                },
              }
            }),
        }
        const target = DataGraph.ref(consumer, {}, 'value')
        const cold = yield* DataGraph.materialize(target)
        expect(cold.trace).toHaveLength(2)
        expect(sourceCalls).toBe(1)
        expect(consumerCalls).toBe(1)
        const store = yield* GraphStore
        const reads = new Map<string, number>()
        let writes = 0
        let pins = 0
        const profiled = {
          ...store,
          get: (descriptor: Parameters<typeof store.get>[0]) => {
            reads.set(descriptor.digest, (reads.get(descriptor.digest) ?? 0) + 1)
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
        }
        const warm = yield* DataGraph.materialize(target).pipe(
          Effect.provideService(GraphStore, profiled),
        )
        expect(warm.trace.map((entry) => entry.outcome._tag)).toEqual(['Reused', 'Reused'])
        expect(reads.size).toBeGreaterThan(0)
        expect([...reads.values()].every((count) => count === 1)).toBe(true)
        expect(writes).toBe(0)
        expect(pins).toBe(0)
        expect(sourceCalls).toBe(1)
        expect(consumerCalls).toBe(1)

        // Each pull starts a new verification cache: corruption cannot hide behind a previous hit.
        const sourceOutput = cold.trace[0]!.outputs.value!
        yield* fs.writeFileString(`${root}/${objectPathForDigest(sourceOutput.digest)}`, 'corrupt')
        const corruptedOutput = yield* DataGraph.materialize(target).pipe(Effect.result)
        expect(corruptedOutput._tag).toBe('Failure')
        if (corruptedOutput._tag === 'Failure')
          expect(corruptedOutput.failure._tag).toBe('ContentDescriptorMismatchError')
        yield* fs.writeFileString(`${root}/${objectPathForDigest(sourceOutput.digest)}`, 'shared')
        const head = Option.getOrThrow(yield* DataGraph.getHead({ kind, scope: {} }))
        yield* fs.writeFileString(
          `${root}/${objectPathForDigest(head.action.digest)}`,
          'corrupt action',
        )
        const corruptedAction = yield* DataGraph.materialize(target).pipe(Effect.result)
        expect(corruptedAction._tag).toBe('Failure')
        if (corruptedAction._tag === 'Failure')
          expect(corruptedAction.failure._tag).toBe('ContentDescriptorMismatchError')
        expect(sourceCalls).toBe(1)
        expect(consumerCalls).toBe(1)
      }).pipe(Effect.provide(GraphStore.fileSystem(root)))
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  { timeout: 60_000 },
)
