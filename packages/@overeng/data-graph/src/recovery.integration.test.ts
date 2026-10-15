import { NodeServices } from '@effect/platform-node'
import { it } from '@effect/vitest'
import { Cause, Effect, Exit, FileSystem, Option, Schema } from 'effect'
import { expect } from 'vitest'

import { objectPathForDigest, utf8Bytes, type ContentDescriptor } from '@overeng/content-address'

import { DataGraph, GraphStore, NodeKind, type GraphStoreApi, type NodeDef } from './mod.ts'

/** Interrupt only publication; all bytes and manifests still go through the real filesystem CAS. */
const interruptedPublication = (store: GraphStoreApi, boundary: 'action' | 'head') => {
  const objects: ContentDescriptor[] = []
  const manifests: ContentDescriptor[] = []
  const pins: string[] = []
  const service: GraphStoreApi = {
    ...store,
    put: (...args) =>
      store
        .put(...args)
        .pipe(Effect.tap((descriptor) => Effect.sync(() => objects.push(descriptor)))),
    manifest: (manifest) =>
      store
        .manifest(manifest)
        .pipe(Effect.tap((descriptor) => Effect.sync(() => manifests.push(descriptor)))),
    pin: (name, descriptor) =>
      Effect.gen(function* () {
        pins.push(name)
        if (name.startsWith(`data-graph/${boundary === 'action' ? 'actions' : 'heads'}/`) === true)
          return yield* Effect.interrupt
        yield* store.pin(name, descriptor)
      }),
  }
  return { service, objects, manifests, pins }
}

const fixture = () => {
  let calls = 0
  const kind = Schema.decodeSync(NodeKind)('recovery-synthetic')
  const scope = { tenant: 'recovery', item: 'one' }
  const node: NodeDef = {
    _tag: 'Derive',
    kind,
    outputs: ['value'],
    inputs: () => ({}),
    recipe: (scope) => ({ kind, version: '1', config: scope }),
    execute: Effect.fn('Recovery.synthetic')(() =>
      Effect.sync(() => {
        calls++
        return {
          _tag: 'Accepted' as const,
          outputs: { value: { bytes: utf8Bytes('durable output'), mediaType: 'text/plain' } },
          receipts: [],
        }
      }),
    ),
  }
  return {
    key: { kind, scope },
    target: DataGraph.ref({ node: node, scope: scope, output: 'value' }),
    calls: () => calls,
  }
}

const expectInterrupted = <TValue, TError>(exit: Exit.Exit<TValue, TError>) => {
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit) === true) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
}

it.effect(
  'leaves unpinned immutable objects invisible and recovers on the next pull',
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: 'data-graph-unpinned-' })
      const test = fixture()
      yield* Effect.gen(function* () {
        const store = yield* GraphStore
        const interrupted = interruptedPublication(store, 'action')
        const exit = yield* DataGraph.materialize(test.target).pipe(
          Effect.provideService(GraphStore, interrupted.service),
          Effect.exit,
        )
        expectInterrupted(exit)
        expect(test.calls()).toBe(1)
        expect(interrupted.objects.length).toBeGreaterThan(0)
        expect(interrupted.manifests.length).toBeGreaterThanOrEqual(2)
        for (const descriptor of [...interrupted.objects, ...interrupted.manifests])
          expect((yield* store.get(descriptor)).byteLength).toBe(descriptor.byteLength)
        expect(interrupted.pins).toHaveLength(1)
        expect(Option.isNone(yield* store.lookup(interrupted.pins[0]!))).toBe(true)
        expect(Option.isNone(yield* DataGraph.getHead(test.key))).toBe(true)
      }).pipe(Effect.provide(GraphStore.fileSystem(root)))
      // A fresh service reads persisted state, not the instrumented wrapper's memory.
      yield* Effect.gen(function* () {
        expect(Option.isNone(yield* DataGraph.getHead(test.key))).toBe(true)
        const recovered = yield* DataGraph.materialize(test.target)
        expect(recovered.outcome._tag).toBe('Executed')
        expect(test.calls()).toBe(2)
        const head = Option.getOrThrow(yield* DataGraph.getHead(test.key))
        expect(head.materialization.digest).toBe(recovered.materialization.digest)
        expect((yield* DataGraph.materialize(test.target)).outcome._tag).toBe('Reused')
        expect(test.calls()).toBe(2)
      }).pipe(Effect.provide(GraphStore.fileSystem(root)))
    }).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 60_000 },
)

