import { describe, it } from '@effect/vitest'
import { Schema } from 'effect'
import { expect } from 'vitest'

import * as Wire from './wire.ts'

describe('Wire control plane', () => {
  it('preserves 64-bit boundaries with canonical decimal strings', () => {
    expect(Wire.decode(Wire.U64)('18446744073709551615')).toBe(18446744073709551615n)
    expect(Wire.encode(Wire.I64)(-9223372036854775808n)).toBe('-9223372036854775808')
    for (const value of ['00', '+1', '-0', '-1', '18446744073709551616', 1])
      expect(() => Wire.decode(Wire.U64)(value)).toThrow()
    for (const value of ['-0', '01', '-9223372036854775809'])
      expect(() => Wire.decode(Wire.I64)(value)).toThrow()
  })
  it('distinguishes omitted, null and present Patch fields', () => {
    const schema = Schema.Struct({ field: Wire.Patch(Wire.U64) })
    for (const [encoded, decoded] of [
      [{}, { field: { _tag: 'Absent' } }],
      [{ field: null }, { field: { _tag: 'Null' } }],
      [{ field: '5' }, { field: { _tag: 'Value', value: 5n } }],
    ] as const) {
      expect(Wire.decode(schema)(encoded)).toEqual(decoded)
      expect(Wire.encode(schema)(decoded)).toEqual(encoded)
    }
  })
  it('applies explicit nested excess-ignore without weakening strict siblings', () => {
    const ignored = Schema.Struct({ n: Wire.U8 }).annotate(Wire.excess('ignore'))
    const schema = Schema.Struct({ inner: ignored, strict: Schema.Struct({ n: Wire.U8 }) })
    expect(Wire.decode(schema)({ inner: { n: 1, ignored: 2 }, strict: { n: 3 } })).toEqual({
      inner: { n: 1 },
      strict: { n: 3 },
    })
    expect(() => Wire.decode(schema)({ inner: { n: 1 }, strict: { n: 3, extra: 4 } })).toThrow()
    const encodedInput = { n: 1, extra: 2 }
    expect(Wire.encode(ignored)(encodedInput)).toEqual({ n: 1 })
  })
  it('normalizes explicit-offset timestamps without losing submillisecond precision', () => {
    for (const input of ['2024-01-02T04:04:05.1+01:00', '2024-01-02T03:04:05.100000Z']) {
      expect(Wire.encode(Wire.TimestampMillis)(Wire.decode(Wire.TimestampMillis)(input))).toBe(
        '2024-01-02T03:04:05.100Z',
      )
    }
    for (const input of [
      '2024-02-30T00:00:00Z',
      '2024-01-02T03:04:05.0001Z',
      '2024-01-02T03:04:05',
      '2024-01-02T03:04:60Z',
    ])
      expect(() => Wire.decode(Wire.TimestampMillis)(input)).toThrow()
  })
  it('rejects duplicate keys, noncanonical ints, invalid Unicode and depth 129', () => {
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
      expect(() => Wire.parseJson(input)).toThrow()
    expect(Wire.parseJson('['.repeat(128) + '0' + ']'.repeat(128))).toBeDefined()
    expect(Wire.parseJson('{"__proto__":1}')).toEqual(JSON.parse('{"__proto__":1}'))
    expect(Wire.canonicalJson({ b: 2, _tag: 'T', a: { z: 0, a: 1 } })).toBe(
      '{"_tag":"T","a":{"a":1,"z":0},"b":2}',
    )
    expect(Wire.canonicalJson({ '1': 1, _tag: 'T' })).toBe('{"_tag":"T","1":1}')
  })
  it('decodes any key order and encodes each discriminator first, then sorted keys', () => {
    const Reason = Schema.Union([
      Schema.Struct({ kind: Schema.Literal('Timeout'), attempt: Wire.U8 }),
      Schema.Struct({ kind: Schema.Literal('Closed') }),
    ])
    const Envelope = Schema.Union([
      Schema.TaggedStruct('Failed', { reason: Reason, code: Wire.U8 }),
      Schema.TaggedStruct('Ok', {}),
    ])
    expect(Wire.tagKeys(Envelope.ast)).toEqual(['_tag', 'kind'])
    const canonical = '{"_tag":"Failed","code":1,"reason":{"kind":"Timeout","attempt":5}}'
    for (const text of [
      canonical,
      '{"reason":{"attempt":5,"kind":"Timeout"},"code":1,"_tag":"Failed"}',
      '{"code":1,"_tag":"Failed","reason":{"attempt":5,"kind":"Timeout"}}',
    ]) {
      expect(Wire.encodeJson(Envelope)(Wire.decodeJson(Envelope)(text))).toBe(canonical)
    }
    expect(() =>
      Wire.decodeJson(Envelope)('{"code":1,"reason":{"kind":"Closed"},"_tag":"Unknown"}'),
    ).toThrow()
  })
  it('rejects engine-specific regex features and terminal-newline ambiguity', () => {
    for (const source of ['a', '^(?=a)a$', '^(a)\\1$', '^\\d+$', '^.$', '^[a&&b]+$'])
      expect(() => Wire.pattern(source)).toThrow()
    const schema = Schema.String.check(Wire.pattern('^abc$', 'iu'))
    expect(Wire.decode(schema)('ABC')).toBe('ABC')
    expect(() => Wire.decode(schema)('abc\n')).toThrow()
  })
})

