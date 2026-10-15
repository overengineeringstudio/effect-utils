import { NodeServices } from '@effect/platform-node'
import { it } from '@effect/vitest'
import { Effect, FileSystem, Schema } from 'effect'
import { expect } from 'vitest'

import { utf8Bytes } from '@overeng/content-address'

import { DataGraph, GraphStore, NodeKind, type NodeDef } from './mod.ts'

it.effect.prop(
  'arbitrary names round-trip and equal output digests cut off descendants',
  [Schema.String],
  ([raw]) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: 'data-graph-property-' })
      yield* Effect.gen(function* () {
        const name = `name:${raw.replaceAll('\0', '').trim()}`
        const names = [...new Set([name, '__proto__', 'constructor'])]
        const kind = yield* Schema.decodeEffect(NodeKind)('property-source')
        const consumerKind = yield* Schema.decodeEffect(NodeKind)('property-consumer')
        let version = '1'
        let calls = 0
        const source: NodeDef = {
          _tag: 'Derive',
          kind,
          outputs: names,
          inputs: () => ({}),
          recipe: () => ({ kind, version, config: {} }),
          execute: () =>
            Effect.succeed({
              _tag: 'Accepted',
              receipts: [],
              outputs: Object.fromEntries(
                names.map((key) => [key, { bytes: utf8Bytes(raw), mediaType: 'text/plain' }]),
              ),
            }),
        }
        const consumer: NodeDef = {
          _tag: 'Derive',
          kind: consumerKind,
          outputs: names,
          inputs: () =>
            Object.fromEntries(names.map((key) => [key, DataGraph.ref(source, {}, key)])),
          recipe: () => ({ kind: consumerKind, version: '1', config: {} }),
          execute: ({ inputs }) =>
            Effect.sync(() => {
              calls++
              expect(Object.keys(inputs).toSorted()).toEqual(names.toSorted())
              return {
                _tag: 'Accepted' as const,
                receipts: [],
                outputs: Object.fromEntries(
                  names.map((key) => [
                    key,
                    { bytes: utf8Bytes(inputs[key]!.digest), mediaType: 'text/plain' },
                  ]),
                ),
              }
            }),
        }
        const target = DataGraph.ref(consumer, {}, name)
        const first = yield* DataGraph.materialize(target)
        version = '2'
        const second = yield* DataGraph.materialize(target)
        expect(second.trace.map((entry) => entry.outcome._tag)).toEqual(['Executed', 'Reused'])
        expect(second.output.digest).toBe(first.output.digest)
        expect(Object.keys(second.outputs).toSorted()).toEqual(names.toSorted())
        expect(Object.getPrototypeOf(second.outputs)).toBe(null)
        expect(calls).toBe(1)
      }).pipe(Effect.provide(GraphStore.fileSystem(root)))
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  { timeout: 120_000, arbitrary: { runs: 20 } },
)
