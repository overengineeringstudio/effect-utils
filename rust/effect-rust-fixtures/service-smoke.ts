// Usage: bun rust/effect-rust-fixtures/service-smoke.ts <service-package-directory> <vectors.json>
// Exercises the generated EffectRustFixture service package: the Rust-owned contract
// codecs against the shared vectors (also run by the math-interop Rust tests), then
// the generated Context.Service class through both of its static Layers.
// `effect` and `@overeng/effect-rust` must resolve from this script and the package.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { scheduler } from 'node:timers/promises'

import { DateTime, Deferred, Effect, Exit, Fiber, Schema, Stream } from 'effect'

import { ContractJson, Interop } from '@overeng/effect-rust'

const [directory, vectorsPath] = process.argv.slice(2)
assert.ok(
  directory !== undefined && vectorsPath !== undefined,
  'Pass the generated service package directory and the shared vectors file',
)
// The package under test is a build output, so its path is runtime-selected; its
// own types are checked by compiling the package, not through this script.
// eslint-disable-next-line import/no-dynamic-require -- Contract codecs are loaded from the runtime-selected generated Buck service package under test.
const Contracts = await import(resolve(directory, 'contracts.ts'))
const { EffectRustFixture, ArithmeticError, SourceError } = await import(
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
const program = Effect.scoped(
  Effect.gen(function* () {
    const fixture = yield* EffectRustFixture
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
for (const [name, layer] of [
  [`layerWasm.${runtime}`, EffectRustFixture.layerWasm[runtime]({ panicPolicy: 'rebuild' })],
  [`layerNative.${runtime}`, EffectRustFixture.layerNative[runtime]()],
] as const) {
  // eslint-disable-next-line no-await-in-loop -- Verify and release the wasm runtime before starting native verification, preserving ordered fail-fast execution.
  const total = await Effect.runPromise(program.pipe(Effect.provide(layer)))
  // Released bindgen stream/host wrappers must remain safe when finalization runs.
  collect!()
  // eslint-disable-next-line no-await-in-loop -- Drain each released runtime's finalizers before initializing the next transport.
  await scheduler.yield()
  console.log(`${name}: quoteOrder total ${total}`)
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
