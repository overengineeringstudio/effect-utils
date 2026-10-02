// Usage: bun rust/effect-rust-fixtures/service-smoke.ts <service-package-directory> <vectors.json>
// Exercises the generated EffectRustFixture service package: the Rust-owned contract
// codecs against the shared vectors (also run by the math-interop Rust tests), then
// the generated Context.Service class through both of its static Layers.
// `effect` and `@overeng/effect-rust` must resolve from this script and the package.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { DateTime, Effect, Exit, Schema } from 'effect'

import { Wire } from '@overeng/effect-rust'

const [directory, vectorsPath] = process.argv.slice(2)
assert.ok(
  directory !== undefined && vectorsPath !== undefined,
  'Pass the generated service package directory and the shared vectors file',
)
// The package under test is a build output, so its path is runtime-selected; its
// own types are checked by compiling the package, not through this script.
// eslint-disable-next-line import/no-dynamic-require -- Contract codecs are loaded from the runtime-selected generated Buck service package under test.
const Contracts = await import(resolve(directory, 'contracts.ts'))
// eslint-disable-next-line import/no-dynamic-require -- Service statics are loaded from the runtime-selected generated Buck service package under test.
const { EffectRustFixture, ArithmeticError } = await import(resolve(directory, 'service.ts'))

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
  const decode = () => Wire.decodeJson(codec)(JSON.stringify(vector.input))
  if (vector.accept === false) {
    assert.throws(decode, undefined, `${label} must be rejected`)
    continue
  }
  assert.equal(Wire.encodeJson(codec)(decode()), canonical(vector.canonical ?? vector.input), label)
}

const order = {
  id: 9007199254740993n,
  sku: 'ABC-1234',
  quantity: 3,
  unitPriceCents: 250n,
  placedAt: DateTime.makeUnsafe('2026-10-02T12:00:00.500Z'),
  note: { _tag: 'Value', value: 'gift' },
}
const program = Effect.gen(function* () {
  const fixture = yield* EffectRustFixture
  const quote = yield* fixture.quoteOrder(order, { kind: 'percent', percent: 10 })
  assert.equal(quote.kind, 'priced')
  assert.equal(quote.note, 'gift')
  assert.equal(quote.receipt.orderId, 9007199254740993n)
  assert.equal(quote.receipt.totalCents, 675n)
  assert.equal(DateTime.formatIso(quote.receipt.placedAt), '2026-10-02T12:00:00.500Z')
  const free = yield* fixture.quoteOrder(
    { ...order, note: { _tag: 'Null' } },
    { kind: 'fixed', amountCents: 18446744073709551615n },
  )
  assert.deepEqual(free, { kind: 'free', orderId: 9007199254740993n })
  // Contract encoding rejects the brand before Rust is called.
  const invalid = yield* Effect.exit(fixture.quoteOrder({ ...order, sku: 'abc' }, { kind: 'none' }))
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
    yield* fixture.sha256Hex(new TextEncoder().encode('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  )
  return quote.receipt.totalCents
})
const runtime = process.versions.bun === undefined ? 'node' : 'bun'
for (const [name, layer] of [
  [`layerWasm.${runtime}`, EffectRustFixture.layerWasm[runtime]({ panicPolicy: 'rebuild' })],
  [`layerNative.${runtime}`, EffectRustFixture.layerNative[runtime]()],
] as const) {
  // eslint-disable-next-line no-await-in-loop -- Verify and release the wasm runtime before starting native verification, preserving ordered fail-fast execution.
  const total = await Effect.runPromise(program.pipe(Effect.provide(layer)))
  console.log(`${name}: quoteOrder total ${total}`)
}
console.log(`${vectors.length} shared vectors agree; generated statics verified on ${runtime}`)
if (process.env.RUST_INTEROP_SMOKE_OUTPUT !== undefined) {
  writeFileSync(
    process.env.RUST_INTEROP_SMOKE_OUTPUT,
    JSON.stringify({ runtime, vectors: vectors.length, layers: ['wasm', 'native'] }) + '\n',
  )
}
