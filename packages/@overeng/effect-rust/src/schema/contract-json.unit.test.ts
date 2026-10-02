import { describe, it } from '@effect/vitest'
import { DateTime, Effect, Schema, SchemaTransformation } from 'effect'
import { expect, expectTypeOf } from 'vitest'

import * as Borsh from './borsh.ts'
import * as Columns from './columns.ts'
import * as ContractJson from './contract-json.ts'
import * as EffectRust from './effect-rust.ts'

const unsigned64 = Schema.BigInt.check(
  Schema.isBetweenBigInt({ minimum: 0n, maximum: 18446744073709551615n }),
)
const signed64 = Schema.BigInt.check(
  Schema.isBetweenBigInt({ minimum: -9223372036854775808n, maximum: 9223372036854775807n }),
)
const unsigned8 = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))
const unsigned16 = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 }))
const unsigned32 = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4294967295 }))
const timestamp = Schema.DateTimeUtc.annotate({ [EffectRust.timestampPrecision]: 'millis' })

describe('ContractJson control plane', () => {
  it('preserves authored 64-bit domain types with canonical decimal strings', () => {
    const codec = ContractJson.codec(unsigned64)
    expectTypeOf<typeof codec.Type>().toEqualTypeOf<typeof unsigned64.Type>()
    expectTypeOf<typeof codec.Encoded>().toEqualTypeOf<string>()
    expect(Schema.decodeUnknownSync(codec)('"18446744073709551615"')).toBe(18446744073709551615n)
    expect(Schema.encodeSync(ContractJson.codec(signed64))(-9223372036854775808n)).toBe(
      '"-9223372036854775808"',
    )
    expect(Effect.runSync(Schema.decodeUnknownEffect(codec)('"5"'))).toBe(5n)
    expect(Effect.runSync(Schema.encodeEffect(codec)(5n))).toBe('"5"')
    for (const value of ['"00"', '"+1"', '"-0"', '"-1"', '"18446744073709551616"', '1'])
      expect(() => Schema.decodeUnknownSync(codec)(value)).toThrow()
    for (const value of ['"-0"', '"01"', '"-9223372036854775809"'])
      expect(() => ContractJson.decode(signed64)(value)).toThrow()
  })
  it('preserves raw omitted, null and present Patch fields', () => {
    const schema = Schema.Struct({ field: Schema.optionalKey(Schema.NullOr(unsigned64)) })
    const codec = ContractJson.codec(schema)
    expectTypeOf<typeof codec.Type>().toEqualTypeOf<typeof schema.Type>()
    for (const [text, value] of [
      ['{}', {}],
      ['{"field":null}', { field: null }],
      ['{"field":"5"}', { field: 5n }],
    ] as const) {
      expect(Schema.decodeUnknownSync(codec)(text)).toEqual(value)
      expect(Schema.encodeSync(codec)(value)).toBe(text)
    }
    expect(() => Schema.encodeUnknownSync(codec)({ field: undefined })).toThrow()
  })
  it('applies explicit nested excess-ignore without weakening strict siblings', () => {
    const ignored = Schema.Struct({ n: unsigned8 }).annotate({ [EffectRust.excess]: 'ignore' })
    const schema = Schema.Struct({ inner: ignored, strict: Schema.Struct({ n: unsigned8 }) })
    const codec = ContractJson.codec(schema)
    expect(
      Schema.decodeUnknownSync(codec)('{"inner":{"n":1,"ignored":2},"strict":{"n":3}}'),
    ).toEqual({ inner: { n: 1 }, strict: { n: 3 } })
    expect(() =>
      Schema.decodeUnknownSync(codec)('{"inner":{"n":1},"strict":{"n":3,"extra":4}}'),
    ).toThrow()
    expect(Schema.encodeUnknownSync(ContractJson.codec(ignored))({ n: 1, extra: 2 })).toBe(
      '{"n":1}',
    )
  })
  it('omits undefined only on optional properties, not required fields or records', () => {
    const schema = Schema.Struct({
      optional: Schema.optional(Schema.String),
      required: Schema.String,
      values: Schema.Record(Schema.String, Schema.String),
    })
    const codec = ContractJson.codec(schema)
    expect(Schema.encodeSync(codec)({ optional: undefined, required: 'ok', values: {} })).toBe(
      '{"required":"ok","values":{}}',
    )
    expect(() => Schema.encodeUnknownSync(codec)({ required: undefined, values: {} })).toThrow()
    expect(() =>
      Schema.encodeUnknownSync(codec)({ required: 'ok', values: { missing: undefined } }),
    ).toThrow()
    expect(() =>
      Schema.encodeUnknownSync(codec)({ optional: null, required: 'ok', values: {} }),
    ).toThrow()
  })
  it('normalizes strict millisecond timestamps and keeps DateTimeUtc values', () => {
    const codec = ContractJson.codec(timestamp)
    expectTypeOf<typeof codec.Type>().toEqualTypeOf<DateTime.Utc>()
    for (const input of ['2024-01-02T04:04:05.1+01:00', '2024-01-02T03:04:05.100000Z']) {
      const value = Schema.decodeUnknownSync(codec)(JSON.stringify(input))
      expect(DateTime.isUtc(value)).toBe(true)
      expect(Schema.encodeSync(codec)(value)).toBe('"2024-01-02T03:04:05.100Z"')
    }
    for (const input of [
      '2024-02-30T00:00:00Z',
      '2024-01-02T03:04:05.0001Z',
      '2024-01-02T03:04:05',
      '2024-01-02T03:04:60Z',
    ])
      expect(() => Schema.decodeUnknownSync(codec)(JSON.stringify(input))).toThrow()
  })
  it('does not authorize opaque transformations using metadata', () => {
    const opaque = Schema.String.pipe(
      Schema.decodeTo(
        Schema.String,
        SchemaTransformation.transform({
          decode: (value) => value.toUpperCase(),
          encode: (value) => value.toLowerCase(),
        }),
      ),
    ).annotate({ [EffectRust.width]: 'u64', [EffectRust.timestampPrecision]: 'millis' })
    expect(() => ContractJson.codec(opaque)).toThrow()
  })
  it('rejects duplicate keys, noncanonical integers, invalid Unicode and depth 129', () => {
    for (const input of [
      '{"a":1,"a":2}',
      '{"a":1,"\\u0061":2}',
      '-0',
      '1.0',
      '1e0',
      '9007199254740992',
      '"\\ud800"',
      '['.repeat(129) + '0' + ']'.repeat(129),
    ])
      expect(() => ContractJson.parseJson(input)).toThrow()
    expect(ContractJson.parseJson('['.repeat(128) + '0' + ']'.repeat(128))).toBeDefined()
    expect(ContractJson.parseJson('{"__proto__":1}')).toEqual(JSON.parse('{"__proto__":1}'))
    expect(ContractJson.canonicalJson({ b: 2, _tag: 'T', a: { z: 0, a: 1 } })).toBe(
      '{"_tag":"T","a":{"a":1,"z":0},"b":2}',
    )
    expect(ContractJson.canonicalJson({ '1': 1, _tag: 'T' })).toBe('{"_tag":"T","1":1}')
  })
  it('accepts any key order and emits nested discriminators before sorted keys', () => {
    const reason = Schema.Union([
      Schema.Struct({ kind: Schema.Literal('Timeout'), attempt: unsigned8 }),
      Schema.Struct({ kind: Schema.Literal('Closed') }),
    ])
    const envelope = Schema.Union([
      Schema.TaggedStruct('Failed', { reason, code: unsigned8 }),
      Schema.TaggedStruct('Ok', {}),
    ])
    expect(ContractJson.tagKeys(envelope.ast)).toEqual(['_tag', 'kind'])
    const canonical = '{"_tag":"Failed","code":1,"reason":{"kind":"Timeout","attempt":5}}'
    for (const text of [
      canonical,
      '{"reason":{"attempt":5,"kind":"Timeout"},"code":1,"_tag":"Failed"}',
      '{"code":1,"_tag":"Failed","reason":{"attempt":5,"kind":"Timeout"}}',
    ])
      expect(ContractJson.encode(envelope)(ContractJson.decode(envelope)(text))).toBe(canonical)
    expect(() =>
      ContractJson.decode(envelope)('{"code":1,"reason":{"kind":"Closed"},"_tag":"Unknown"}'),
    ).toThrow()
  })
  it('rejects engine-specific regex features and terminal-newline ambiguity', () => {
    for (const source of ['a', '^(?=a)a$', '^(a)\\1$', '^\\d+$', '^.$', '^[a&&b]+$'])
      expect(() => EffectRust.pattern(source)).toThrow()
    const schema = Schema.String.check(EffectRust.pattern('^abc$', 'iu'))
    expect(ContractJson.decode(schema)('"ABC"')).toBe('ABC')
    expect(() => ContractJson.decode(schema)('"abc\\n"')).toThrow()
  })
})

