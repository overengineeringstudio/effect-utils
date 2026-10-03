import { describe, it } from '@effect/vitest'
import { Schema } from 'effect'
import { expect } from 'vitest'

import * as ContractJson from '../schema/contract-json.ts'
import * as EffectRust from '../schema/effect-rust.ts'
import { canonicalJson, parseJson } from '../schema/json.ts'
import { boundedContracts, boundedVectors } from './fixtures/bounded-contracts.ts'
import { contracts } from './fixtures/contracts.ts'
import vectors from './fixtures/vectors.json' with { type: 'json' }
import { importRustSchema } from './import-rust.ts'
import { emitJsonSchema } from './json-schema.ts'
import { AdmissionError, compile, lower, tagFields } from './mod.ts'

describe('shared R vectors', () => {
  const tags = tagFields(lower(contracts))
  for (const row of vectors)
    it(`${row.contract}/${row.name}`, () => {
      const schema = contracts[row.contract as keyof typeof contracts]
      const text = JSON.stringify(row.input)
      if (row.accept === false) {
        expect(() => ContractJson.decode(schema)(text)).toThrow()
        return
      }
      const value = ContractJson.decode(schema)(text)
      expect(ContractJson.encode(schema)(value)).toBe(
        canonicalJson('canonical' in row ? row.canonical : row.input, tags),
      )
    })
})

describe('bounded integer contracts', () => {
  for (const row of boundedVectors)
    it(`${row.contract}/${row.name}`, () => {
      const schema = boundedContracts[row.contract as keyof typeof boundedContracts]
      const decode = ContractJson.decode(schema)
      const text = JSON.stringify(row.input)
      if (row.accept === false) {
        expect(() => decode(text)).toThrow()
      } else {
        expect(ContractJson.encode(schema)(decode(text))).toBe(text)
      }
    })
  it('retains validation intervals and storage pins through interchange', () => {
    const ir = lower(boundedContracts, 'Percent')
    const imported = importRustSchema(emitJsonSchema(ir, 'Percent'))
    expect(imported.ir.defs).toEqual(ir.defs)
  })
  it('rejects an overflowing width pin and metadata on an opaque transformation', () => {
    expect(() =>
      lower({
        Value: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 256 })).annotate({
          [EffectRust.width]: 'u8',
        }),
      }),
    ).toThrow(AdmissionError)
    expect(() =>
      lower({
        Value: Schema.BigIntFromString.annotate({ [EffectRust.width]: 'u64' }),
      }),
    ).toThrow(AdmissionError)
  })
})

describe('live compiler admission', () => {
  it('retains wire policy annotations applied to suspended contracts', () => {
    const Deferred = Schema.suspend(() =>
      Schema.Struct({
        value: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 ** 32 - 1 })),
      }),
    ).annotate({
      [EffectRust.excess]: 'ignore',
      [EffectRust.nonExhaustive]: true,
    })
    expect(lower({ Deferred }).defs.Deferred).toMatchObject({
      kind: 'struct',
      excess: 'ignore',
      nonExhaustive: true,
    })
  })
  it('lowers recursive schemas rather than flattening live references', () => {
    const ir = lower(contracts)
    expect(ir.defs.Tree).toEqual({
      kind: 'struct',
      excess: 'error',
      fields: [
        { wire: 'label', type: { kind: 'string' }, presence: 'required' },
        {
          wire: 'children',
          type: { kind: 'array', item: { kind: 'ref', name: 'Tree' } },
          presence: 'required',
        },
      ],
    })
    expect(ir.defs.Expr?.kind).toBe('taggedUnion')
  })
  it('preserves the nominal identity of a suspended recursive root', () => {
    interface SuspendedTree {
      readonly label: string
      readonly children: readonly SuspendedTree[]
    }
    const Suspended: Schema.Codec<SuspendedTree> = Schema.suspend(() =>
      Schema.Struct({ label: Schema.String, children: Schema.Array(Suspended) }),
    )
    const ir = lower({ Suspended })
    expect(ir.defs).toEqual({
      Suspended: {
        kind: 'struct',
        excess: 'error',
        fields: [
          { wire: 'label', type: { kind: 'string' }, presence: 'required' },
          {
            wire: 'children',
            type: { kind: 'array', item: { kind: 'ref', name: 'Suspended' } },
            presence: 'required',
          },
        ],
      },
    })
  })
  it('retains every contract root when callers reuse a schema object', () => {
    const result = compile({ Text: Schema.String, Label: Schema.String })
    expect(result.ir.defs.Label).toEqual({ kind: 'alias', type: { kind: 'ref', name: 'Text' } })
    expect(parseJson(result.files['schema/Label.json']!)).toMatchObject({
      title: 'Label',
      $ref: '#/$defs/Label',
    })
    expect(parseJson(result.files['schema/Text.json']!)).toMatchObject({
      title: 'Text',
      $ref: '#/$defs/Text',
    })
  })
  it('rejects lossy or opaque contracts at the offending field', () => {
    const schemas = [
      Schema.Finite,
      Schema.Int,
      Schema.BigIntFromString,
      Schema.String.check(Schema.makeFilter((value: string) => value.length === 3)),
      Schema.String.check(Schema.isPattern(/^[a-z]+$/u)),
      Schema.BigInt,
      Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 2 })),
      Schema.Tuple([Schema.String, Schema.Boolean]),
    ]
    for (const schema of schemas) {
      try {
        lower({ Request: Schema.Struct({ value: schema }) })
        expect.fail('Expected admission rejection')
      } catch (error) {
        expect(error).toBeInstanceOf(AdmissionError)
        if (!(error instanceof AdmissionError)) return
        expect(error.path).toBe('$/Request/value')
      }
    }
  })
})
