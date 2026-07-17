import { render, screen } from '@testing-library/react'
import { Schema } from 'effect'
import React from 'react'
import { describe, expect, it, vi } from 'vitest'

import { ObjectInspector } from '../object-inspector/ObjectInspector.tsx'
import { ObjectLabel } from '../object-inspector/ObjectLabel.tsx'
import { ObjectPreview } from '../object-inspector/ObjectPreview.tsx'
import { ObjectRootLabel } from '../object-inspector/ObjectRootLabel.tsx'
import { ObjectName } from '../object/ObjectName.tsx'
import { ObjectValue } from '../object/ObjectValue.tsx'
import { formatWithPretty, getAnnotations, getSchemaInfo } from './effectSchema.tsx'
import * as Lineage from './lineage.ts'
import { withSchemaSupport } from './SchemaAwareObjectInspector.tsx'
import { SchemaProvider, useSchemaContext } from './SchemaContext.tsx'

const ConsumerSchema = Schema.Struct({
  id: Schema.Finite.annotate({ description: 'Consumer-created identifier' }),
  name: Schema.String.annotate({ title: 'Display name' }),
}).annotate({ identifier: 'Consumer.Record' })

const ConsumerSchemaInspector = withSchemaSupport(ObjectInspector, {
  ObjectRootLabel,
  ObjectLabel,
  ObjectName,
  ObjectValue,
  ObjectPreview,
})

const SchemaProbe = () => {
  const schema = useSchemaContext()
  return (
    <output>
      {schema.getDisplayName()}:{schema.getFieldContext('id').getDescription()}
    </output>
  )
}

describe('Effect 4 consumer schema compatibility', () => {
  it('inspects a schema created by the consuming Effect instance without runtime errors', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    expect(() =>
      render(
        <ConsumerSchemaInspector
          data={{ id: 1, name: 'Ada' }}
          schema={ConsumerSchema}
          expandLevel={2}
        />,
      ),
    ).not.toThrow()

    expect(screen.getByText('id')).toBeTruthy()
    expect(document.body.textContent).toContain('Ada')
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
  })

  it('traverses Effect 4 annotations supplied by the consumer', () => {
    render(
      <SchemaProvider schema={ConsumerSchema} rootData={{ id: 1, name: 'Ada' }}>
        <SchemaProbe />
      </SchemaProvider>,
    )

    expect(screen.getByText('Consumer.Record:Consumer-created identifier')).toBeTruthy()
  })

  it('preserves custom pretty annotations and extracts Effect 4 check metadata', () => {
    const schema = Schema.Finite.pipe(
      Schema.check(Schema.isInt()),
      Schema.check(Schema.isBetween({ minimum: 0, maximum: 150 })),
    ).annotate({ pretty: (value) => `${value} years` })

    expect(formatWithPretty(42, getAnnotations(schema))).toBe('42 years')
    expect(getSchemaInfo(schema).constraints).toEqual([
      { label: '≥', value: '0' },
      { label: '≤', value: '150' },
      { label: 'integer', value: 'yes' },
    ])

    const handle = Schema.String.pipe(
      Schema.check(Schema.isMinLength(1)),
      Schema.check(Schema.isMaxLength(20)),
      Schema.check(Schema.isPattern(/^[a-z]+$/i)),
    )
    expect(getSchemaInfo(handle).constraints).toEqual([
      { label: 'min length', value: '1' },
      { label: 'max length', value: '20' },
      { label: 'pattern', value: '/^[a-z]+$/i' },
    ])
  })

  it('attaches and reads Effect 4 lineage annotations with shorthand derivation kinds', () => {
    const schema = Schema.Finite.pipe(
      Lineage.derivedFrom({ from: ['subtotal', 'tax'], how: 'Pure', pure: true }),
    )

    expect(Lineage.getLineage(schema)).toEqual({
      _tag: 'Derived',
      from: [
        { _tag: 'Field', path: '$.subtotal' },
        { _tag: 'Field', path: '$.tax' },
      ],
      how: { _tag: 'Pure' },
      pure: true,
    })
  })
})
