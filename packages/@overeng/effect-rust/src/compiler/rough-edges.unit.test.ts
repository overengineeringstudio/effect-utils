import { describe, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import { expect } from 'vitest'

import * as Wire from '../schema/wire.ts'
import { compile, lower } from './mod.ts'

export const Text = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()).annotate({
  identifier: 'Text',
})
export const Digest = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/u)).annotate({
  identifier: 'Digest',
})
export const Descriptor = Schema.TaggedStruct('Descriptor', {
  text: Text,
  codec: Schema.optionalKey(Text),
  digest: Digest,
})
export const edgeContracts = { Text, Digest, Descriptor }

const whitespace = [
  '\t',
  '\n',
  '\v',
  '\f',
  '\r',
  ' ',
  '\u00a0',
  '\u1680',
  ...Array.from({ length: 11 }, (_, index) => String.fromCodePoint(0x2000 + index)),
  '\u2028',
  '\u2029',
  '\u202f',
  '\u205f',
  '\u3000',
  '\ufeff',
]
export const edgeVectors = [
  ...['ok', '\u0085', '\u200b', '😀', 'a\nb'].map((input, index) => ({
    contract: 'Text',
    name: `accepted_${index}`,
    input,
    accept: true,
  })),
  { contract: 'Text', name: 'empty', input: '', accept: false },
  ...whitespace.flatMap((space, index) => [
    { contract: 'Text', name: `leading_${index}`, input: `${space}ok`, accept: false },
    { contract: 'Text', name: `trailing_${index}`, input: `ok${space}`, accept: false },
    { contract: 'Text', name: `interior_${index}`, input: `a${space}b`, accept: true },
  ]),
  { contract: 'Digest', name: 'digest', input: `sha256:${'a'.repeat(64)}`, accept: true },
  {
    contract: 'Digest',
    name: 'trailing_newline',
    input: `sha256:${'a'.repeat(64)}\n`,
    accept: false,
  },
  { contract: 'Digest', name: 'prefix', input: `xsha256:${'a'.repeat(64)}`, accept: false },
  {
    contract: 'Descriptor',
    name: 'tagged_omitted_codec',
    input: { _tag: 'Descriptor', text: 'ok', digest: `sha256:${'a'.repeat(64)}` },
    accept: true,
  },
  {
    contract: 'Descriptor',
    name: 'missing_tag',
    input: { text: 'ok', digest: `sha256:${'a'.repeat(64)}` },
    accept: false,
  },
  {
    contract: 'Descriptor',
    name: 'wrong_tag',
    input: { _tag: 'Other', text: 'ok', digest: `sha256:${'a'.repeat(64)}` },
    accept: false,
  },
  {
    contract: 'Descriptor',
    name: 'null_codec',
    input: { _tag: 'Descriptor', text: 'ok', codec: null, digest: `sha256:${'a'.repeat(64)}` },
    accept: false,
  },
]

describe('portable built-in string checks and tags', () => {
  const output = compile(edgeContracts, { vectors: edgeVectors })
  const generated = Schema.decodeUnknownSync(
    Schema.Struct({
      $defs: Schema.Struct({ Text: Schema.Struct({ pattern: Schema.String }) }),
    }),
  )(Wire.parseJson(output.files['schema/Text.json']!))
  const portable = Schema.String.check(
    Wire.pattern(generated.$defs.Text.pattern),
    Schema.isMinCodePoints(1),
  )
  for (const vector of edgeVectors)
    it(`${vector.contract}/${vector.name}`, () => {
      const schema = edgeContracts[vector.contract as keyof typeof edgeContracts]
      expect(Schema.is(schema)(vector.input)).toBe(vector.accept)
      if (vector.contract === 'Text') expect(Schema.is(portable)(vector.input)).toBe(vector.accept)
    })
  it('keeps arbitrary constructor defaults and UTF-16 bounds out of the contract', () => {
    expect(() =>
      lower({
        Bad: Schema.Struct({
          value: Schema.String.pipe(Schema.withConstructorDefault(Effect.succeed('x'))),
        }),
      }),
    ).toThrow(/Constructor default/)
    expect(() =>
      lower({
        Bad: Schema.Struct({
          value: Schema.Literal('x').pipe(
            Schema.withConstructorDefault(Effect.sync(() => 'x' as const)),
          ),
        }),
      }),
    ).toThrow(/Constructor default/)
    expect(() =>
      lower({ Bad: Schema.String.check(Schema.isMinLength(2)).annotate({ identifier: 'Bad' }) }),
    ).toThrow(/UTF-16/)
    expect(() =>
      lower({
        Bad: Schema.String.check(Schema.isPattern(/^[a-z]+$/mu)).annotate({ identifier: 'Bad' }),
      }),
    ).toThrow(/Non-portable/)
    expect(() => lower({ Bad: Schema.tagDefaultOmit('x') })).toThrow(/transformation/)
  })
  it('preserves a nominal codec across optionalKey wrapping', () => {
    const ir = lower({ Descriptor, Text, Digest })
    expect(ir.defs.Descriptor).toMatchObject({
      fields: [
        { wire: '_tag', presence: 'required' },
        { wire: 'text', type: { kind: 'ref', name: 'Text' } },
        { wire: 'codec', type: { kind: 'ref', name: 'Text' }, presence: 'optional' },
        { wire: 'digest', type: { kind: 'ref', name: 'Digest' } },
      ],
    })
  })
})
