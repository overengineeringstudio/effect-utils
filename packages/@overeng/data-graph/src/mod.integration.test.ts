import { NodeServices } from '@effect/platform-node'
import { it } from '@effect/vitest'
import { Effect, FileSystem, Option, Schema } from 'effect'
import { expect } from 'vitest'

import { ContentManifest, utf8Bytes } from '@overeng/content-address'

import { DataGraph, GraphStore, NodeKind, type NodeDef, type OutputBytes } from './mod.ts'
import { scenario } from './scenario.ts'

it.effect(
  'demonstrates both cutoffs, output channels, freshness and rejected observations with real CAS',
  () => scenario().pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  { timeout: 60_000 },
)

it.effect(
  'compares historical outputs across versioned additions and removals',
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: 'data-graph-upgrade-' })
      yield* Effect.gen(function* () {
        const kind = yield* Schema.decodeEffect(NodeKind)('versioned-extract')
        const scope = { document: 'versioned' }
        let calls = 0
        const definition = (version: string, outputNames: ReadonlyArray<string>): NodeDef => ({
          _tag: 'Derive',
          kind,
          outputs: outputNames,
          inputs: () => ({}),
          recipe: () => ({ kind, version, config: {} }),
          execute: Effect.fn('Upgrade.extract')(function* () {
            calls++
            const outputs: Record<string, OutputBytes> = Object.create(null)
            for (const name of outputNames)
              outputs[name] = { bytes: utf8Bytes(name), mediaType: 'text/plain' }
            return { _tag: 'Accepted', outputs, receipts: [] }
          }),
        })
        const first = yield* DataGraph.materialize(
          DataGraph.ref(definition('1', ['value']), scope, 'value'),
        )
        expect(first.outcome).toEqual({ _tag: 'Executed', changedOutputs: ['value'] })
        const secondDef = definition('2', ['value', 'evidence'])
        const second = yield* DataGraph.materialize(DataGraph.ref(secondDef, scope, 'evidence'))
        expect(second.outcome).toEqual({ _tag: 'Executed', changedOutputs: ['evidence'] })
        expect(second.outputs.value?.digest).toBe(first.outputs.value?.digest)
        const secondReused = yield* DataGraph.materialize(DataGraph.ref(secondDef, scope, 'value'))
        expect(secondReused.outcome).toEqual({ _tag: 'Reused' })
        const thirdDef = definition('3', ['value'])
        const third = yield* DataGraph.materialize(DataGraph.ref(thirdDef, scope, 'value'))
        expect(third.outcome).toEqual({ _tag: 'Executed', changedOutputs: ['evidence'] })
        expect(Object.keys(third.outputs)).toEqual(['value'])
        expect(third.outputs.value?.digest).toBe(first.outputs.value?.digest)
        const thirdReused = yield* DataGraph.materialize(DataGraph.ref(thirdDef, scope, 'value'))
        expect(thirdReused.outcome).toEqual({ _tag: 'Reused' })
        expect(calls).toBe(3)
      }).pipe(Effect.provide(GraphStore.fileSystem(root)))
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  { timeout: 60_000 },
)

