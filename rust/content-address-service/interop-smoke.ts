// Usage: bun interop-smoke.ts <service-package> <contract-schema>; Node additionally requires --expose-gc.
// Console output is the standalone integration smoke verdict, matching foundation fixtures.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { scheduler } from 'node:timers/promises'

import { Effect, Exit, Fiber, Stream } from 'effect'

import { ContractJson, Interop } from '@overeng/effect-rust'

const [serviceDirectory, contractSchema] = process.argv.slice(2)
assert.ok(
  serviceDirectory !== undefined && contractSchema !== undefined,
  'Pass the generated service package directory and the compiler-emitted descriptor schema',
)
// The shared smoke rule requires an auxiliary input; this is the real compiler
// schema, not a synthetic vectors file. Byte/tree cases below are independent of it.
const directory = resolve(serviceDirectory)
const require = createRequire(import.meta.url)
// The generated service lives in the runtime-selected product directory.
// eslint-disable-next-line import/no-dynamic-require -- Load the actual generated Buck service product selected by the smoke rule.
const { ContentAddressCore } = await import(resolve(directory, 'dist/service.js'))
// eslint-disable-next-line import/no-dynamic-require -- Decode the actual compiler-generated descriptor schema.
const Contracts = await import(resolve(directory, 'dist/contracts.js'))
const bytes = Buffer.from('abc')
const expected = 'sha256:' + createHash('sha256').update(bytes).digest('hex')
const records = [
  { kind: 'directory', path: '.', mode: 0o40755 },
  { kind: 'symlink', path: 'link', mode: 0o120777, target: 'file' },
  { kind: 'file', path: 'file', mode: 0o100644, readPath: '/host/file' },
]
const oracle = createHash('sha256')
const text = (value: string) => {
  const body = Buffer.from(value)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length)
  oracle.update(length).update(body)
}
for (const record of records) {
  text(record.path)
  text(String(record.mode & 0o7777))
  text(record.kind)
  if (record.kind === 'symlink') text(record.target!)
  if (record.kind === 'file') oracle.update(bytes)
}
const expectedTree = 'sha256:' + oracle.digest('hex')
const failedRead = (): Promise<never> => Promise.reject(new Error('host read failed'))
const unresolvedRead = (): Promise<never> => Promise.withResolvers<never>().promise
const cancellationFailure = (cause: unknown): unknown => cause
for (const [name, api] of [
  // eslint-disable-next-line import/no-commonjs, import/no-dynamic-require -- The raw wasm ABI is a CommonJS build product whose directory is selected at runtime.
  ['wasm', require(resolve(directory, 'wasm/nodejs/content_address_core.js'))],
  // eslint-disable-next-line import/no-commonjs, import/no-dynamic-require -- The raw Node-API ABI is a CommonJS build product whose directory is selected at runtime.
  ['native', require(resolve(directory, 'native/index.cjs'))],
] as const) {
  assert.equal(api.hash(bytes), expected)
  const state = api.hasher()
  state.write(bytes.subarray(0, 1))
  state.write(bytes.subarray(1))
  assert.equal(state.finish(), expected)
  const reads: Array<readonly [string, string, number]> = []
  let yields = 0
  const job = api.hashTree(async (request: Interop.SourceRequest) => {
    if (request.kind === 'yield') {
      yields++
      await scheduler.yield()
      return Buffer.alloc(0)
    }
    assert.equal(request.kind, 'readRange', 'Rust byte engine uses bounded reads')
    if (request.kind !== 'readRange') throw new Error('Unexpected whole-file read')
    reads.push([request.path, request.offset, request.maxBytes])
    assert.ok(request.maxBytes > 0)
    const offset = BigInt(request.offset)
    const start = offset >= BigInt(bytes.length) ? bytes.length : Number(offset)
    return bytes.subarray(start, start + 1)
  }, records)
  assert.equal(job.mode, 'abortable')
  // eslint-disable-next-line no-await-in-loop -- Complete the raw wasm lifecycle before exercising the native product.
  assert.equal(await job.result, expectedTree)
  assert.deepEqual(reads.map(([path, offset]) => [path, offset]), [
    ['/host/file', '0'], ['/host/file', '1'], ['/host/file', '2'], ['/host/file', '3'],
  ])
  assert.equal(yields, 3, 'every nonempty CPU chunk yields to the host event loop')
  const descriptor = api.describe(bytes, 'text/plain')
  assert.equal(descriptor.digest, expected)
  assert.equal(descriptor.byteLength, 3)
  assert.equal(descriptor.mediaType, 'text/plain')
  assert.deepEqual(api.validateDescriptor(descriptor), descriptor)
  assert.deepEqual(
    ContractJson.encodeValue(Contracts.ContentDescriptor)(ContractJson.decodeValue(Contracts.ContentDescriptor)(descriptor)),
    descriptor,
  )
  assert.throws(() => api.describe(bytes, ' text/plain'))
  assert.throws(() => api.validateDescriptor({ ...descriptor, surprise: true }))
  assert.throws(() => api.validateDescriptor({ ...descriptor, digest: expected.toUpperCase() }))
  const rejected = api.hashTree(failedRead, records)
  // eslint-disable-next-line no-await-in-loop -- Verify read failure on each transport before its cancellation lifecycle.
  await assert.rejects(rejected.result, /host read failed/)
  const { promise: started, resolve: entered } = Promise.withResolvers<void>()
  const pending = api.hashTree(() => {
    entered()
    return unresolvedRead()
  }, records)
  const result = pending.result.catch(cancellationFailure)
  // eslint-disable-next-line no-await-in-loop -- Cancellation must wait until this transport's host read has entered.
  await started
  // eslint-disable-next-line no-await-in-loop -- Retire this transport's pending invocation before moving to the next product.
  await pending.cancel()
  // eslint-disable-next-line no-await-in-loop -- Observe cancellation completion before releasing this transport's raw lifecycle.
  assert.match(String(await result), /RUST_CANCELLED/)
  console.log(
    `${name} raw hash, streamed hash, ordered tree, descriptor validation, cancellation passed`,
  )
}
const readHostRange = Effect.fn('ContentAddressSmoke.readHostRange')((path: string, offset: bigint, maxBytes: number) =>
  Effect.sync(() => {
    assert.equal(path, '/host/file')
    assert.ok(maxBytes > 0)
    const start = offset >= BigInt(bytes.length) ? bytes.length : Number(offset)
    return bytes.subarray(start, start + 1)
  }),
)
const program = Effect.scoped(
  Effect.gen(function* () {
    const service = yield* ContentAddressCore
    assert.equal(yield* service.hash(bytes), expected)
    assert.equal(
      yield* Stream.run(
        Stream.fromArray([bytes.subarray(0, 1), bytes.subarray(1)]),
        service.hasher(),
      ),
      expected,
    )
    const source = yield* Interop.hostSource('abortable', {
      read: () => Effect.die('Rust byte engine must not read a whole file'),
      readRange: readHostRange,
    })
    assert.equal(yield* service.hashTree(source, records), expectedTree)
    const descriptor = yield* service.describe(bytes, 'text/plain')
    assert.deepEqual(yield* service.validateDescriptor(descriptor), descriptor)
    const invalid = yield* Effect.exit(service.describe(bytes, ' text/plain'))
    assert.ok(Exit.isFailure(invalid))
    const { promise: started, resolve: entered } = Promise.withResolvers<void>()
    let finalized = false
    const never = yield* Interop.hostSource('abortable', {
      read: () => Effect.die('Rust byte engine must not read a whole file'),
      readRange: () => Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            finalized = true
          }),
        )
        entered()
        return yield* Effect.never
      }),
    })
    const fiber = yield* Effect.forkChild(service.hashTree(never, records))
    yield* Effect.promise(() => started)
    yield* Fiber.interrupt(fiber)
    yield* never.quiesce
    assert.equal(finalized, true)
    assert.equal(yield* never.live, 0)
  }),
)
const runtime = process.versions.bun === undefined ? 'node' : 'bun'
const collectors = globalThis as typeof globalThis & {
  readonly Bun?: { readonly gc: (full: boolean) => void }
  readonly gc?: () => void
}
const collect = runtime === 'bun' ? () => collectors.Bun!.gc(true) : collectors.gc
assert.equal(typeof collect, 'function', 'Run Node with --expose-gc for the teardown regression')
for (const [name, layer] of [
  [`layerWasm.${runtime}`, ContentAddressCore.layerWasm[runtime]()],
  [`layerNative.${runtime}`, ContentAddressCore.layerNative[runtime]()],
] as const) {
  // eslint-disable-next-line no-await-in-loop -- Release the generated wasm Layer before starting the generated native Layer.
  await Effect.runPromise(program.pipe(Effect.provide(layer)))
  // A released lexical instance must remain safe when bindgen stream/closure finalizers run.
  collect!()
  // eslint-disable-next-line no-await-in-loop -- Drain each released Layer's bindgen finalizers before initializing the next transport.
  await scheduler.yield()
  console.log(`${name} generated Service, Sink, abortable Source, descriptors passed`)
}
if (process.env.RUST_INTEROP_SMOKE_OUTPUT !== undefined) {
  writeFileSync(
    process.env.RUST_INTEROP_SMOKE_OUTPUT,
    JSON.stringify({
      runtime,
      rawProducts: ['wasm/nodejs/content_address_core.js', 'native/index.cjs'],
      generatedProduct: 'dist/service.js',
      layers: [`layerWasm.${runtime}`, `layerNative.${runtime}`],
      contractSchema,
      forcedGc: true,
      cancellation: { raw: ['wasm', 'native'], generated: ['wasm', 'native'] },
      sourceFinalizer: true,
      sourceQuiescence: true,
    }) + '\n',
  )
}
