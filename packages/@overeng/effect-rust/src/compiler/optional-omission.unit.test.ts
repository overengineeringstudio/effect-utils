import { describe, it } from '@effect/vitest'
import { Schema } from 'effect'
import { expect } from 'vitest'

import * as ContractJson from '../schema/contract-json.ts'
import { canonicalJson, parseJson } from '../schema/json.ts'
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
    expect(parseJson(ordinary.files['schema/Request.json']!)).toEqual(
      parseJson(exact.files['schema/Request.json']!),
    )
    expect(ordinary.ir.defs.Request).toMatchObject({
      fields: [
        { wire: 'required', type: { kind: 'string' }, presence: 'required' },
        { wire: 'field', type: { kind: 'string' }, presence: 'optional' },
        {
          wire: 'nullable',
          type: { kind: 'patch', inner: { kind: 'string' } },
          presence: 'optional',
        },
      ],
    })
  })

  it('serializes missing and own undefined as omission, retaining value and explicit null', () => {
    const encode = ContractJson.encode(Optional)
    const missing = { required: 'r' }
    const ownUndefined = { required: 'r', field: undefined, nullable: undefined }
    expect(encode(missing)).toBe('{"required":"r"}')
    expect(encode(ownUndefined)).toBe('{"required":"r"}')
    expect(Object.hasOwn(ownUndefined, 'field')).toBe(true)
    expect(ContractJson.decode(Optional)(encode(ownUndefined))).toEqual(missing)
    const present = { required: 'r', field: 'v', nullable: null }
    expect(ContractJson.decode(Optional)(encode(present))).toEqual(present)
    expect(encode(present)).toBe('{"field":"v","nullable":null,"required":"r"}')
    expect(() => ContractJson.decode(Optional)('{"required":"r","field":null}')).toThrow()
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
    const text = ContractJson.encode(Request)(value)
    expect(text).toBe(
      '{"items":[{},{"field":"v"}],"nested":{},"records":{"entry":{}},"tagged":{"_tag":"Item","inner":{}}}',
    )
    expect(ContractJson.decode(Request)(text)).toEqual({
      nested: {},
      items: [{}, { field: 'v' }],
      records: { entry: {} },
      tagged: { _tag: 'Item', inner: {} },
    })
    expect(value.items[0]).toEqual({ field: undefined })
  })

  it('keeps raw optional nullable fields absent, null or valued without a TypeScript ADT', () => {
    const Request = Schema.Struct({
      exact: Schema.optionalKey(Schema.NullOr(Schema.String)),
      patch: Schema.optionalKey(Schema.NullOr(Schema.String)),
    })
    compile({ Request })
    for (const [text, decoded] of [
      ['{}', {}],
      ['{"exact":null,"patch":null}', { exact: null, patch: null }],
      ['{"exact":"v","patch":"p"}', { exact: 'v', patch: 'p' }],
    ] as const) {
      expect(ContractJson.decode(Request)(text)).toEqual(decoded)
      expect(ContractJson.encode(Request)(decoded)).toBe(text)
    }
  })

  it('rejects undefined required keys, array elements and record values even when Effect accepts them', () => {
    const required = Schema.Struct({ value: Schema.UndefinedOr(Schema.String) })
    const array = Schema.Array(Schema.UndefinedOr(Schema.String))
    const record = Schema.Record(Schema.String, Schema.UndefinedOr(Schema.String))
    expect(() => ContractJson.encode(required)({ value: undefined })).toThrow()
    expect(() => ContractJson.encode(array)([undefined])).toThrow()
    expect(() => ContractJson.encode(record)({ entry: undefined })).toThrow()
    expect(() => canonicalJson({ value: undefined })).toThrow()
    expect(() => ContractJson.decode(Optional)('{}')).toThrow()
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