it.effect(
  'preserves constructor and __proto__ names through publication, reuse and invalidation',
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: 'data-graph-names-' })
      yield* Effect.gen(function* () {
        const sourceKind = yield* Schema.decodeEffect(NodeKind)('named-source')
        const consumerKind = yield* Schema.decodeEffect(NodeKind)('named-consumer')
        const scope = { document: 'named' }
        let version = '1'
        let sourceCalls = 0
        let consumerCalls = 0
        const source: NodeDef = {
          _tag: 'Derive',
          kind: sourceKind,
          outputs: ['constructor', '__proto__'],
          inputs: () => ({}),
          recipe: () => ({ kind: sourceKind, version, config: {} }),
          execute: Effect.fn('Names.source')(function* () {
            sourceCalls++
            return {
              _tag: 'Accepted',
              receipts: [],
              outputs: {
                ['constructor']: { bytes: utf8Bytes('stable'), mediaType: 'text/plain' },
                ['__proto__']: { bytes: utf8Bytes(version), mediaType: 'text/plain' },
              },
            }
          }),
        }
        const consumer: NodeDef = {
          _tag: 'Derive',
          kind: consumerKind,
          outputs: ['constructor', '__proto__'],
          inputs: () => ({
            ['constructor']: DataGraph.ref(source, scope, 'constructor'),
            ['__proto__']: DataGraph.ref(source, scope, '__proto__'),
          }),
          recipe: () => ({ kind: consumerKind, version: '1', config: {} }),
          execute: Effect.fn('Names.consumer')(function* ({ inputs }) {
            consumerCalls++
            expect(Object.keys(inputs).toSorted()).toEqual(['__proto__', 'constructor'])
            expect(Object.getPrototypeOf(inputs)).toBe(null)
            return {
              _tag: 'Accepted',
              receipts: [],
              outputs: {
                ['constructor']: {
                  bytes: utf8Bytes(inputs['constructor']!.digest),
                  mediaType: 'text/plain',
                },
                ['__proto__']: {
                  bytes: utf8Bytes(inputs.__proto__!.digest),
                  mediaType: 'text/plain',
                },
              },
            }
          }),
        }
        const target = DataGraph.ref(consumer, scope, 'constructor')
        const first = yield* DataGraph.materialize(target)
        expect(first.trace.map((entry) => entry.outcome._tag)).toEqual(['Executed', 'Executed'])
        expect(Object.keys(first.outputs).toSorted()).toEqual(['__proto__', 'constructor'])
        const firstHead = Option.getOrThrow(yield* DataGraph.getHead({ kind: consumerKind, scope }))
        const store = yield* GraphStore
        const action = yield* Schema.decodeEffect(Schema.fromJsonString(ContentManifest))(
          new TextDecoder().decode(yield* store.get(firstHead.action)),
        )
        expect(
          action.entries
            .filter((entry) => entry.role === 'input')
            .map((entry) => entry.logicalPath),
        ).toEqual(['__proto__', 'constructor'])
        const reused = yield* DataGraph.materialize(target)
        expect(reused.trace.map((entry) => entry.outcome._tag)).toEqual(['Reused', 'Reused'])
        expect(Object.keys(reused.outputs).toSorted()).toEqual(['__proto__', 'constructor'])
        expect(Object.getPrototypeOf(reused.outputs)).toBe(null)
        version = '2'
        const changed = yield* DataGraph.materialize(target)
        expect(changed.trace.map((entry) => entry.outcome)).toEqual([
          { _tag: 'Executed', changedOutputs: ['__proto__'] },
          { _tag: 'Executed', changedOutputs: ['__proto__'] },
        ])
        const secondHead = Option.getOrThrow(
          yield* DataGraph.getHead({ kind: consumerKind, scope }),
        )
        expect(secondHead.action.digest).not.toBe(firstHead.action.digest)
        expect(changed.outputs['constructor']?.digest).toBe(first.outputs['constructor']?.digest)
        expect(changed.outputs.__proto__?.digest).not.toBe(first.outputs.__proto__?.digest)
        const changedReused = yield* DataGraph.materialize(target)
        expect(changedReused.trace.map((entry) => entry.outcome._tag)).toEqual(['Reused', 'Reused'])
        expect(sourceCalls).toBe(2)
        expect(consumerCalls).toBe(2)
      }).pipe(Effect.provide(GraphStore.fileSystem(root)))
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  { timeout: 60_000 },
)

it.effect(
  'serializes concurrent pulls across layers sharing one store root',
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: 'data-graph-concurrent-' })
      const kind = yield* Schema.decodeEffect(NodeKind)('concurrent')
      let calls = 0
      const node: NodeDef = {
        _tag: 'Derive',
        kind,
        outputs: ['value'],
        inputs: () => ({}),
        recipe: () => ({ kind, version: '1', config: {} }),
        execute: Effect.fn('Concurrent.execute')(function* () {
          calls++
          yield* Effect.yieldNow
          return {
            _tag: 'Accepted',
            receipts: [],
            outputs: {
              value: { bytes: utf8Bytes('deterministic'), mediaType: 'text/plain' },
            },
          }
        }),
      }
      const target = DataGraph.ref(node, {}, 'value')
      const results = yield* Effect.all(
        Array.from({ length: 8 }, () =>
          DataGraph.materialize(target).pipe(Effect.provide(GraphStore.fileSystem(root))),
        ),
        { concurrency: 'unbounded' },
      )
      expect(calls).toBe(1)
      expect(results.filter((result) => result.outcome._tag === 'Executed')).toHaveLength(1)
      expect(results.filter((result) => result.outcome._tag === 'Reused')).toHaveLength(7)
      expect(new Set(results.map((result) => result.materialization.digest)).size).toBe(1)
      const head = Option.getOrThrow(
        yield* DataGraph.getHead({ kind, scope: {} }).pipe(
          Effect.provide(GraphStore.fileSystem(root)),
        ),
      )
      expect(head.materialization.digest).toBe(results[0]!.materialization.digest)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  { timeout: 60_000 },
)