it.effect(
  'recovers an accepted action pin without a head without executing again',
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: 'data-graph-action-only-' })
      const test = fixture()
      const accepted = yield* Effect.gen(function* () {
        const store = yield* GraphStore
        const interrupted = interruptedPublication(store, 'head')
        expectInterrupted(
          yield* DataGraph.materialize(test.target).pipe(
            Effect.provideService(GraphStore, interrupted.service),
            Effect.exit,
          ),
        )
        expect(test.calls()).toBe(1)
        expect(interrupted.pins).toHaveLength(2)
        const action = Option.getOrThrow(yield* store.lookup(interrupted.pins[0]!))
        expect(Option.isNone(yield* store.lookup(interrupted.pins[1]!))).toBe(true)
        expect(Option.isNone(yield* DataGraph.getHead(test.key))).toBe(true)
        expect((yield* store.get(action)).byteLength).toBe(action.byteLength)
        return action
      }).pipe(Effect.provide(GraphStore.fileSystem(root)))
      yield* Effect.gen(function* () {
        expect(Option.isNone(yield* DataGraph.getHead(test.key))).toBe(true)
        const recovered = yield* DataGraph.materialize(test.target)
        expect(recovered.outcome).toEqual({ _tag: 'Reused' })
        expect(recovered.materialization.digest).toBe(accepted.digest)
        expect(test.calls()).toBe(1)
        const head = Option.getOrThrow(yield* DataGraph.getHead(test.key))
        expect(head.materialization.digest).toBe(accepted.digest)
        expect((yield* DataGraph.materialize(test.target)).outcome._tag).toBe('Reused')
        expect(test.calls()).toBe(1)
      }).pipe(Effect.provide(GraphStore.fileSystem(root)))
    }).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 60_000 },
)

it.effect(
  'fails closed when an accepted action references a corrupted filesystem object',
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: 'data-graph-corrupt-recovery-' })
      const test = fixture()
      const accepted = yield* Effect.gen(function* () {
        const store = yield* GraphStore
        const interrupted = interruptedPublication(store, 'head')
        expectInterrupted(
          yield* DataGraph.materialize(test.target).pipe(
            Effect.provideService(GraphStore, interrupted.service),
            Effect.exit,
          ),
        )
        return Option.getOrThrow(yield* store.lookup(interrupted.pins[0]!))
      }).pipe(Effect.provide(GraphStore.fileSystem(root)))
      // Damage an actual durable object, rather than returning fake bytes from a store method.
      yield* fs.writeFileString(
        `${root}/${objectPathForDigest(accepted.digest)}`,
        'corrupted object',
      )
      yield* Effect.gen(function* () {
        const result = yield* DataGraph.materialize(test.target).pipe(Effect.result)
        expect(result._tag).toBe('Failure')
        if (result._tag === 'Failure') {
          expect(result.failure._tag).toBe('ContentDescriptorMismatchError')
          if (result.failure._tag === 'ContentDescriptorMismatchError')
            expect(result.failure.expectedDigest).toBe(accepted.digest)
        }
        expect(test.calls()).toBe(1)
        expect(Option.isNone(yield* DataGraph.getHead(test.key))).toBe(true)
      }).pipe(Effect.provide(GraphStore.fileSystem(root)))
    }).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 60_000 },
)
