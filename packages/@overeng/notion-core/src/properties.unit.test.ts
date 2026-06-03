import { describe, expect, it } from 'vitest'

import {
  isNotionPropertyType,
  isPropertyWriteClass,
  NOTION_PROPERTY_TYPES,
  PROPERTY_WRITE_CLASSES,
  propertyWriteClassFromType,
} from './properties.ts'

describe('Notion property literals', () => {
  it('exports all known Notion property type tags', () => {
    expect(NOTION_PROPERTY_TYPES).toEqual([
      'title',
      'rich_text',
      'number',
      'checkbox',
      'date',
      'select',
      'multi_select',
      'status',
      'relation',
      'people',
      'files',
      'email',
      'url',
      'phone_number',
      'formula',
      'rollup',
      'created_time',
      'created_by',
      'last_edited_time',
      'last_edited_by',
      'unique_id',
      'verification',
      'button',
    ])
    expect(isNotionPropertyType('title')).toBe(true)
    expect(isNotionPropertyType('unknown')).toBe(false)
  })

  it('exports property write classes', () => {
    expect(PROPERTY_WRITE_CLASSES).toEqual(['writable', 'computed', 'unsupported'])
    expect(isPropertyWriteClass('computed')).toBe(true)
    expect(isPropertyWriteClass('readonly')).toBe(false)
  })
})

describe('propertyWriteClassFromType', () => {
  it('classifies writable property types', () => {
    for (const propertyType of [
      'title',
      'rich_text',
      'number',
      'checkbox',
      'date',
      'select',
      'multi_select',
      'status',
      'email',
      'url',
      'phone_number',
      'relation',
      'people',
      'files',
    ]) {
      expect(propertyWriteClassFromType(propertyType), propertyType).toBe('writable')
    }
  })

  it('classifies computed property types', () => {
    for (const propertyType of [
      'formula',
      'rollup',
      'created_time',
      'created_by',
      'last_edited_time',
      'last_edited_by',
      'unique_id',
      'verification',
    ]) {
      expect(propertyWriteClassFromType(propertyType), propertyType).toBe('computed')
    }
  })

  it('classifies unsupported and unknown property types fail-closed', () => {
    expect(propertyWriteClassFromType('button')).toBe('unsupported')
    expect(propertyWriteClassFromType('new_future_type')).toBe('unsupported')
  })
})
