import { describe, expect, it } from '@effect/vitest'

import {
  canonicalWritableSchema,
  propertyIdMap,
  readOnlyPropertyNames,
  titlePropertyName,
  writableSchemaHash,
} from './schema-snapshot.ts'

/**
 * Reference property schema modeled on a live `GET /v1/data_sources/{id}`
 * response: each property carries `{ id, name, type, [type]: config }`, options
 * carry `{ id, name, color }`. Mixes writable, computed, and unsupported types
 * so the writable-subset projection is exercised end to end.
 */
const baseSchema = (): Record<string, unknown> => ({
  Name: { id: 'title', name: 'Name', type: 'title', title: {} },
  Notes: { id: '%5CI%7DT', name: 'Notes', type: 'rich_text', rich_text: {} },
  Count: { id: 'm%3FIX', name: 'Count', type: 'number', number: { format: 'number' } },
  Done: { id: 'vV%3AO', name: 'Done', type: 'checkbox', checkbox: {} },
  Priority: {
    id: 'm%7Bm%3C',
    name: 'Priority',
    type: 'select',
    select: {
      options: [
        { id: 'opt-low', name: 'Low', color: 'gray' },
        { id: 'opt-high', name: 'High', color: 'red' },
      ],
    },
  },
  Tags: {
    id: 'AY%3BG',
    name: 'Tags',
    type: 'multi_select',
    multi_select: {
      options: [
        { id: 'tag-a', name: 'a', color: 'blue' },
        { id: 'tag-b', name: 'b', color: 'green' },
      ],
    },
  },
  // computed — excluded from the writable projection
  Ref: { id: 'MQMg', name: 'Ref', type: 'unique_id', unique_id: { prefix: 'FP' } },
  Score: { id: 'NCs%7B', name: 'Score', type: 'formula', formula: { expression: '1 + 1' } },
})

describe('canonicalWritableSchema', () => {
  it('projects only writable properties, sorted by name, options by name', () => {
    expect(canonicalWritableSchema(baseSchema())).toEqual([
      { name: 'Count', type: 'number', options: null },
      { name: 'Done', type: 'checkbox', options: null },
      { name: 'Name', type: 'title', options: null },
      { name: 'Notes', type: 'rich_text', options: null },
      { name: 'Priority', type: 'select', options: ['High', 'Low'] },
      { name: 'Tags', type: 'multi_select', options: ['a', 'b'] },
    ])
  })

  it('excludes computed and unsupported properties', () => {
    const names = canonicalWritableSchema(baseSchema()).map((entry) => entry.name)
    expect(names).not.toContain('Ref')
    expect(names).not.toContain('Score')
  })
})

describe('writableSchemaHash — drift sensitivity', () => {
  const base = baseSchema()
  const baseHash = writableSchemaHash(base)

  it('is a prefixed sha256 digest', () => {
    expect(baseHash).toMatch(/^sha256:[0-9a-f]{64}$/u)
  })

  it('is stable across a benign option color-only change', () => {
    const recolored = baseSchema()
    const priority = recolored.Priority as { select: { options: { color: string }[] } }
    priority.select.options[0]!.color = 'purple'
    priority.select.options[1]!.color = 'yellow'
    expect(writableSchemaHash(recolored)).toBe(baseHash)
  })

  it('is stable across an option id-only change (ids are not hashed)', () => {
    const reid = baseSchema()
    ;(reid.Tags as { multi_select: { options: { id: string }[] } }).multi_select.options[0]!.id =
      'tag-a-renamed-internally'
    expect(writableSchemaHash(reid)).toBe(baseHash)
  })

  it('is stable across a computed-property change (writable subset only)', () => {
    const changed = baseSchema()
    ;(changed.Score as { formula: { expression: string } }).formula.expression = '2 * 2'
    expect(writableSchemaHash(changed)).toBe(baseHash)
  })

  it('trips on adding a writable property', () => {
    const added = baseSchema()
    added.When = { id: 'OmBl', name: 'When', type: 'date', date: {} }
    expect(writableSchemaHash(added)).not.toBe(baseHash)
  })

  it('trips on removing a writable property', () => {
    const removed = baseSchema()
    delete removed.Count
    expect(writableSchemaHash(removed)).not.toBe(baseHash)
  })

  it('trips on renaming a property (rename is id-preserving)', () => {
    const renamed = baseSchema()
    const count = renamed.Count as { name: string }
    delete renamed.Count
    count.name = 'Total'
    renamed.Total = count
    expect(writableSchemaHash(renamed)).not.toBe(baseHash)
  })

  it('trips on retyping a property', () => {
    const retyped = baseSchema()
    retyped.Count = { id: 'm%3FIX', name: 'Count', type: 'rich_text', rich_text: {} }
    expect(writableSchemaHash(retyped)).not.toBe(baseHash)
  })

  it('trips on adding a select option', () => {
    const optAdded = baseSchema()
    ;(optAdded.Priority as { select: { options: unknown[] } }).select.options.push({
      id: 'opt-mid',
      name: 'Medium',
      color: 'yellow',
    })
    expect(writableSchemaHash(optAdded)).not.toBe(baseHash)
  })
})

describe('binding projections', () => {
  it('maps every property name to its id', () => {
    expect(propertyIdMap(baseSchema())).toMatchObject({
      Name: 'title',
      Count: 'm%3FIX',
      Score: 'NCs%7B',
    })
  })

  it('finds the title property name', () => {
    expect(titlePropertyName(baseSchema())).toBe('Name')
  })

  it('lists computed/unsupported property names as read-only', () => {
    expect(readOnlyPropertyNames(baseSchema())).toEqual(['Ref', 'Score'])
  })
})
