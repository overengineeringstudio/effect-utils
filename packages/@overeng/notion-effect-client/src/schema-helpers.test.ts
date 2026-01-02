import { DatabaseSchema } from '@overeng/notion-effect-schema'
import { shouldNeverHappen } from '@overeng/utils'
import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { SchemaHelpers } from './schema-helpers.ts'

describe('SchemaHelpers', () => {
  describe('getProperties', () => {
    it('decodes typed property definitions from database schema properties', () => {
      const db = Schema.decodeUnknownSync(DatabaseSchema)({
        object: 'database',
        id: 'db-id',
        created_time: '2025-01-01T00:00:00.000Z',
        created_by: { object: 'user', id: 'user-id' },
        last_edited_time: '2025-01-01T00:00:00.000Z',
        last_edited_by: { object: 'user', id: 'user-id' },
        title: [],
        description: [],
        icon: null,
        cover: null,
        parent: { type: 'workspace', workspace: true },
        url: 'https://notion.so/db',
        archived: false,
        in_trash: false,
        is_inline: false,
        public_url: null,
        properties: {
          B: { id: 'prop-b', type: 'title', title: {} },
          A: {
            id: 'prop-a',
            type: 'select',
            select: {
              options: [
                { id: 'opt-1', name: 'Done', color: 'green' },
                { id: 'opt-2', name: 'Todo', color: 'gray' },
              ],
            },
          },
          Unknown: { id: 'prop-x', type: 'made_up', made_up: {} },
        },
      })

      const props = SchemaHelpers.getProperties({ schema: db })

      expect(props.map((p) => p.name)).toEqual(['A', 'B'])

      const first = props[0]
      if (first === undefined) {
        return shouldNeverHappen('Expected at least one property')
      }

      expect(first._tag).toBe('select')
      if (first._tag !== 'select') {
        return shouldNeverHappen('Expected first property to be select', first)
      }

      expect(first.select.options.map((o) => o.name)).toEqual(['Done', 'Todo'])
    })
  })
})
