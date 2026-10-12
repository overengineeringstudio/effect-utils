import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { assertAnnotationCompleteness, walkSchema } from './schema-nodes.ts'

const node = <TSchema extends Schema.Top>(schema: TSchema) =>
  schema.pipe(
    Schema.annotateKey({
      title: 'Fact',
      description: 'A semantic fact',
      'x-sensitivity': 'public',
    }),
  )
describe('semantic node hooks', () => {
  it('walks nested structs, homogeneous arrays and every union arm', () => {
    const schema = Schema.Struct({
      who: node(Schema.Struct({ name: node(Schema.String) })),
      refs: node(
        Schema.Array(
          Schema.Struct({ id: node(Schema.String) }).annotate({
            title: 'Reference',
            description: 'A stable reference',
            'x-sensitivity': 'internal',
          }),
        ),
      ),
      variant: node(
        Schema.Union([
          Schema.Struct({ a: node(Schema.String) }),
          Schema.Struct({ b: node(Schema.String) }),
        ]),
      ),
      choice: node(Schema.Literals(['yes', 'no'])),
    })
    expect(() => assertAnnotationCompleteness({ schema: schema })).not.toThrow()
    const visited: string[] = []
    const nodes = walkSchema({
      schema,
      onNode: ({ path }) => visited.push(path),
    })
    expect(visited).toEqual(nodes.map(({ path }) => path))
    expect(visited).toEqual(
      expect.arrayContaining([
        'who.name',
        'refs[]',
        'refs[].id',
        'variant.a',
        'variant.b',
        'choice',
      ]),
    )
  })
  it('fails closed on missing sensitivity and human annotations', () => {
    expect(() =>
      assertAnnotationCompleteness({ schema: Schema.Struct({ value: Schema.String }) }),
    ).toThrow('x-sensitivity')
    expect(() =>
      assertAnnotationCompleteness({
        schema: Schema.Struct({
          value: Schema.String.pipe(Schema.annotateKey({ 'x-sensitivity': 'public' })),
        }),
      }),
    ).toThrow('title')
    expect(() =>
      assertAnnotationCompleteness({
        schema: Schema.Struct({
          value: Schema.String.pipe(
            Schema.annotateKey({ 'x-sensitivity': 'public', title: 'Fact' }),
          ),
        }),
      }),
    ).toThrow('description')
  })
  it('checks each union branch and unknown custom keys', () => {
    const schema = Schema.Struct({
      variant: node(
        Schema.Union([
          Schema.Struct({ good: node(Schema.String) }),
          Schema.Struct({ missing: Schema.String }),
        ]),
      ),
    })
    expect(() => assertAnnotationCompleteness({ schema: schema })).toThrow('variant.missing')
    const unknown = Schema.Struct({
      value: node(Schema.String).pipe(Schema.annotateKey({ 'x-typo': true })),
    })
    expect(() =>
      assertAnnotationCompleteness({
        schema: unknown,
        knownCustomKeys: [],
      }),
    ).toThrow('x-typo')
  })
  it('rejects non-finite index signatures rather than silently omitting them', () => {
    expect(() => walkSchema({ schema: Schema.Record(Schema.String, Schema.String) })).toThrow(
      'Index signatures',
    )
  })
})
