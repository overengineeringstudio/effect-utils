// Usage: bun rust/effect-rust-fixtures/service-smoke.ts <service-package-directory> <vectors.json>
// Exercises the generated EffectRustFixture service package: the Rust-owned contract
// codecs against the shared vectors (also run by the math-interop Rust tests), then
// the generated Context.Service class through both of its static Layers.
// `effect` and `@overeng/effect-rust` must resolve from this script and the package.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { scheduler } from 'node:timers/promises'

import { Cause, Context, DateTime, Deferred, Effect, Exit, Fiber, Layer, Schema, Scope, Stream } from 'effect'

import { ContractJson, Interop } from '@overeng/effect-rust'

import { wasmSchedulerSmoke } from './wasm-scheduler-smoke.ts'

const [directory, vectorsPath] = process.argv.slice(2)
assert.ok(
  directory !== undefined && vectorsPath !== undefined,
  'Pass the generated service package directory and the shared vectors file',
)
// The package under test is a build output, so its path is runtime-selected; its
// own types are checked by compiling the package, not through this script.
// eslint-disable-next-line import/no-dynamic-require -- Contract codecs are loaded from the runtime-selected generated Buck service package under test.
const Contracts = await import(resolve(directory, 'contracts.ts'))
const { EffectRustFixture, ArithmeticError, SourceError, load } = await import(
  // eslint-disable-next-line import/no-dynamic-require -- Service statics are loaded from the runtime-selected generated Buck service package under test.
  resolve(directory, 'service.ts')
)

