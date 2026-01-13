import { describe, it } from '@effect/vitest'
import { Effect, Option, Stream } from 'effect'
import { expect } from 'vitest'

import { NotionDatabases } from '../../databases.ts'
import { IntegrationTestLayer, SKIP_INTEGRATION, TEST_IDS } from './setup.ts'

describe.skipIf(SKIP_INTEGRATION)('NotionDatabases (integration)', () => {
  describe('retrieve', () => {
    it.effect('fetches database by ID', () =>
      Effect.gen(function* () {
        const database = yield* NotionDatabases.retrieve({
          databaseId: TEST_IDS.database,
        })

        expect(database.object).toBe('database')
        // Notion API returns UUIDs with dashes
        expect(database.id.replace(/-/g, '')).toBe(TEST_IDS.database.replace(/-/g, ''))
      }).pipe(Effect.provide(IntegrationTestLayer)),
    )
  })

  describe('query', () => {
    it.effect('queries all rows', () =>
      Effect.gen(function* () {
        const result = yield* NotionDatabases.query({
          databaseId: TEST_IDS.database,
        })

        expect(result.results.length).toBeGreaterThanOrEqual(3)
        expect(result.results[0]?.object).toBe('page')
      }).pipe(Effect.provide(IntegrationTestLayer)),
    )

    it.effect('queries with filter', () =>
      Effect.gen(function* () {
        const result = yield* NotionDatabases.query({
          databaseId: TEST_IDS.database,
          filter: {
            property: 'Status',
            select: { equals: 'active' },
          },
        })

        // Should only return rows with status = 'active' (Alpha)
        expect(result.results.length).toBeGreaterThanOrEqual(1)
      }).pipe(Effect.provide(IntegrationTestLayer)),
    )

    it.effect('queries with sort', () =>
      Effect.gen(function* () {
        const result = yield* NotionDatabases.query({
          databaseId: TEST_IDS.database,
          sorts: [{ property: 'Priority', direction: 'ascending' }],
        })

        expect(result.results.length).toBeGreaterThanOrEqual(3)
      }).pipe(Effect.provide(IntegrationTestLayer)),
    )

    it.effect('queries with page size limit', () =>
      Effect.gen(function* () {
        const result = yield* NotionDatabases.query({
          databaseId: TEST_IDS.database,
          pageSize: 1,
        })

        expect(result.results.length).toBe(1)
        // With only 3 rows and page size 1, has_more should be true
        expect(result.hasMore).toBe(true)
        expect(Option.isSome(result.nextCursor)).toBe(true)
      }).pipe(Effect.provide(IntegrationTestLayer)),
    )

    it.effect('queries with cursor for pagination', () =>
      Effect.gen(function* () {
        // First page
        const firstPage = yield* NotionDatabases.query({
          databaseId: TEST_IDS.database,
          pageSize: 1,
        })

        expect(firstPage.results.length).toBe(1)
        expect(Option.isSome(firstPage.nextCursor)).toBe(true)

        // Second page using cursor
        const secondPage = yield* NotionDatabases.query({
          databaseId: TEST_IDS.database,
          pageSize: 1,
          startCursor: Option.getOrThrow(firstPage.nextCursor),
        })

        expect(secondPage.results.length).toBe(1)
        // Verify different page was returned
        expect(secondPage.results[0]?.id).not.toBe(firstPage.results[0]?.id)
      }).pipe(Effect.provide(IntegrationTestLayer)),
    )
  })

  describe('queryStream', () => {
    it.effect(
      'streams all results across pages',
      () =>
        Effect.gen(function* () {
          const stream = NotionDatabases.queryStream({
            databaseId: TEST_IDS.database,
            pageSize: 1, // Force multiple pages
          })

          const items = yield* Stream.runCollect(stream).pipe(Effect.map((chunk) => [...chunk]))

          // Should get all 3 rows even with page size of 1
          expect(items.length).toBeGreaterThanOrEqual(3)

          // Verify all items are pages
          for (const item of items) {
            expect(item.object).toBe('page')
          }
        }).pipe(Effect.provide(IntegrationTestLayer)),
      { timeout: 30000 },
    )

    it.effect('streams with filter', () =>
      Effect.gen(function* () {
        const stream = NotionDatabases.queryStream({
          databaseId: TEST_IDS.database,
          filter: {
            property: 'Done',
            checkbox: { equals: true },
          },
        })

        const items = yield* Stream.runCollect(stream).pipe(Effect.map((chunk) => [...chunk]))

        // Alpha and Gamma have done = true
        expect(items.length).toBeGreaterThanOrEqual(2)
      }).pipe(Effect.provide(IntegrationTestLayer)),
    )
  })
})
