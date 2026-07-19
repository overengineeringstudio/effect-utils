import { render, screen } from '@testing-library/react'
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

const field = {
  _tag: 'Number',
  annotations: { description: 'Consumer-created identifier' },
  checks: [
    { annotations: { meta: { _tag: 'isInt' } } },
    {
      annotations: {
        meta: { _tag: 'isBetween', minimum: 0, maximum: 150 },
      },
    },
  ],
  toString: () => 'number',
}

const consumerSchema = {
  ast: {
    _tag: 'Objects',
    annotations: { identifier: 'Consumer.Record' },
    propertySignatures: [
      { name: 'id', type: field },
      { name: 'name', type: { _tag: 'String', annotations: { title: 'Display name' } } },
    ],
    indexSignatures: [],
  },
}

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

describe('runtime-neutral schema compatibility', () => {
  it('renders and traverses a consumer-owned schema without importing Effect', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(
      <ConsumerSchemaInspector
        data={{ id: 1, name: 'Ada' }}
        schema={consumerSchema}
        expandLevel={2}
      />,
    )
    expect(screen.getByText('id')).toBeTruthy()
    expect(document.body.textContent).toContain('Ada')
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
  })

  it('derives display metadata from the neutral AST view', () => {
    render(
      <SchemaProvider schema={consumerSchema} rootData={{ id: 1, name: 'Ada' }}>
        <SchemaProbe />
      </SchemaProvider>,
    )
    expect(screen.getByText('Consumer.Record:Consumer-created identifier')).toBeTruthy()
    expect(getSchemaInfo({ ast: field }).constraints).toEqual([
      { label: '≥', value: '0' },
      { label: '≤', value: '150' },
      { label: 'integer', value: 'yes' },
    ])
  })

  it('keeps formatter and lineage behavior runtime-neutral', () => {
    const schema = {
      ast: {
        _tag: 'String',
        annotations: {
          pretty: (value: unknown) => `${String(value)}!`,
          '@overeng/lineage': { _tag: 'SourceOfTruth' },
          '@overeng/authority': { writers: [] },
          '@overeng/freshness': {},
          '@overeng/reference': { _tag: 'ForeignKey', targetSchema: 'Consumer.Record' },
        },
      },
    }
    expect(formatWithPretty('ok', getAnnotations(schema))).toBe('ok!')
    expect(Lineage.getLineage(schema)).toEqual({ _tag: 'SourceOfTruth' })
    expect(Lineage.getAuthority(schema)).toEqual({ writers: [] })
    expect(Lineage.getFreshness(schema)).toEqual({})
    expect(Lineage.getReference(schema)).toEqual({
      _tag: 'ForeignKey',
      targetSchema: 'Consumer.Record',
    })
  })

  it('rejects malformed lineage values instead of weakening decode semantics', () => {
    const malformed = {
      ast: {
        _tag: 'String',
        annotations: {
          '@overeng/lineage': { _tag: 'Derived', from: [], how: { _tag: 'Bogus' } },
          '@overeng/authority': { writers: [1] },
          '@overeng/freshness': { maxAgeMs: Number.POSITIVE_INFINITY },
        },
      },
    }
    expect(Lineage.getLineage(malformed)).toBeUndefined()
    expect(Lineage.getAuthority(malformed)).toBeUndefined()
    expect(Lineage.getFreshness(malformed)).toBeUndefined()
  })
})
