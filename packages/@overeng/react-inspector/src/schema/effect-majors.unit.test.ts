import { Schema as Schema4 } from 'effect'
import { Schema as Schema3 } from 'effect3'
import { describe, expect, it } from 'vitest'

import { getAnnotations, getFieldSchema, getSchemaInfo, narrowUnionByTag } from './effectSchema.tsx'
import * as Lineage from './lineage.ts'
import type { SchemaProviderProps } from './SchemaContext.tsx'

const schema3 = Schema3.TaggedStruct('Consumer', {
  id: Schema3.Number.annotations({ description: 'Effect 3 identifier' }),
}).annotations({ identifier: 'Effect3.Consumer' })

const schema4 = Schema4.Struct({
  _tag: Schema4.Literal('Consumer'),
  id: Schema4.Finite.annotate({ description: 'Effect 4 identifier' }),
}).annotate({ identifier: 'Effect4.Consumer' })

const consumerProps3: Omit<SchemaProviderProps, 'children'> = { schema: schema3 }
const consumerProps4: Omit<SchemaProviderProps, 'children'> = { schema: schema4 }
void [consumerProps3, consumerProps4]

describe.each([
  ['Effect 3', schema3, 'Effect3.Consumer', 'Effect 3 identifier'],
  ['Effect 4', schema4, 'Effect4.Consumer', 'Effect 4 identifier'],
] as const)('%s consumer', (_label, schema, identifier, description) => {
  it('reads the consumer runtime AST without type identity coupling', () => {
    expect(getAnnotations(schema).identifier).toBe(identifier)
    const field = getFieldSchema(schema, 'id')
    expect(field).toBeDefined()
    expect(field === undefined ? undefined : getSchemaInfo(field).description).toBe(description)
    expect(narrowUnionByTag(schema.ast, { _tag: 'Consumer' })._tag).not.toBe('Union')
  })
})

describe('lineage major boundary', () => {
  it('writes and reads Effect 3 symbol annotations', () => {
    const schema = Schema3.Number.pipe(
      Lineage.derivedFrom({ from: ['subtotal'], how: 'Pure', pure: true }),
    )
    expect(Lineage.getLineage(schema)).toEqual({
      _tag: 'Derived',
      from: [{ _tag: 'Field', path: '$.subtotal' }],
      how: { _tag: 'Pure' },
      pure: true,
    })
  })

  it('writes and reads Effect 4 string annotations', () => {
    const schema = Schema4.Finite.pipe(
      Lineage.derivedFrom({ from: ['subtotal'], how: 'Pure', pure: true }),
    )
    expect(Lineage.getLineage(schema)).toEqual({
      _tag: 'Derived',
      from: [{ _tag: 'Field', path: '$.subtotal' }],
      how: { _tag: 'Pure' },
      pure: true,
    })
  })
})
