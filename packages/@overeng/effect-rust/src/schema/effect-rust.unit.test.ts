import { describe, it } from '@effect/vitest'
import { Schema, SchemaTransformation } from 'effect'
import { expect } from 'vitest'

import { importRustSchema } from '../compiler/import-rust.ts'
import { emitJsonSchema } from '../compiler/json-schema.ts'
import { AdmissionError, lower } from '../compiler/mod.ts'
import * as ContractJson from './contract-json.ts'
import * as EffectRust from './effect-rust.ts'

// These are the exact expressions emitted for a transparent Rust f32 newtype
// and a required Option<Newtype> field, respectively.
const FiniteScore = EffectRust.F32.annotate({ identifier: 'FiniteScore' })
const Sample = Schema.Struct({ score: Schema.Union([Schema.Null, FiniteScore]) })

describe('registered codec aliases', () => {
  it('admits a named binary32 alias standalone', () => {
    expect(lower({ FiniteScore }).defs.FiniteScore).toEqual({
      kind: 'alias',
      type: { kind: 'f32' },
    })
    expect(ContractJson.decode(FiniteScore)('0.1')).toBe(Math.fround(0.1))
  })

  it('admits a named binary32 alias in a required nullable field', () => {
    expect(lower({ Sample }).defs.Sample).toMatchObject({
      kind: 'struct',
      fields: [
        {
          wire: 'score',
          presence: 'required',
          type: { kind: 'nullable', inner: { kind: 'f32' } },
        },
      ],
    })
    expect(ContractJson.decode(Sample)('{"score":0.1}')).toEqual({ score: Math.fround(0.1) })
    expect(ContractJson.decode(Sample)('{"score":null}')).toEqual({ score: null })
    expect(() => ContractJson.decode(Sample)('{}')).toThrow(Schema.SchemaError)
  })

  it('keeps the generator own named binary32 expression', () => {
    const generated = importRustSchema(
      emitJsonSchema(
        {
          irVersion: 1,
          contract: 'Sample',
          defs: {
            FiniteScore: { kind: 'alias', type: { kind: 'f32' } },
            Sample: {
              kind: 'struct',
              excess: 'error',
              fields: [
                {
                  wire: 'score',
                  presence: 'required',
                  type: { kind: 'nullable', inner: { kind: 'ref', name: 'FiniteScore' } },
                },
              ],
            },
          },
        },
        'Sample',
      ),
    )
    expect(generated.source).toContain(
      'export const FiniteScore = EffectRust.F32.annotate({ identifier: "FiniteScore" })',
    )
    expect(generated.source).toContain('Schema.Union([Schema.Null, FiniteScore])')
  })

  it('admits repeatedly annotated timestamp aliases', () => {
    const Timestamp = Schema.DateTimeUtc.annotate({
      [EffectRust.timestampPrecision]: 'millis',
    }).annotate({ identifier: 'Timestamp' })
    expect(lower({ Timestamp }).defs.Timestamp).toEqual({
      kind: 'alias',
      type: { kind: 'dateTime' },
    })
    expect(
      lower({ Sample: Schema.Struct({ time: Schema.Union([Schema.Null, Timestamp]) }) }),
    ).toMatchObject({ defs: { Sample: { kind: 'struct' } } })
  })

  it('rejects unregistered transformations despite codec metadata', () => {
    const schemas = [
      Schema.FiniteFromString.annotate({ identifier: 'FiniteScore', [EffectRust.width]: 'f32' }),
      EffectRust.F32.pipe(
        Schema.decodeTo(
          EffectRust.F32,
          SchemaTransformation.transform({
            decode: (value) => value + 1,
            encode: (value) => value - 1,
          }),
        ),
      ).annotate({ identifier: 'FiniteScore' }),
      EffectRust.F32.check(Schema.makeFilter<number>((value) => value > 0)).annotate({
        identifier: 'FiniteScore',
      }),
    ]
    for (const schema of schemas) {
      expect(() => lower({ FiniteScore: schema })).toThrow(AdmissionError)
      expect(() =>
        lower({ Sample: Schema.Struct({ score: Schema.Union([Schema.Null, schema]) }) }),
      ).toThrow(AdmissionError)
    }
  })
})
