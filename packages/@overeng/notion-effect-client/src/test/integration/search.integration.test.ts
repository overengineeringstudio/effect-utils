import { Effect, Stream } from 'effect'
import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import { NotionSearch } from '../../search.ts'
import { IntegrationTestLayer, SKIP_INTEGRATION } from './setup.ts'

Vitest.describe.skipIf(SKIP_INTEGRATION)('NotionSearch (integration)', () => {
  Vitest.describe('search', () => {
    Vitest.it.effect('searches for pages and databases', () =>
      Effect.gen(function* () {
        const result = yield* NotionSearch.search({
          query: 'Test',
        })

        // Should find at least the test page and database
        expect(result.results.length).toBeGreaterThanOrEqual(1)
      }).pipe(Effect.provide(IntegrationTestLayer)),
    )

    Vitest.it.effect('filters to pages only', () =>
      Effect.gen(function* () {
        const result = yield* NotionSearch.search({
          query: 'Test',
          filter: { property: 'object', value: 'page' },
        })

        // All results should be pages
        for (const item of result.results) {
          expect(item.object).toBe('page')
        }
      }).pipe(Effect.provide(IntegrationTestLayer)),
    )

    Vitest.it.effect('filters to databases only', () =>
      Effect.gen(function* () {
        const result = yield* NotionSearch.search({
          query: 'Test',
          filter: { property: 'object', value: 'database' },
        })

        // All results should be databases
        for (const item of result.results) {
          expect(item.object).toBe('database')
        }
      }).pipe(Effect.provide(IntegrationTestLayer)),
    )

    Vitest.it.effect('sorts by last_edited_time', () =>
      Effect.gen(function* () {
        const result = yield* NotionSearch.search({
          sort: { direction: 'descending', timestamp: 'last_edited_time' },
          pageSize: 10,
        })

        expect(result.results.length).toBeGreaterThanOrEqual(1)
      }).pipe(Effect.provide(IntegrationTestLayer)),
    )

    Vitest.it.effect('paginates results', () =>
      Effect.gen(function* () {
        const result = yield* NotionSearch.search({
          pageSize: 1,
        })

        expect(result.results.length).toBe(1)
      }).pipe(Effect.provide(IntegrationTestLayer)),
    )
  })

  Vitest.describe('searchStream', () => {
    Vitest.it.effect(
      'streams all search results',
      () =>
        Effect.gen(function* () {
          const stream = NotionSearch.searchStream({
            query: 'Test',
            pageSize: 1, // Force multiple pages
          })

          const items = yield* Stream.runCollect(stream).pipe(Effect.map((chunk) => [...chunk]))

          expect(items.length).toBeGreaterThanOrEqual(1)
        }).pipe(Effect.provide(IntegrationTestLayer)),
      { timeout: 30000 },
    )

    Vitest.it.effect('streams with filter', () =>
      Effect.gen(function* () {
        const stream = NotionSearch.searchStream({
          filter: { property: 'object', value: 'database' },
          pageSize: 1,
        })

        const items = yield* Stream.runCollect(stream).pipe(Effect.map((chunk) => [...chunk]))

        for (const item of items) {
          expect(item.object).toBe('database')
        }
      }).pipe(Effect.provide(IntegrationTestLayer)),
    )
  })
})