// Canonical JSON: the `kind` discriminator first, remaining keys by UTF-16 code unit.
const canonical = (value: unknown): string => {
  if (Array.isArray(value) === true) return `[${value.map(canonical).join(',')}]`
  if (typeof value !== 'object' || value === null) return JSON.stringify(value)
  // eslint-disable-next-line unicorn/no-array-sort -- Object.entries creates this private array; sort it without a redundant copy.
  const entries = Object.entries(value).sort(([left], [right]) =>
    left === 'kind' ? -1 : right === 'kind' ? 1 : left < right ? -1 : left > right ? 1 : 0,
  )
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`
}
const codecs = { Discount: Contracts.Discount, Order: Contracts.Order, Quote: Contracts.Quote }
const Vectors = Schema.Array(
  Schema.Struct({
    contract: Schema.Literals(['Discount', 'Order', 'Quote']),
    name: Schema.String,
    input: Schema.Unknown,
    accept: Schema.Boolean,
    canonical: Schema.optionalKey(Schema.Unknown),
  }),
)
const vectors = Schema.decodeUnknownSync(Vectors)(JSON.parse(readFileSync(vectorsPath, 'utf8')))
for (const vector of vectors) {
  const label = `${vector.contract}/${vector.name}`
  const codec = codecs[vector.contract]
  const decode = () => ContractJson.decode(codec)(JSON.stringify(vector.input))
  if (vector.accept === false) {
    assert.throws(decode, undefined, `${label} must be rejected`)
    continue
  }
  assert.equal(
    ContractJson.encode(codec)(decode()),
    canonical(vector.canonical ?? vector.input),
    label,
  )
}

const order = {
  id: 9007199254740993n,
  sku: 'ABC-1234',
  quantity: 3,
  unitPriceCents: 250n,
  placedAt: DateTime.makeUnsafe('2026-10-02T12:00:00.500Z'),
  note: 'gift',
}
const scalarCases = [
  ['echoI8', -128, 127],
  ['echoU8', 0, 255],
  ['echoI16', -32768, 32767],
  ['echoU16', 0, 65535],
  ['echoI32', -2147483648, 2147483647],
  ['echoU32', 0, 4294967295],
] as const
const program = (transport: 'wasm' | 'native') => Effect.scoped(
  Effect.gen(function* () {
    const fixture = yield* EffectRustFixture
    for (const [operation, minimum, maximum] of scalarCases) {
      for (const value of [minimum, maximum, 0]) {
        assert.equal(yield* fixture[operation](value), value, `${operation} accepts ${value}`)
      }
      for (const value of [minimum - 1, maximum + 1, 4294967297, 1.5, -0.5, NaN, Infinity, -Infinity, -0]) {
        const error = yield* fixture[operation](value).pipe(Effect.flip)
        assert.ok(error instanceof Interop.Input, `${operation} rejects ${value} as Input`)
        assert.equal(error.operation, operation)
      }
    }
    for (const request of [fixture.checkedDivide(10, 4294967297), fixture.add(1.5, 0)]) {
      assert.ok((yield* request.pipe(Effect.flip)) instanceof Interop.Input)
    }
    assert.equal(yield* fixture.checkedDivide(10, 2), 5)
    assert.equal(yield* fixture.add(1, 2), 3)
    assert.equal(yield* fixture.echoF32(1.1), Math.fround(1.1))
    assert.equal(
      Effect.runSync(
        fixture.sumJsonIntegers({
          unsigned: 4294967295,
          signed: -2147483648,
          bounded: Number.MAX_SAFE_INTEGER,
        }),
      ),
      4294967295n - 2147483648n + 9007199254740991n,
    )
    const dropsBeforeScope = yield* fixture.counterDrops()
    const escapedCounter = yield* Effect.scoped(Effect.gen(function* () {
      const counter = yield* fixture.counter(0)
      assert.deepEqual(
        yield* Effect.all([counter.append(1), counter.append(2), counter.append(3)], { concurrency: 'unbounded' }),
        [1, 12, 123],
        'concurrent methods on one mutable resource are serialized in submission order',
      )
      const expected = yield* counter.divide(0).pipe(Effect.flip)
      assert.ok(expected instanceof ArithmeticError)
      assert.deepEqual(expected.reason, { _tag: 'DivideByZero', dividend: 123 })
      assert.equal(yield* counter.value(), 123, 'expected errors leave the resource usable')
      return counter
    }))
    assert.equal(yield* fixture.counterDrops(), dropsBeforeScope + 1, 'scope close runs Rust Drop exactly once')
    yield* escapedCounter.close
    assert.equal(yield* fixture.counterDrops(), dropsBeforeScope + 1, 'explicit close after scope is idempotent')
    const closedCounter = yield* Effect.exit(escapedCounter.value())
    assert.ok(Exit.isFailure(closedCounter) && String(closedCounter.cause).includes('closed'))
    const dropsBeforeStress = yield* fixture.counterDrops()
    for (let index = 0; index < 1000; index++) {
      yield* Effect.scoped(Effect.gen(function* () {
        const counter = yield* fixture.counter(index)
        assert.equal(yield* counter.value(), index)
      }))
    }
    assert.equal(yield* fixture.counterDrops(), dropsBeforeStress + 1000, '1k scoped resources each run Rust Drop')
    const quote = yield* fixture.quoteOrder(order, { kind: 'percent', percent: 10 })
    assert.equal(quote.kind, 'priced')
    assert.equal(quote.note, 'gift')
    assert.equal(quote.receipt.orderId, 9007199254740993n)
    assert.equal(quote.receipt.totalCents, 675n)
    assert.equal(DateTime.formatIso(quote.receipt.placedAt), '2026-10-02T12:00:00.500Z')
    const free = yield* fixture.quoteOrder(
      { ...order, note: null },
      { kind: 'fixed', amountCents: 18446744073709551615n },
    )
    assert.deepEqual(free, { kind: 'free', orderId: 9007199254740993n })
    // Contract encoding rejects the brand before Rust is called.
    const invalid = yield* Effect.exit(
      fixture.quoteOrder({ ...order, sku: 'abc' }, { kind: 'none' }),
    )
    assert.ok(
      Exit.isFailure(invalid) && String(invalid.cause).includes('Input'),
      'invalid brand fails with Interop.Input',
    )
    const overflow = yield* fixture
      .quoteOrder(
        { ...order, quantity: 4294967295, unitPriceCents: 18446744073709551615n },
        { kind: 'none' },
      )
      .pipe(Effect.flip)
    assert.ok(overflow instanceof ArithmeticError)
    assert.deepEqual(overflow.reason, { _tag: 'PriceOverflow', quantity: 4294967295 })
    assert.equal(
      Effect.runSync(fixture.sha256Hex(new TextEncoder().encode('abc'))),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    const bytes = new TextEncoder().encode('abc')
    const digest = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    assert.equal(
      yield* Stream.run(
        Stream.fromArray([bytes.subarray(0, 1), bytes.subarray(1)]),
        fixture.hasher(),
      ),
      digest,
    )
    const source = yield* Interop.hostSource('abortable', {
      read: () => Effect.succeed(bytes),
      readRange: (_path, offset, maxBytes) =>
        Effect.succeed(bytes.subarray(Number(offset), Number(offset) + maxBytes)),
    })
    assert.equal(yield* fixture.hashAll(source, ['/host/file']), digest)
    const rangeBytes = new TextEncoder().encode('abcdef')
    const calls: Array<readonly [string, bigint, number]> = []
    let rangeFinalizers = 0
    const ranged = yield* Interop.hostSource('abortable', {
      read: () => Effect.succeed(rangeBytes),
      readRange: (path, offset, maxBytes) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            calls.push([path, offset, maxBytes])
            if (path === '/wide') return new Uint8Array([9])
            // A deliberately short host read, including before EOF.
            const start = offset >= BigInt(rangeBytes.length) ? rangeBytes.length : Number(offset)
            return rangeBytes.subarray(
              start,
              start + Math.min(maxBytes, path === '/short' ? 1 : maxBytes),
            )
          }),
          () =>
            Effect.sync(() => {
              rangeFinalizers++
            }),
        ),
    })
    assert.deepEqual([...(yield* fixture.readRange(ranged, '/range', 2n, 3))], [99, 100, 101])
    assert.deepEqual([...(yield* fixture.readRange(ranged, '/range', 4n, 9))], [101, 102])
    assert.deepEqual([...(yield* fixture.readRange(ranged, '/range', 6n, 3))], [])
    assert.deepEqual([...(yield* fixture.readRange(ranged, '/wide', 9007199254740993n, 1))], [9])
    assert.deepEqual(
      [...(yield* fixture.readRange(ranged, '/range', 18446744073709551615n, 1))],
      [],
    )
    assert.deepEqual(calls, [
      ['/range', 2n, 3],
      ['/range', 4n, 9],
      ['/range', 6n, 3],
      ['/wide', 9007199254740993n, 1],
      ['/range', 18446744073709551615n, 1],
    ])
    assert.equal(rangeFinalizers, 5, 'read scopes close before their bytes reach Rust')
    assert.equal(
      yield* fixture.hashRanges(ranged, '/short', 4),
      yield* fixture.sha256Hex(rangeBytes),
    )
    assert.deepEqual(
      calls.slice(5).map(([, offset]) => offset),
      [0n, 1n, 2n, 3n, 4n, 5n, 6n],
    )
    assert.equal(rangeFinalizers, 12, 'short-read continuation and EOF both finalize')
    const oversized = yield* Interop.hostSource('abortable', {
      read: () => Effect.succeed(bytes),
      readRange: () => Effect.succeed(bytes),
    })
    const tooLarge = yield* fixture.readRange(oversized, '/range', 0n, 1).pipe(Effect.flip)
    assert.ok(tooLarge instanceof SourceError)
    assert.match(tooLarge.reason.message, /maxBytes/)
    const zeroBound = yield* fixture.readRange(ranged, '/range', 0n, 0).pipe(Effect.flip)
    assert.ok(zeroBound instanceof SourceError)
    assert.match(zeroBound.reason.message, /positive/)
    assert.equal(calls.length, 12, 'zero bounds do not dispatch a host read')

    // Only a real event-loop yield lets this timer deliver cancellation between
    // CPU chunks. A token check or a chain of microtasks would hash through EOF.
    const cancelAtTask = yield* Deferred.make<void>()
    let cancellationReads = 0
    let cancellationFinalizers = 0
    let clearCancelTask: (() => void) | undefined
    yield* Effect.addFinalizer(() => Effect.sync(() => clearCancelTask?.()))
    const cancellable = yield* Interop.hostSource('abortable', {
      read: () => Effect.succeed(bytes),
      readRange: (_path, offset) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            cancellationReads++
            if (cancellationReads === 1) {
              const task = setTimeout(() => Deferred.doneUnsafe(cancelAtTask, Effect.void), 0)
              clearCancelTask = () => clearTimeout(task)
            }
            return bytes.subarray(Number(offset), Number(offset) + 1)
          }),
          () =>
            Effect.promise(async () => {
              await Promise.resolve()
              cancellationFinalizers++
            }),
        ),
    })
    const hashing = yield* fixture.hashRanges(cancellable, '/cancel', 2).pipe(Effect.forkChild)
    yield* Deferred.await(cancelAtTask)
    yield* Fiber.interrupt(hashing)
    const cancelled = yield* Fiber.await(hashing)
    assert.ok(Exit.isFailure(cancelled), 'timer cancellation reaches the still-running Rust job')
    assert.equal(cancellationReads, 1, 'cancellation after the yield prevents the next CPU chunk')
    assert.equal(
      cancellationFinalizers,
      1,
      'cancel acknowledgement includes host Effect finalizers',
    )
    yield* cancellable.quiesce
    assert.equal(
      yield* cancellable.live,
      0,
      'yield and read callbacks are quiescent before release',
    )
    const beforePanic = yield* fixture.counterDrops()
    const panicking = yield* fixture.counter(7)
    const sibling = yield* fixture.counter(8)
    const panicExit = yield* Effect.exit(panicking.panic())
    assert.ok(Exit.isFailure(panicExit) && Cause.hasDies(panicExit.cause), 'resource panic is a defect')
    const staleExit = yield* Effect.exit(sibling.value())
    assert.ok(Exit.isFailure(staleExit) && String(staleExit.cause).includes('retired'), 'one panic rejects sibling resources')
    yield* panicking.close
    yield* sibling.close
    assert.equal(yield* fixture.add(2, 3), 5, 'ordinary exports use the rebuilt generation')
    // Native unwinding permits Drop of both resources at retirement. Wasm
    // retirement discards the whole poisoned instance, not Rust destructors.
    const afterPanic = yield* fixture.counterDrops()
    assert.equal(afterPanic, transport === 'wasm' ? 0 : beforePanic + 2, 'retirement has truthful wasm/native Drop semantics')
    const fresh = yield* fixture.counter(9)
    assert.equal(yield* fresh.value(), 9)
    yield* fresh.close
    assert.equal(yield* fixture.counterDrops(), afterPanic + 1)
    return quote.receipt.totalCents
  }),
)
const runtime = process.versions.bun === undefined ? 'node' : 'bun'
const collectors = globalThis as typeof globalThis & {
  readonly Bun?: { readonly gc: (full: boolean) => void }
  readonly gc?: () => void
}
const collect = runtime === 'bun' ? () => collectors.Bun!.gc(true) : collectors.gc
assert.equal(typeof collect, 'function', 'Run Node with --expose-gc for the retirement regression')
for (const [transport, name, layer] of [
  ['wasm', `layerWasm.${runtime}`, EffectRustFixture.layerWasm[runtime]({ panicPolicy: 'rebuild' })],
  ['native', `layerNative.${runtime}`, EffectRustFixture.layerNative[runtime]()],
] as const) {
  // eslint-disable-next-line no-await-in-loop -- Verify and release the wasm runtime before starting native verification, preserving ordered fail-fast execution.
  const total = await Effect.runPromise(program(transport).pipe(Effect.provide(layer)))
  // Released bindgen stream/host wrappers must remain safe when finalization runs.
  collect!()
  // eslint-disable-next-line no-await-in-loop -- Drain each released runtime's finalizers before initializing the next transport.
  await scheduler.yield()
  console.log(`${name}: quoteOrder total ${total}`)
}

// Bypass the generated service checks: direct backend exports must validate too.
for (const backend of ['wasm', 'native'] as const) {
  // eslint-disable-next-line no-await-in-loop -- Each backend instance is released before the next is loaded.
  const instance = await load[backend][runtime]()
  try {
    for (const [operation, minimum, maximum] of scalarCases) {
      for (const value of [minimum, maximum, 0]) {
        assert.equal(instance.api[operation](value), value, `${backend} ${operation} accepts ${value}`)
      }
      for (const value of [minimum - 1, maximum + 1, 4294967297, 1.5, -0.5, NaN, Infinity, -Infinity, -0]) {
        assert.throws(
          () => instance.api[operation](value),
          (cause: unknown) => cause instanceof Error && cause.message.startsWith('RUST_INPUT:'),
          `${backend} ${operation} rejects ${value} before ABI narrowing`,
        )
      }
    }
    assert.throws(
      () => instance.api.checkedDivide(10, 4294967297),
      /^Error: RUST_INPUT:/,
    )
    assert.throws(() => instance.api.add(1.5, 0), /^Error: RUST_INPUT:/)
    assert.equal(instance.api.echoF32(1.1), Math.fround(1.1))
  } finally {
    // eslint-disable-next-line no-await-in-loop -- Release the current backend before loading another.
    await instance.release()
  }
}

await Effect.runPromise(
  wasmSchedulerSmoke({ runtime, load: load.wasm[runtime] }).pipe(Effect.timeout('10 seconds')),
)
console.log(`wasm ${runtime}: first-poll/host-await traps, sibling defects, retirement and rebuild verified`)

interface ShutdownApi {
  readonly counter: (initial: number) => Interop.ResourceHandle
  readonly counterDrops: () => number
  readonly pendingJob: () => Extract<Interop.RustJob<number>, { readonly mode: 'abortable' }>
}
class Shutdown extends Context.Service<Shutdown, Interop.Runtime<ShutdownApi>>()(
  'fixture/Shutdown',
) {}
for (const backend of ['wasm', 'native'] as const) {
  for (const finalizerStrategy of ['sequential', 'parallel'] as const) {
    const shutdownStarted = Promise.withResolvers<void>()
    const resumeShutdown = Promise.withResolvers<void>()
    let dropsBefore = 0
    let releases = 0
    const factory: Interop.InstanceFactory<ShutdownApi> = load[backend][runtime]
    const layer = Interop[backend === 'wasm' ? 'wasmLayer' : 'nativeLayer'][runtime](Shutdown, {
      make: (core) => core,
      load: async () => {
        const instance = await factory()
        dropsBefore = instance.api.counterDrops()
        return {
          ...instance,
          release: async () => {
            assert.equal(
              instance.api.counterDrops(),
              dropsBefore + 2,
              `${backend}: each resource's Rust Drop ran exactly once`,
            )
            releases++
            await instance.release()
          },
        }
      },
    })
    // eslint-disable-next-line no-await-in-loop -- Complete each independently scoped shutdown before opening the next runtime.
    await Effect.runPromise(
      Effect.gen(function* () {
        const runtimeScope = yield* Scope.make()
        const resourceScope = yield* Scope.make(finalizerStrategy)
        const context = yield* Layer.build(layer).pipe(Scope.provide(runtimeScope))
        const core = Context.get(context, Shutdown)
        const resources = yield* Effect.forEach([0, 1], (index) =>
          core.resource(({ api }) => api.counter(index)),
        ).pipe(Scope.provide(resourceScope))
        const jobStarted = yield* Deferred.make<void>()
        const pending = yield* core
          .call(({ api }) => {
            const job = api.pendingJob()
            Deferred.doneUnsafe(jobStarted, Effect.void)
            return {
              ...job,
              cancel: () => {
                const acknowledged = job.cancel()
                shutdownStarted.resolve()
                return Promise.resolve(acknowledged).then(() => resumeShutdown.promise)
              },
            }
          })
          .pipe(Effect.exit, Effect.forkChild)
        yield* Deferred.await(jobStarted)
        const closingRuntime = yield* Scope.close(runtimeScope, Exit.void).pipe(Effect.forkChild)
        yield* Effect.promise(() => shutdownStarted.promise)
        yield* Scope.close(resourceScope, Exit.void).pipe(
          Effect.ensuring(Effect.sync(() => resumeShutdown.resolve())),
        )
        yield* Fiber.join(closingRuntime)
        yield* Effect.forEach(resources, (resource) => resource.close)
        assert.equal(releases, 1, `${backend}: runtime released once without a finalizer defect`)
        assert.equal(
          Exit.isFailure(yield* Fiber.join(pending)),
          true,
          'shutdown retires the pending Effect',
        )
      }).pipe(Effect.timeout('10 seconds')),
    )
  }
}
console.log(
  'wasm/native: concurrent runtime/resource shutdown and parallel finalizers run Rust Drop exactly once',
)

