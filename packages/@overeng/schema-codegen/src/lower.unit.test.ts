import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { AdmissionError, lower } from './mod.ts'

const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))

describe('shared schema admission', () => {
  it('keeps the default Rust profile and omits opt-in documentation metadata', () => {
    const Item = Schema.Struct({ count: Count }).annotate({ description: 'An item.' })
    expect(lower({ Item })).toEqual({
      irVersion: 1,
      contract: 'contracts',
      defs: {
        Item: {
          kind: 'struct',
          excess: 'error',
          fields: [{ wire: 'count', type: { kind: 'int', width: 'u8' }, presence: 'required' }],
        },
      },
    })
    // @effect-diagnostics-next-line schemaNumber:off -- deliberately verifies rejection of the broad number AST in the default Rust profile
    expect(() => lower({ Value: Schema.Number })).toThrow(AdmissionError)
    expect(() => lower({ Value: Schema.Int })).toThrow(AdmissionError)
  })

  it('carries documentation only when requested by an emitter', () => {
    const Item = Schema.Struct({
      count: Count.annotate({ description: 'Number of items.' }),
    }).annotate({ description: 'An item.' })
    const ir = lower({ Item }, 'example', { descriptions: true })
    expect(ir.defs.Item?.description).toBe('An item.')
    const item = ir.defs.Item
    expect(item?.kind === 'struct' ? item.fields[0]?.description : undefined).toBe(
      'Number of items.',
    )
  })

  it('admits binary64 and safe integer scalars only in the Swift JSON profile', () => {
    // @effect-diagnostics-next-line schemaNumber:off -- deliberately exercises the Swift profile's admission of the broad number AST; emitted scalar validation rejects non-finite values
    const ir = lower({ Value: Schema.Number, Count: Schema.Int }, 'example', { profile: 'swift' })
    expect(ir.defs.Value).toEqual({ kind: 'alias', type: { kind: 'f64' } })
    expect(ir.defs.Count).toEqual({ kind: 'alias', type: { kind: 'int', width: 'i64' } })
  })

  it('keeps optional keys distinct from required-nullable values', () => {
    const Row = Schema.Struct({
      required: Schema.NullOr(Schema.String),
      optional: Schema.optionalKey(Schema.String),
      patch: Schema.optionalKey(Schema.NullOr(Schema.String)),
    })
    const row = lower({ Row }).defs.Row
    expect(row?.kind === 'struct' ? row.fields : undefined).toEqual([
      {
        wire: 'required',
        type: { kind: 'nullable', inner: { kind: 'string' } },
        presence: 'required',
      },
      { wire: 'optional', type: { kind: 'string' }, presence: 'optional' },
      { wire: 'patch', type: { kind: 'patch', inner: { kind: 'string' } }, presence: 'optional' },
    ])
  })
})
