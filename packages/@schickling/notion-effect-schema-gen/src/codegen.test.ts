import { describe, expect, it } from 'vitest'
import {
  generateSchemaCode,
  getAvailableTransforms,
  getDefaultTransform,
  PROPERTY_TRANSFORMS,
} from './codegen.ts'
import type { DatabaseInfo, PropertyInfo } from './introspect.ts'

describe('codegen', () => {
  describe('generateSchemaCode', () => {
    it('should generate basic schema for a simple database', () => {
      const dbInfo: DatabaseInfo = {
        id: 'test-db-id',
        name: 'Test Database',
        url: 'https://notion.so/test-db',
        properties: [
          { id: 'title-prop', name: 'Name', type: 'title' },
          { id: 'text-prop', name: 'Description', type: 'rich_text' },
          { id: 'num-prop', name: 'Count', type: 'number' },
          { id: 'check-prop', name: 'Done', type: 'checkbox' },
        ],
      }

      const code = generateSchemaCode(dbInfo, 'TestDatabase')

      expect(code).toContain("import { Schema } from 'effect'")
      expect(code).toContain("from '@schickling/notion-effect-schema'")
      expect(code).toContain('TitleProperty')
      expect(code).toContain('RichTextProperty')
      expect(code).toContain('NumberProperty')
      expect(code).toContain('CheckboxProperty')
      expect(code).toContain('export const TestdatabasePageProperties = Schema.Struct({')
      expect(code).toContain('Name: TitleProperty.asString')
      expect(code).toContain('Description: RichTextProperty.asString')
      expect(code).toContain('Count: NumberProperty.asNumber')
      expect(code).toContain('Done: CheckboxProperty.asBoolean')
      expect(code).toContain(
        'export type TestdatabasePageProperties = typeof TestdatabasePageProperties.Type',
      )
    })

    it('should handle property names with special characters', () => {
      const dbInfo: DatabaseInfo = {
        id: 'test-db-id',
        name: 'Test',
        url: 'https://notion.so/test',
        properties: [
          { id: 'prop1', name: 'Due Date', type: 'date' },
          { id: 'prop2', name: 'Project Name', type: 'title' },
          { id: 'prop3', name: "User's Choice", type: 'select' },
        ],
      }

      const code = generateSchemaCode(dbInfo, 'Test')

      expect(code).toContain("'Due Date': DateProperty.asOption")
      expect(code).toContain("'Project Name': TitleProperty.asString")
      expect(code).toContain("'User\\'s Choice': SelectProperty.asOption")
    })

    it('should respect custom transform configuration', () => {
      const dbInfo: DatabaseInfo = {
        id: 'test-db-id',
        name: 'Test',
        url: 'https://notion.so/test',
        properties: [
          { id: 'prop1', name: 'Status', type: 'select' },
          { id: 'prop2', name: 'Tags', type: 'multi_select' },
          { id: 'prop3', name: 'Website', type: 'url' },
        ],
      }

      const transformConfig = {
        Status: 'raw',
        Tags: 'raw',
        Website: 'asString',
      }

      const code = generateSchemaCode(dbInfo, 'Test', transformConfig)

      expect(code).toContain('Status: SelectProperty.raw')
      expect(code).toContain('Tags: MultiSelectProperty.raw')
      expect(code).toContain('Website: UrlProperty.asString')
    })

    it('should fall back to default transform for invalid config', () => {
      const dbInfo: DatabaseInfo = {
        id: 'test-db-id',
        name: 'Test',
        url: 'https://notion.so/test',
        properties: [{ id: 'prop1', name: 'Status', type: 'select' }],
      }

      const transformConfig = {
        Status: 'invalidTransform',
      }

      const code = generateSchemaCode(dbInfo, 'Test', transformConfig)

      // Should fall back to default (asOption for select)
      expect(code).toContain('Status: SelectProperty.asOption')
    })

    it('should convert name to PascalCase', () => {
      const dbInfo: DatabaseInfo = {
        id: 'test-db-id',
        name: 'Test',
        url: 'https://notion.so/test',
        properties: [{ id: 'prop1', name: 'Title', type: 'title' }],
      }

      const code = generateSchemaCode(dbInfo, 'my-test-database')

      expect(code).toContain('export const MyTestDatabasePageProperties')
      expect(code).toContain('export type MyTestDatabasePageProperties')
    })

    it('should include property descriptions as comments', () => {
      const dbInfo: DatabaseInfo = {
        id: 'test-db-id',
        name: 'Test',
        url: 'https://notion.so/test',
        properties: [
          {
            id: 'prop1',
            name: 'Status',
            type: 'select',
            description: 'Current task status',
          },
        ],
      }

      const code = generateSchemaCode(dbInfo, 'Test')

      expect(code).toContain('Status: SelectProperty.asOption, // Current task status')
    })

    it('should handle all property types with default transforms', () => {
      const propertyTypes: Array<{ type: PropertyInfo['type']; expected: string }> = [
        { type: 'title', expected: 'TitleProperty.asString' },
        { type: 'rich_text', expected: 'RichTextProperty.asString' },
        { type: 'number', expected: 'NumberProperty.asNumber' },
        { type: 'select', expected: 'SelectProperty.asOption' },
        { type: 'multi_select', expected: 'MultiSelectProperty.asStrings' },
        { type: 'status', expected: 'StatusProperty.asOption' },
        { type: 'date', expected: 'DateProperty.asOption' },
        { type: 'people', expected: 'PeopleProperty.asIds' },
        { type: 'files', expected: 'FilesProperty.asUrls' },
        { type: 'checkbox', expected: 'CheckboxProperty.asBoolean' },
        { type: 'url', expected: 'UrlProperty.asOption' },
        { type: 'email', expected: 'EmailProperty.asOption' },
        { type: 'phone_number', expected: 'PhoneNumberProperty.asOption' },
        { type: 'formula', expected: 'FormulaProperty.raw' },
        { type: 'relation', expected: 'RelationProperty.asIds' },
        { type: 'rollup', expected: 'RollupProperty.raw' },
        { type: 'created_time', expected: 'CreatedTimeProperty.asDate' },
        { type: 'created_by', expected: 'CreatedByProperty.raw' },
        { type: 'last_edited_time', expected: 'LastEditedTimeProperty.asDate' },
        { type: 'last_edited_by', expected: 'LastEditedByProperty.raw' },
        { type: 'unique_id', expected: 'UniqueIdProperty.raw' },
      ]

      for (const { type, expected } of propertyTypes) {
        const dbInfo: DatabaseInfo = {
          id: 'test',
          name: 'Test',
          url: 'https://notion.so/test',
          properties: [{ id: 'prop', name: 'Prop', type }],
        }

        const code = generateSchemaCode(dbInfo, 'Test')
        expect(code).toContain(`Prop: ${expected}`)
      }
    })

    it('should handle unknown property types gracefully', () => {
      const dbInfo: DatabaseInfo = {
        id: 'test-db-id',
        name: 'Test',
        url: 'https://notion.so/test',
        properties: [{ id: 'prop1', name: 'Unknown', type: 'button' as PropertyInfo['type'] }],
      }

      const code = generateSchemaCode(dbInfo, 'Test')

      expect(code).toContain('Unknown: Schema.Unknown')
    })
  })

  describe('getAvailableTransforms', () => {
    it('should return available transforms for each type', () => {
      expect(getAvailableTransforms('title')).toContain('raw')
      expect(getAvailableTransforms('title')).toContain('asString')

      expect(getAvailableTransforms('select')).toContain('raw')
      expect(getAvailableTransforms('select')).toContain('asOption')
      expect(getAvailableTransforms('select')).toContain('asString')

      expect(getAvailableTransforms('checkbox')).toContain('raw')
      expect(getAvailableTransforms('checkbox')).toContain('asBoolean')
    })

    it('should return raw for unknown types', () => {
      expect(getAvailableTransforms('unknown')).toEqual(['raw'])
    })
  })

  describe('getDefaultTransform', () => {
    it('should return correct defaults', () => {
      expect(getDefaultTransform('title')).toBe('asString')
      expect(getDefaultTransform('number')).toBe('asNumber')
      expect(getDefaultTransform('checkbox')).toBe('asBoolean')
      expect(getDefaultTransform('select')).toBe('asOption')
      expect(getDefaultTransform('formula')).toBe('raw')
    })

    it('should return raw for unknown types', () => {
      expect(getDefaultTransform('unknown')).toBe('raw')
    })
  })

  describe('PROPERTY_TRANSFORMS', () => {
    it('should have transforms defined for all common property types', () => {
      const expectedTypes = [
        'title',
        'rich_text',
        'number',
        'select',
        'multi_select',
        'status',
        'date',
        'people',
        'files',
        'checkbox',
        'url',
        'email',
        'phone_number',
        'formula',
        'relation',
        'rollup',
        'created_time',
        'created_by',
        'last_edited_time',
        'last_edited_by',
        'unique_id',
      ]

      for (const type of expectedTypes) {
        expect(PROPERTY_TRANSFORMS[type]).toBeDefined()
        expect(PROPERTY_TRANSFORMS[type]).toContain('raw')
      }
    })
  })
})
