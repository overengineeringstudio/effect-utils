import { describe, it, expect } from 'vitest'
import { Schema } from 'effect'
import { parseKdl } from './parse.ts'

describe('parseKdl', () => {
  it('decodes simple struct', () => {
    const MySchema = Schema.Struct({
      name: Schema.String,
      age: Schema.Number,
    })

    const result = Schema.decodeUnknownSync(parseKdl(MySchema))('name "Alice"\nage 30')
    expect(result).toEqual({ name: 'Alice', age: 30 })
  })

  it('decodes nested struct', () => {
    const MySchema = Schema.Struct({
      members: Schema.Record({ key: Schema.String, value: Schema.String }),
    })

    const result = Schema.decodeUnknownSync(parseKdl(MySchema))(
      'members {\n  foo "bar"\n  baz "qux"\n}',
    )
    expect(result).toEqual({ members: { foo: 'bar', baz: 'qux' } })
  })

  it('normalizes scalar to array when Schema expects array', () => {
    const MySchema = Schema.Struct({
      items: Schema.Array(Schema.String),
    })

    const result = Schema.decodeUnknownSync(parseKdl(MySchema))('items "hello"')
    expect(result).toEqual({ items: ['hello'] })
  })

  it('handles multiple same-name nodes as array', () => {
    const MySchema = Schema.Struct({
      items: Schema.Array(Schema.String),
    })

    const result = Schema.decodeUnknownSync(parseKdl(MySchema))(
      'items "a"\nitems "b"\nitems "c"',
    )
    expect(result).toEqual({ items: ['a', 'b', 'c'] })
  })
})