interface RetirementApi {
  readonly pendingJob: () => Interop.RustJob<number>
  readonly settleJob: (source: Interop.SourceCallback) => Interop.RustJob<Uint8Array>
  readonly liveJobs: () => number
  readonly panicTest: () => number
  readonly add: (left: number, right: number) => number
}
class Retirement extends Context.Service<Retirement, Interop.Runtime<RetirementApi>>()(
  'fixture/Retirement',
) {}
for (const panicPolicy of ['rebuild', 'retire'] as const) {
  const nativeLoad: Interop.InstanceFactory<RetirementApi> = load.native[runtime]
  const instances: Interop.Instance<RetirementApi>[] = []
  const releasedLiveJobs: number[] = []
  const layer = Interop.nativeLayer[runtime](Retirement, {
    panicPolicy,
    make: (core) => core,
    load: async () => {
      const instance = await nativeLoad()
      instances.push(instance)
      return {
        api: instance.api,
        release: async () => {
          releasedLiveJobs.push(instance.api.liveJobs())
          await instance.release()
        },
      }
    },
  })
  // eslint-disable-next-line no-await-in-loop -- Each panic policy owns and releases its native generation before the next case.
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(layer)
        const core = Context.get(context, Retirement)
        const cancelled = yield* Deferred.make<void>()
        const started = yield* Deferred.make<void>()
        const finishRead = yield* Deferred.make<Uint8Array>()
        const source = yield* Interop.hostSource('settle-only', {
          read: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined)
              return yield* Deferred.await(finishRead)
            }),
          readRange: () => Effect.succeed(new Uint8Array()),
        })
        const pending = yield* core
          .call(({ api }) => {
            const job = api.pendingJob()
            assert.equal(job.mode, 'abortable')
            if (job.mode !== 'abortable') throw new Error('pending fixture must be abortable')
            return {
              ...job,
              cancel: async () => {
                await job.cancel()
                Deferred.doneUnsafe(cancelled, Effect.void)
              },
            }
          })
          .pipe(Effect.forkChild)
        while (instances[0]!.api.liveJobs() !== 1) yield* Effect.promise(() => scheduler.yield())
        const settling = yield* core
          .call(({ api, signal }) => api.settleJob((request) => source.call(signal, request)))
          .pipe(Effect.forkChild)
        yield* Deferred.await(started)
        yield* Effect.addFinalizer(() => Deferred.succeed(finishRead, new Uint8Array([1])))
        assert.equal(instances[0]!.api.liveJobs(), 2)
        const panic = yield* Effect.exit(core.call(({ api }) => api.panicTest()))
        assert.ok(Exit.isFailure(panic) && String(panic.cause).includes('RUST_PANIC:'))
        yield* Deferred.await(cancelled).pipe(Effect.timeout('5 seconds'))
        assert.equal(
          instances[0]!.api.liveJobs(),
          1,
          'native cancellation drops the sibling future',
        )
        assert.deepEqual(releasedLiveJobs, [], 'generation release waits for settle-only Rust work')
        assert.equal(instances.length, 1, 'replacement does not overlap the old native future')
        yield* Deferred.succeed(finishRead, new Uint8Array([1]))
        assert.ok(Exit.isFailure(yield* Fiber.await(pending)))
        assert.ok(Exit.isFailure(yield* Fiber.await(settling)))
        if (panicPolicy === 'rebuild') {
          assert.equal(yield* core.call(({ api }) => api.add(20, 22)), 42)
          assert.equal(instances.length, 2)
        } else {
          assert.ok(Exit.isFailure(yield* Effect.exit(core.call(({ api }) => api.add(20, 22)))))
        }
      }),
    ),
  )
  assert.deepEqual(releasedLiveJobs, panicPolicy === 'rebuild' ? [0, 0] : [0])
  // eslint-disable-next-line no-await-in-loop -- Observe each completed policy through a fresh native loader, never through released glue.
  const observer = await nativeLoad()
  assert.equal(observer.api.liveJobs(), 0, 'no native sibling survives Layer close')
  // eslint-disable-next-line no-await-in-loop -- Release the observer before running the next policy.
  await observer.release()
  console.log(`native ${panicPolicy}: abortable future dropped, settle-only future awaited`)
}
console.log(`${vectors.length} shared vectors agree; generated statics verified on ${runtime}`)
if (process.env.RUST_INTEROP_SMOKE_OUTPUT !== undefined) {
  writeFileSync(
    process.env.RUST_INTEROP_SMOKE_OUTPUT,
    JSON.stringify({
      runtime,
      vectors: vectors.length,
      layers: ['wasm', 'native'],
      forcedGc: true,
    }) + '\n',
  )
}