describe('Wire Borsh frames', () => {
  const schema = Schema.Struct({ n: Wire.U16, text: Schema.String, counter: Wire.U64 })
  const codec = Wire.frame(schema, { contractId: 0x12345678, version: 2 })
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
  it('validates refinements by default and exposes explicit trusted bypass', () => {
    const constrained = Schema.String.check(Wire.pattern('^[a-z]+$')).annotate({
      identifier: 'Name',
    })
    const framed = Wire.frame(Schema.Struct({ name: constrained }), { contractId: 1, version: 1 })
    expect(() => framed.encode({ name: 'BAD' })).toThrow()
    const bytes = framed.trusted.encode({ name: 'BAD' })
    expect(() => framed.decode(bytes)).toThrow()
    expect(framed.trusted.decode(bytes)).toEqual({ name: 'BAD' })
  })
  it('preserves Patch and Rust Unicode map ordering in Borsh', () => {
    const codec = Wire.frame(
      Schema.Struct({ field: Wire.Patch(Wire.U32), map: Schema.Record(Schema.String, Wire.U8) }),
      { contractId: 3, version: 1 },
    )
    const value = { field: { _tag: 'Absent' as const }, map: { '\u{10000}': 1, '\ue000': 2 } }
    expect(codec.decode(codec.encode(value))).toEqual(value)
    expect(codec.trusted.decode(codec.trusted.encode(value))).toEqual(value)
  })
  it('retains typed timestamp milliseconds on validated and trusted binary paths', () => {
    const framed = Wire.frame(Wire.TimestampMillis, { contractId: 4, version: 1 })
    const value = Wire.decode(Wire.TimestampMillis)('2024-01-02T04:04:05.12+01:00')
    const bytes = framed.encode(value)
    expect(Wire.encode(Wire.TimestampMillis)(framed.decode(bytes))).toBe('2024-01-02T03:04:05.120Z')
    expect(Wire.encode(Wire.TimestampMillis)(framed.trusted.decode(bytes))).toBe(
      '2024-01-02T03:04:05.120Z',
    )
    expect(framed.trusted.encode(value)).toEqual(bytes)
  })
  it('checks column widths and row-count alignment', () => {
    const columns = Wire.columns({ id: 'u64', count: 'u16' })
    const value = columns.allocate(3)
    expect(value.id).toBeInstanceOf(BigUint64Array)
    columns.validate(value)
    expect(() =>
      columns.validate({ id: new BigUint64Array(2), count: new Uint16Array(3) }),
    ).toThrow()
    expect(() => columns.validate({ id: new Uint32Array(3), count: new Uint16Array(3) })).toThrow()
  })
})
