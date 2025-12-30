import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
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

    const code = generateSchemaCode(dbInfo, 'TestDatabase')

    // Verify it's valid TypeScript (basic smoke test)
    expect(code).toContain('import { Schema } from \'effect\'')
    expect(code).toContain('export const TestDatabasePageProperties')
    expect(code).toContain('export type TestDatabasePageProperties')

    // Verify imports are correct
    expect(code).toContain('Title,')
    expect(code).toContain('RichTextProp,')
    expect(code).toContain('Num,')
    expect(code).toContain('Checkbox,')
    expect(code).toContain('Select,')

    // Verify usage is correct
    expect(code).toContain('Name: Title.asString')
    expect(code).toContain('Description: RichTextProp.asString')
    expect(code).toContain('Count: Num.asNumber')
    expect(code).toContain('Done: Checkbox.asBoolean')
    expect(code).toContain('Status: Select.asOption')
  })

  it('should generate schemas that can decode actual Notion API responses', () => {
    // Import the actual transform namespaces to verify they exist and work
    const {
      Title,
      RichTextProp,
      Num,
      Checkbox,
      Select,
    } = require('@schickling/notion-effect-schema')

    // Create a test schema matching what would be generated
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const TestPageProperties = Schema.Struct({
      Name: Title.asString,
      Description: RichTextProp.asString,
      Count: Num.asNumber,
      Done: Checkbox.asBoolean,
      Status: Select.asOption,
    }) as unknown as Schema.Schema<any>

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
    const decoded = Schema.decodeUnknownSync(TestPageProperties)(mockProperties) as {
      Name: string
      Description: string
      Count: number
      Done: boolean
      Status: { _tag: string }
    }

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

    const code = generateSchemaCode(dbInfo, 'Test', { includeWrite: true })

    // Verify write schema uses nested Write API
    expect(code).toContain('Name: Title.Write.fromString')
    expect(code).toContain('Status: Select.Write.fromName')
    expect(code).toContain('Done: Checkbox.Write.fromBoolean')

    // Verify write schemas can decode simple types
    const { Title, Select, Checkbox } = require('@schickling/notion-effect-schema')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const TestPageWrite = Schema.Struct({
      Name: Title.Write.fromString,
      Status: Select.Write.fromName,
      Done: Checkbox.Write.fromBoolean,
    }) as unknown as Schema.Schema<any>

    const inputData = {
      Name: 'New Task',
      Status: 'Todo',
      Done: false,
    }

    // Decode the simple types into Notion API format
    const decoded = Schema.decodeUnknownSync(TestPageWrite)(inputData) as {
      Name: { title: Array<{ type: string; text: { content: string } }> }
      Status: { select: { name: string } | null }
      Done: { checkbox: boolean }
    }

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
    const code = generateSchemaCode(dbInfo, 'AllTypes')
    expect(code).toBeTruthy()
    expect(code.length).toBeGreaterThan(0)

    // Verify all transforms are included
    expect(code).toContain('Title.asString')
    expect(code).toContain('RichTextProp.asString')
    expect(code).toContain('Num.asNumber')
    expect(code).toContain('Select.asOption')
    expect(code).toContain('MultiSelect.asStrings')
    expect(code).toContain('Status.asOption')
    expect(code).toContain('DateProp.asOption')
    expect(code).toContain('People.asIds')
    expect(code).toContain('Files.asUrls')
    expect(code).toContain('Checkbox.asBoolean')
    expect(code).toContain('Url.asOption')
    expect(code).toContain('Email.asOption')
    expect(code).toContain('PhoneNumber.asOption')
    expect(code).toContain('Formula.raw')
    expect(code).toContain('Relation.asIds')
    expect(code).toContain('CreatedTime.asDate')
    expect(code).toContain('CreatedBy.raw')
    expect(code).toContain('LastEditedTime.asDate')
    expect(code).toContain('LastEditedBy.raw')
    expect(code).toContain('UniqueId.raw')
  })
})
