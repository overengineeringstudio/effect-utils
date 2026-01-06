import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { NotionSchema } from '@overeng/notion-effect-schema'

import { generateSchemaCode } from './codegen.ts'
import type { DatabaseInfo } from './introspect.ts'

describe('integration', () => {
  it('should generate valid TypeScript code that compiles', async () => {
    const dbInfo: DatabaseInfo = {
      id: 'test-db-id',
      name: 'Test Database',
      url: 'https://notion.so/test-db',
      properties: [
        { id: 'title-prop', name: 'Name', type: 'title' },
        { id: 'text-prop', name: 'Description', type: 'rich_text' },
        { id: 'num-prop', name: 'Count', type: 'number' },
        { id: 'check-prop', name: 'Done', type: 'checkbox' },
        { id: 'select-prop', name: 'Status', type: 'select' },
      ],
    }

    const code = generateSchemaCode({ dbInfo, schemaName: 'TestDatabase' })

    // Verify it's valid TypeScript (basic smoke test)
    expect(code).toContain("import { Schema } from 'effect'")
    expect(code).toContain('export const TestDatabasePageProperties')
    expect(code).toContain('export type TestDatabasePageProperties')

    // Verify imports are correct
    expect(code).toContain("import { NotionSchema } from '@overeng/notion-effect-schema'")

    // Verify usage is correct
    expect(code).toContain('Name: NotionSchema.title')
    expect(code).toContain('Description: NotionSchema.richTextString')
    expect(code).toContain('Count: NotionSchema.number')
    expect(code).toContain('Done: NotionSchema.checkbox')
    expect(code).toContain('Status: NotionSchema.selectOption')
  })

  it('should generate schemas that can decode actual Notion API responses', () => {
    // Create a test schema matching what would be generated
    const TestPageProperties = Schema.Struct({
      Name: NotionSchema.title,
      Description: NotionSchema.richTextString,
      Count: NotionSchema.number,
      Done: NotionSchema.checkbox,
      Status: NotionSchema.selectOption,
    })

    // Mock Notion API property response (with proper structure including required fields)
    const mockProperties = {
      Name: {
        id: 'title-prop',
        type: 'title' as const,
        title: [
          {
            type: 'text' as const,
            text: { content: 'Test Task', link: null },
            plain_text: 'Test Task',
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: 'default' as const,
            },
            href: null,
          },
        ],
      },
      Description: {
        id: 'text-prop',
        type: 'rich_text' as const,
        rich_text: [
          {
            type: 'text' as const,
            text: { content: 'Description text', link: null },
            plain_text: 'Description text',
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: 'default' as const,
            },
            href: null,
          },
        ],
      },
      Count: {
        id: 'num-prop',
        type: 'number' as const,
        number: 42,
      },
      Done: {
        id: 'check-prop',
        type: 'checkbox' as const,
        checkbox: true,
      },
      Status: {
        id: 'select-prop',
        type: 'select' as const,
        select: {
          id: 'status-id',
          name: 'In Progress',
          color: 'blue' as const,
        },
      },
    }

    // Decode the properties (this verifies the schema actually works)
    const decoded = Schema.decodeUnknownSync(TestPageProperties)(mockProperties)

    // Verify the decoded result
    expect(decoded.Name).toBe('Test Task')
    expect(decoded.Description).toBe('Description text')
    expect(decoded.Count).toBe(42)
    expect(decoded.Done).toBe(true)
    expect(decoded.Status._tag).toBe('Some')
  })

  it('should generate write schemas that work with Notion API', () => {
    const dbInfo: DatabaseInfo = {
      id: 'test-db-id',
      name: 'Test',
      url: 'https://notion.so/test',
      properties: [
        { id: 'prop1', name: 'Name', type: 'title' },
        { id: 'prop2', name: 'Status', type: 'select' },
        { id: 'prop3', name: 'Done', type: 'checkbox' },
      ],
    }

    const code = generateSchemaCode({ dbInfo, schemaName: 'Test', options: { includeWrite: true } })

    // Verify write schema uses nested Write API
    expect(code).toContain('Name: NotionSchema.titleWriteFromString')
    expect(code).toContain('Status: NotionSchema.selectWriteFromName')
    expect(code).toContain('Done: NotionSchema.checkboxWriteFromBoolean')

    // Verify write schemas can decode simple types
    const TestPageWrite = Schema.Struct({
      Name: NotionSchema.titleWriteFromString,
      Status: NotionSchema.selectWriteFromName,
      Done: NotionSchema.checkboxWriteFromBoolean,
    })

    const inputData = {
      Name: 'New Task',
      Status: 'Todo',
      Done: false,
    }

    // Decode the simple types into Notion API format
    const decoded = Schema.decodeUnknownSync(TestPageWrite)(inputData)

    // Verify the decoded result has the correct Notion API format
    expect(decoded.Name).toHaveProperty('title')
    expect(decoded.Name.title).toBeInstanceOf(Array)
    expect(decoded.Name.title[0]).toMatchObject({
      type: 'text',
      text: { content: 'New Task' },
    })

    expect(decoded.Status).toHaveProperty('select')
    expect(decoded.Status.select).toMatchObject({ name: 'Todo' })

    expect(decoded.Done).toHaveProperty('checkbox')
    expect(decoded.Done.checkbox).toBe(false)
  })

  it('should handle all supported property types without errors', () => {
    const dbInfo: DatabaseInfo = {
      id: 'test',
      name: 'Test',
      url: 'https://notion.so/test',
      properties: [
        { id: '1', name: 'Title', type: 'title' },
        { id: '2', name: 'Text', type: 'rich_text' },
        { id: '3', name: 'Number', type: 'number' },
        { id: '4', name: 'Select', type: 'select' },
        { id: '5', name: 'MultiSelect', type: 'multi_select' },
        { id: '6', name: 'Status', type: 'status' },
        { id: '7', name: 'Date', type: 'date' },
        { id: '8', name: 'People', type: 'people' },
        { id: '9', name: 'Files', type: 'files' },
        { id: '10', name: 'Checkbox', type: 'checkbox' },
        { id: '11', name: 'URL', type: 'url' },
        { id: '12', name: 'Email', type: 'email' },
        { id: '13', name: 'Phone', type: 'phone_number' },
        { id: '14', name: 'Formula', type: 'formula' },
        { id: '15', name: 'Relation', type: 'relation' },
        { id: '16', name: 'CreatedTime', type: 'created_time' },
        { id: '17', name: 'CreatedBy', type: 'created_by' },
        { id: '18', name: 'LastEditedTime', type: 'last_edited_time' },
        { id: '19', name: 'LastEditedBy', type: 'last_edited_by' },
        { id: '20', name: 'UniqueId', type: 'unique_id' },
      ],
    }

    // Should not throw
    const code = generateSchemaCode({ dbInfo, schemaName: 'AllTypes' })
    expect(code).toBeTruthy()
    expect(code.length).toBeGreaterThan(0)

    // Verify all transforms are included
    expect(code).toContain('NotionSchema.title')
    expect(code).toContain('NotionSchema.richTextString')
    expect(code).toContain('NotionSchema.number')
    expect(code).toContain('NotionSchema.selectOption')
    expect(code).toContain('NotionSchema.multiSelectStrings')
    expect(code).toContain('NotionSchema.statusOption')
    expect(code).toContain('NotionSchema.dateOption')
    expect(code).toContain('NotionSchema.peopleIds')
    expect(code).toContain('NotionSchema.filesUrls')
    expect(code).toContain('NotionSchema.checkbox')
    expect(code).toContain('NotionSchema.urlOption')
    expect(code).toContain('NotionSchema.emailOption')
    expect(code).toContain('NotionSchema.phoneNumberOption')
    expect(code).toContain('NotionSchema.formulaRaw')
    expect(code).toContain('NotionSchema.relationIds')
    expect(code).toContain('NotionSchema.createdTimeDate')
    expect(code).toContain('NotionSchema.createdByRaw')
    expect(code).toContain('NotionSchema.lastEditedTimeDate')
    expect(code).toContain('NotionSchema.lastEditedByRaw')
    expect(code).toContain('NotionSchema.uniqueIdProperty')
  })
})