describe('Borsh frames and Columns', () => {
  const schema = Schema.Struct({ n: unsigned16, text: Schema.String, counter: unsigned64 })
  const codec = Borsh.frame(schema, { contractId: 0x12345678, version: 2 })
  it('matches fixed little-endian header and Borsh field layout', () => {
    const bytes = codec.encode({ n: 258, text: 'x', counter: 3n })
    expect(Array.from(bytes)).toEqual([
      120, 86, 52, 18, 2, 0, 2, 1, 1, 0, 0, 0, 120, 3, 0, 0, 0, 0, 0, 0, 0,
    ])
    expect(codec.decode(bytes)).toEqual({ n: 258, text: 'x', counter: 3n })
    expect(codec.trusted.decode(bytes)).toEqual({ n: 258, text: 'x', counter: 3n })
    for (const bytes of [
      new Uint8Array(5),
      new Uint8Array([0, 0, 0, 0, 2, 0]),
      new Uint8Array([...codec.encode({ n: 1, text: '', counter: 0n }), 0]),
    ])
      expect(() => codec.decode(bytes)).toThrow()
  })
  it('infers smallest signed widths and honors a wider layout pin', () => {
    const small = Schema.Int.check(Schema.isBetween({ minimum: -12, maximum: 12 }))
    const inferred = Borsh.frame(small, { contractId: 1, version: 1 })
    const pinned = Borsh.frame(small.annotate({ [EffectRust.width]: 'i16' }), {
      contractId: 1,
      version: 2,
    })
    expect(Array.from(inferred.encode(-12))).toEqual([1, 0, 0, 0, 1, 0, 244])
    expect(Array.from(pinned.encode(-12))).toEqual([1, 0, 0, 0, 2, 0, 244, 255])
    expect(() => pinned.decode(inferred.encode(-12))).toThrow()
    expect(() => inferred.encode(13)).toThrow()
    expect(() => inferred.decode(inferred.trusted.encode(13))).toThrow()
  })
  it('validates refinements by default and exposes explicit trusted bypass', () => {
    const constrained = Schema.String.check(EffectRust.pattern('^[a-z]+$')).annotate({
      identifier: 'Name',
    })
    const framed = Borsh.frame(Schema.Struct({ name: constrained }), { contractId: 1, version: 1 })
    expect(() => framed.encode({ name: 'BAD' })).toThrow()
    const bytes = framed.trusted.encode({ name: 'BAD' })
    expect(() => framed.decode(bytes)).toThrow()
    expect(framed.trusted.decode(bytes)).toEqual({ name: 'BAD' })
  })
  it('preserves raw Patch states and Rust Unicode map ordering', () => {
    const codec = Borsh.frame(
      Schema.Struct({
        field: Schema.optionalKey(Schema.NullOr(unsigned32)),
        map: Schema.Record(Schema.String, unsigned8),
      }),
      { contractId: 3, version: 1 },
    )
    for (const patch of [{}, { field: null }, { field: 42 }] as const) {
      const value = { ...patch, map: { '\u{10000}': 1, '\ue000': 2 } }
      expect(codec.decode(codec.encode(value))).toEqual(value)
      expect(codec.trusted.decode(codec.trusted.encode(value))).toEqual(value)
    }
  })
  it('retains typed timestamps on checked and trusted binary paths', () => {
    const framed = Borsh.frame(timestamp, { contractId: 4, version: 1 })
    const value = ContractJson.decode(timestamp)('"2024-01-02T04:04:05.12+01:00"')
    const bytes = framed.encode(value)
    expect(ContractJson.encode(timestamp)(framed.decode(bytes))).toBe('"2024-01-02T03:04:05.120Z"')
    expect(ContractJson.encode(timestamp)(framed.trusted.decode(bytes))).toBe(
      '"2024-01-02T03:04:05.120Z"',
    )
    expect(framed.trusted.encode(value)).toEqual(bytes)
  })
  it('preserves safe-number JSON semantics with numeric 64-bit binary storage', () => {
    const safe = Schema.Int.check(
      Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    )
    const framed = Borsh.frame(safe, { contractId: 5, version: 1 })
    const bytes = framed.encode(Number.MAX_SAFE_INTEGER)
    expect(Array.from(bytes)).toEqual([5, 0, 0, 0, 1, 0, 255, 255, 255, 255, 255, 255, 31, 0])
    expect(framed.decode(bytes)).toBe(Number.MAX_SAFE_INTEGER)
    expect(framed.trusted.decode(bytes)).toBe(Number.MAX_SAFE_INTEGER)
    expect(ContractJson.encode(safe)(Number.MAX_SAFE_INTEGER)).toBe('9007199254740991')
    expect(ContractJson.encode(unsigned64)(9007199254740991n)).toBe('"9007199254740991"')
    const unsafe = new Uint8Array([5, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 32, 0])
    expect(() => framed.decode(unsafe)).toThrow()
    expect(() => framed.trusted.decode(unsafe)).toThrow()
    expect(() => framed.trusted.encode(Number.MAX_SAFE_INTEGER + 1)).toThrow()
    const signed = Schema.Int.check(
      Schema.isBetween({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
    )
    const signedFrame = Borsh.frame(signed, { contractId: 6, version: 1 })
    expect(signedFrame.decode(signedFrame.encode(Number.MIN_SAFE_INTEGER))).toBe(
      Number.MIN_SAFE_INTEGER,
    )
    const columns = Columns.make(Schema.Struct({ count: safe, delta: signed, counter: unsigned64 }))
    columns.validate({
      count: new BigUint64Array([9007199254740991n]),
      delta: new BigInt64Array([-9007199254740991n]),
      counter: new BigUint64Array([18446744073709551615n]),
    })
    expect(() =>
      columns.validate({
        count: new BigUint64Array([9007199254740992n]),
        delta: new BigInt64Array([-9007199254740991n]),
        counter: new BigUint64Array([18446744073709551615n]),
      }),
    ).toThrow()
    expect(() =>
      columns.validate({
        count: new BigUint64Array([9007199254740991n]),
        delta: new BigInt64Array([-9007199254740992n]),
        counter: new BigUint64Array([18446744073709551615n]),
      }),
    ).toThrow()
  })
  it('derives column widths and validates row alignment and semantic bounds', () => {
    const columns = Columns.make(Schema.Struct({ id: unsigned64, count: unsigned16 }))
    const value = columns.allocate(3)
    expect(value.id).toBeInstanceOf(BigUint64Array)
    columns.validate(value)
    expect(() =>
      columns.validate({ id: new BigUint64Array(2), count: new Uint16Array(3) }),
    ).toThrow()
    expect(() => columns.validate({ id: new Uint32Array(3), count: new Uint16Array(3) })).toThrow()
    const signed = Columns.make(
      Schema.Struct({ delta: Schema.Int.check(Schema.isBetween({ minimum: -12, maximum: 12 })) }),
    )
    expect(signed.allocate(1).delta).toBeInstanceOf(Int8Array)
    expect(() => signed.validate({ delta: new Int8Array([13]) })).toThrow()
    expect(() => Columns.make(Schema.Struct({ optional: Schema.optionalKey(unsigned8) }))).toThrow()
  })
})
