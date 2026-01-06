import { Effect, Schema } from 'effect'
import { describe, it } from '@effect/vitest'
import { expect } from 'vitest'

import { DatabaseSchema } from '@overeng/notion-effect-schema'
import { shouldNeverHappen } from '@overeng/utils'

import { SchemaHelpers } from './schema-helpers.ts'

const makeDatabase = (properties: Record<string, unknown>) =>
  Schema.decodeUnknownSync(DatabaseSchema)({
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
    properties,
  })

describe('SchemaHelpers', () => {
  describe('getProperties', () => {
    it('decodes typed property definitions from database schema properties', () => {
      const db = makeDatabase({
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

  describe('validateProperties', () => {
    it.effect('succeeds when required properties exist', () =>
      Effect.gen(function* () {
        const db = makeDatabase({
          Name: { id: 'prop-name', type: 'title', title: {} },
          Amount: { id: 'prop-amount', type: 'number', number: { format: 'number' } },
        })

        yield* SchemaHelpers.validateProperties({
          schema: db,
          databaseId: 'db-id',
          required: [
            { name: 'Name', tag: 'title' },
            { name: 'Amount', tag: 'number' },
          ],
        })
      }),
    )

    it.effect('fails when required properties are missing', () =>
      Effect.gen(function* () {
        const db = makeDatabase({
          Name: { id: 'prop-name', type: 'title', title: {} },
        })

        const result = yield* SchemaHelpers.validateProperties({
          schema: db,
          databaseId: 'db-id',
          required: [
            { name: 'Name', tag: 'title' },
            { name: 'Amount', tag: 'number' },
          ],
        }).pipe(Effect.either)

        expect(result._tag).toBe('Left')
        if (result._tag === 'Left') {
          expect(result.left.missing.map((m) => m.name)).toEqual(['Amount'])
        }
      }),
    )
  })

  describe('getRelationTargetOrFail', () => {
    it.effect('returns relation target when available', () =>
      Effect.gen(function* () {
        const db = makeDatabase({
          Customer: {
            id: 'prop-customer',
            type: 'relation',
            relation: {
              database_id: 'target-db',
              type: 'single_property',
              single_property: {},
            },
          },
        })

        const target = yield* SchemaHelpers.getRelationTargetOrFail({
          schema: db,
          databaseId: 'db-id',
          property: 'Customer',
        })

        expect(target.databaseId).toBe('target-db')
        expect(target.type).toBe('single_property')
      }),
    )

    it.effect('fails when relation target is missing', () =>
      Effect.gen(function* () {
        const db = makeDatabase({
          Customer: { id: 'prop-customer', type: 'title', title: {} },
        })

        const result = yield* SchemaHelpers.getRelationTargetOrFail({
          schema: db,
          databaseId: 'db-id',
          property: 'Customer',
        }).pipe(Effect.either)

        expect(result._tag).toBe('Left')
      }),
    )
  })
})
