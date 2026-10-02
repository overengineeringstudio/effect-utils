import { describe, it } from '@effect/vitest'
import { Schema } from 'effect'
import { expect } from 'vitest'
import * as Wire from '../schema/wire.ts'
import { contracts } from './fixtures/contracts.ts'
import vectors from './fixtures/vectors.json'
import { AdmissionError, compile, lower, tagFields } from './mod.ts'

describe('shared R vectors', () => {
  const tags = tagFields(lower(contracts))
  for (const row of vectors) it(`${row.contract}/${row.name}`, () => {
    const schema = contracts[row.contract as keyof typeof contracts]
    const text = JSON.stringify(row.input)
    if (!row.accept) { expect(() => Wire.decodeJson(schema)(text)).toThrow(); return }
    const value = Wire.decodeJson(schema)(text)
    expect(Wire.encodeJson(schema)(value)).toBe(Wire.canonicalJson('canonical' in row ? row.canonical : row.input, tags))
  })
})

describe('live compiler admission', () => {
  it('lowers recursive schemas rather than flattening live references', () => {
    const ir = lower(contracts)
    expect(ir.defs.Tree).toEqual({ kind: 'struct', excess: 'error', fields: [
      { wire: 'label', type: { kind: 'string' }, presence: 'required' },
      { wire: 'children', type: { kind: 'array', item: { kind: 'ref', name: 'Tree' } }, presence: 'required' },
    ] })
    expect(ir.defs.Expr?.kind).toBe('taggedUnion')
  })
  it('preserves the nominal identity of a suspended recursive root', () => {
    interface SuspendedTree { readonly label: string; readonly children: readonly SuspendedTree[] }
    const Suspended: Schema.Codec<SuspendedTree> = Schema.suspend(() => Schema.Struct({ label: Schema.String, children: Schema.Array(Suspended) }))
    const ir = lower({ Suspended })
    expect(ir.defs).toEqual({ Suspended: { kind: 'struct', excess: 'error', fields: [
      { wire: 'label', type: { kind: 'string' }, presence: 'required' },
      { wire: 'children', type: { kind: 'array', item: { kind: 'ref', name: 'Suspended' } }, presence: 'required' },
    ] } })
  })
  it('retains every contract root when callers reuse a schema object', () => {
    const result = compile({ Text: Schema.String, Label: Schema.String })
    expect(result.ir.defs.Label).toEqual({ kind: 'alias', type: { kind: 'ref', name: 'Text' } })
    expect(Wire.parseJson(result.files['schema/Label.json']!)).toMatchObject({ title: 'Label', $ref: '#/$defs/Label' })
    expect(Wire.parseJson(result.files['schema/Text.json']!)).toMatchObject({ title: 'Text', $ref: '#/$defs/Text' })
  })
  it('rejects lossy or opaque contracts with a field path and remedy', () => {
    const schemas = [Schema.Number, Schema.Int, Schema.BigIntFromString, Schema.String.check(Schema.makeFilter((value: string) => value.length === 3)), Schema.String.check(Wire.pattern('^[a-z]+$')), Schema.String.check(Schema.isPattern(/^[a-z]+$/u)).annotate({ identifier: 'UnsafeEndAnchor' }), Wire.Patch(Schema.NullOr(Schema.String)), Wire.Patch(Schema.optionalKey(Schema.String)), Schema.Tuple([Wire.U8, Wire.U16])]
    for (const schema of schemas) {
      try { lower({ Request: Schema.Struct({ value: schema }) }); expect.fail('Expected admission rejection') }
      catch (error) { expect(error).toBeInstanceOf(AdmissionError); expect((error as AdmissionError).path).toBe('$/Request/value'); expect((error as AdmissionError).remedy).toMatch(/.+/) }
    }
  })
  it('emits deterministic byte-identical Rust, JSON, Effect, Borsh and vector artifacts', () => {
    const options = { crateName: 'compiler_golden', vectors, frames: { Event: { contractId: 7, version: 1 } } }
    expect(compile(contracts, options)).toEqual(compile(contracts, options))
  })
  it('matches the compiler golden for a tagged contract with semantic widths and Patch', () => {
    const schemas = { Response: Schema.Union([
      Schema.TaggedStruct('Ok', { count: Wire.U32, id: Wire.U64, change: Wire.Patch(Schema.String) }),
      Schema.TaggedStruct('Missing', {}),
    ]) }
    expect(compile(schemas, { crateName: 'golden', frames: { Response: { contractId: 9, version: 1 } } })).toMatchSnapshot()
  })
})
