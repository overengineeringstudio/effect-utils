import { describe, expect, it } from 'vitest'

import { schemaFieldMetadata, schemaFieldTitle } from './schema-field.ts'

describe('projected Schema annotations', () => {
  it('uses a nested title from a document reference without inventing titles for unknown fields', () => {
    const document = {
      schema: { $ref: '#/$defs/Request' },
      $defs: {
        Request: {
          type: 'object',
          properties: {
            project: {
              type: 'object',
              properties: { id: { title: 'Project ID', type: 'string' } },
            },
          },
        },
      },
    }
    expect(schemaFieldTitle({ document, path: ['project', 'id'] })).toBe('Project ID')
    expect(schemaFieldTitle({ document, path: ['missing'] })).toBeUndefined()
  })

  it('labels array elements from their projected item schema', () => {
    const document = {
      type: 'object',
      properties: { rows: { type: 'array', items: { title: 'Row', type: 'string' } } },
    }
    expect(schemaFieldTitle({ document, path: ['rows', '0'] })).toBe('Row')
  })
  it('retains root and nested explanations through projected references without inventing requiredness', () => {
    const document = {
      schema: { $ref: '#/$defs/Request' },
      $defs: {
        Request: {
          title: 'Lookup request',
          description: 'Only projected metadata is shown.',
          type: 'object',
          required: ['id'],
          properties: {
            id: { title: 'Project ID', description: 'Stable ID', examples: ['prj_1'] },
            optional: { title: 'Optional field' },
            values: { type: 'array', items: { title: 'Value item' } },
          },
        },
      },
    }
    expect(schemaFieldMetadata({ document, path: [] })).toMatchObject({
      title: 'Lookup request',
      description: 'Only projected metadata is shown.',
    })
    expect(schemaFieldMetadata({ document, path: ['id'] })).toEqual({
      title: 'Project ID',
      description: 'Stable ID',
      examples: ['prj_1'],
      required: true,
    })
    expect(schemaFieldMetadata({ document, path: ['optional'] })?.required).toBe(false)
    expect(schemaFieldMetadata({ document, path: ['values', '0'] })?.required).toBeUndefined()
  })
})
