import { describe, it } from '@effect/vitest'
import { Schema } from 'effect'
import { expect } from 'vitest'

import * as Wire from '../schema/wire.ts'
import { AdmissionError, compile } from './mod.ts'

const Optional = Schema.Struct({
  required: Schema.String,
  field: Schema.optional(Schema.String),
  nullable: Schema.optional(Schema.NullOr(Schema.String)),
})

describe('schema-aware JSON omission', () => {
  it('compiles ordinary optional fields like optionalKey without widening null', () => {
    const ordinary = compile({ Request: Optional })
    const exact = compile({
      Request: Schema.Struct({
        required: Schema.String,
        field: Schema.optionalKey(Schema.String),
        nullable: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    })
    expect(ordinary.ir).toEqual(exact.ir)
    expect(Wire.parseJson(ordinary.files['schema/Request.json']!)).toEqual(
      Wire.parseJson(exact.files['schema/Request.json']!),
    )
    expect(ordinary.ir.defs.Request).toMatchObject({
      fields: [
        { wire: 'required', type: { kind: 'string' }, presence: 'required' },
        { wire: 'field', type: { kind: 'string' }, presence: 'optional' },
        {
          wire: 'nullable',
          type: { kind: 'nullable', inner: { kind: 'string' } },
          presence: 'optional',
        },
      ],
    })
  })

  it('serializes missing and own undefined as omission, retaining value and explicit null', () => {
    const encode = Wire.encodeJson(Optional)
    const missing = { required: 'r' }
    const ownUndefined = { required: 'r', field: undefined, nullable: undefined }
    expect(Wire.decode(Optional)(missing)).toEqual(missing)
    expect(Wire.decode(Optional)(ownUndefined)).toEqual(ownUndefined)
    expect(encode(missing)).toBe('{"required":"r"}')
    expect(encode(ownUndefined)).toBe('{"required":"r"}')
    expect(Object.hasOwn(ownUndefined, 'field')).toBe(true)
    expect(Wire.decodeJson(Optional)(encode(ownUndefined))).toEqual(missing)
    const present = { required: 'r', field: 'v', nullable: null }
    expect(Wire.decodeJson(Optional)(encode(present))).toEqual(present)
    expect(encode(present)).toBe('{"field":"v","nullable":null,"required":"r"}')
    expect(() => Wire.decodeJson(Optional)('{"required":"r","field":null}')).toThrow()
    expect(() => encode(Wire.decode(Optional)({ required: 'r', field: null }))).toThrow()
  })

  it('recurses through nested structs, array items, records and tagged union members', () => {
    const Item = Schema.Struct({ field: Schema.optional(Schema.String) })
    const Request = Schema.Struct({
      nested: Schema.optional(Item),
      items: Schema.Array(Item),
      records: Schema.Record(Schema.String, Item),
      tagged: Schema.Union([
        Schema.TaggedStruct('Item', { inner: Item }),
        Schema.TaggedStruct('Empty', {}),
      ]),
    })
    compile({ Request })
    const value = {
      nested: { field: undefined },
      items: [{ field: undefined }, { field: 'v' }],
      records: { entry: { field: undefined } },
      tagged: { _tag: 'Item' as const, inner: { field: undefined } },
    }
    const text = Wire.encodeJson(Request)(value)
    expect(text).toBe(
      '{"items":[{},{"field":"v"}],"nested":{},"records":{"entry":{}},"tagged":{"_tag":"Item","inner":{}}}',
    )
    expect(Wire.decodeJson(Request)(text)).toEqual({
      nested: {},
      items: [{}, { field: 'v' }],
      records: { entry: {} },
      tagged: { _tag: 'Item', inner: {} },
    })
    expect(value.items[0]).toEqual({ field: undefined })
  })

  it('keeps optionalKey and Patch missing/null/value semantics', () => {
    const Request = Schema.Struct({
      exact: Schema.optionalKey(Schema.NullOr(Schema.String)),
      patch: Wire.Patch(Schema.String),
    })
    compile({ Request })
    for (const [text, decoded] of [
      ['{}', { patch: { _tag: 'Absent' } }],
      ['{"exact":null,"patch":null}', { exact: null, patch: { _tag: 'Null' } }],
      ['{"exact":"v","patch":"p"}', { exact: 'v', patch: { _tag: 'Value', value: 'p' } }],
    ] as const) {
      expect(Wire.decodeJson(Request)(text)).toEqual(decoded)
      expect(Wire.encodeJson(Request)(decoded)).toBe(text)
    }
    expect(() => Wire.decode(Request)({ exact: undefined })).toThrow()
    expect(() => Wire.decode(Request)({ patch: undefined })).toThrow()
  })

  it('rejects undefined required keys, array elements and record values even when Effect accepts them', () => {
    const required = Schema.Struct({ value: Schema.UndefinedOr(Schema.String) })
    const array = Schema.Array(Schema.UndefinedOr(Schema.String))
    const record = Schema.Record(Schema.String, Schema.UndefinedOr(Schema.String))
    expect(() => Wire.encodeJson(required)({ value: undefined })).toThrow()
    expect(() => Wire.encodeJson(array)([undefined])).toThrow()
    expect(() => Wire.encodeJson(record)({ entry: undefined })).toThrow()
    expect(() => Wire.canonicalJson({ value: undefined })).toThrow()
    expect(() => Wire.decodeJson(Optional)('{}')).toThrow()
    expect(() => Wire.decode(Optional)({ required: undefined })).toThrow()
    for (const schema of [required, array, record])
      expect(() => compile({ Request: schema })).toThrow(AdmissionError)
    for (const schema of [
      Schema.Array(Schema.optional(Schema.String)),
      Schema.Record(Schema.String, Schema.optional(Schema.String)),
      Schema.Struct({ value: Schema.optional(Schema.Undefined) }),
    ])
      expect(() => compile({ Request: schema })).toThrow(AdmissionError)
  })
})
