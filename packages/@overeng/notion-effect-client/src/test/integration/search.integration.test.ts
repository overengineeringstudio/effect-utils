import { Effect, Option, Schedule, Stream } from 'effect'
import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import { NotionDatabases } from '../../databases.ts'
import { NotionPages } from '../../pages.ts'
import { NotionSearch } from '../../search.ts'
import {
  IntegrationTestLayer,
  SKIP_FIXTURE_INTEGRATION,
  SKIP_INTEGRATION,
  TEST_PARENT_PAGE_ID,
} from './setup.ts'

Vitest.describe.skipIf(SKIP_INTEGRATION)('NotionSearch (integration)', () => {
  Vitest.it.effect('returns valid page or data source objects without a query', () =>
    Effect.gen(function* () {
      const result = yield* NotionSearch.search({ pageSize: 10 })
      for (const item of result.results) {
        expect(['page', 'data_source']).toContain(item.object)
        expect(item.id.length).toBeGreaterThan(0)
      }
    }).pipe(Effect.provide(IntegrationTestLayer)),
  )

  Vitest.it.effect('accepts an empty query even in an empty workspace', () =>
    NotionSearch.search({ query: '' }).pipe(Effect.provide(IntegrationTestLayer)),
  )

  Vitest.describe.skipIf(SKIP_FIXTURE_INTEGRATION)('isolated search fixtures', () => {
    Vitest.it.live(
      'finds run-scoped fixtures with filters, sorting, pagination, and streaming',
      () =>
        Effect.gen(function* () {
          const query = `effect-utils search fixture ${crypto.randomUUID()}`
          const title = [{ type: 'text', text: { content: query } }]
          const page = yield* Effect.acquireRelease(
            NotionPages.create({
              parent: { type: 'page_id', page_id: TEST_PARENT_PAGE_ID },
              properties: { title: { title } },
            }),
            (created) => NotionPages.archive({ pageId: created.id }).pipe(Effect.orDie),
          )
          const database = yield* Effect.acquireRelease(
            NotionDatabases.create({
              parent: { type: 'page_id', page_id: page.id },
              title,
              properties: { Name: { title: {} } },
            }),
            (created) => NotionDatabases.archive({ databaseId: created.id }).pipe(Effect.orDie),
          )
          const dataSourceId = database.data_sources?.[0]?.id
          expect(dataSourceId).toBeDefined()

          // Poll the actual search index, not a fixed delay. Bound the entire polling
          // effect, including HTTP requests and their rate-limit retries, to one minute.
          const indexed = yield* NotionSearch.search({ query }).pipe(
            Effect.repeat({
              schedule: Schedule.spaced('2 seconds'),
              until: (result) =>
                result.results.some((item) => item.id === page.id) &&
                result.results.some((item) => item.id === dataSourceId),
            }),
            Effect.timeout('60 seconds'),
          )
          expect(indexed.results.map((item) => item.id)).toEqual(
            expect.arrayContaining([page.id, dataSourceId]),
          )

          // Both object types exist for this query, so neither filter can pass
          // vacuously or simply return the unfiltered results.
          for (const [value, id] of [
            ['page', page.id],
            ['data_source', dataSourceId],
          ] as const) {
            const filtered = yield* NotionSearch.search({
              query,
              filter: { property: 'object', value },
            })
            expect(filtered.results.map((item) => item.id)).toContain(id)
            for (const item of filtered.results) expect(item.object).toBe(value)

            const streamed = yield* NotionSearch.searchStream({
              query,
              filter: { property: 'object', value },
              pageSize: 1,
            }).pipe(Stream.runCollect)
            expect(streamed.map((item) => item.id)).toContain(id)
            for (const item of streamed) expect(item.object).toBe(value)
          }

          const sorted = yield* NotionSearch.search({
            query,
            sort: { direction: 'descending', timestamp: 'last_edited_time' },
          })
          expect(sorted.results.map((item) => item.id)).toEqual(
            expect.arrayContaining([page.id, dataSourceId]),
          )

          const first = yield* NotionSearch.search({ query, pageSize: 1 })
          expect(first.results).toHaveLength(1)
          expect(first.hasMore).toBe(true)
          expect(Option.isSome(first.nextCursor)).toBe(true)
          const second = yield* NotionSearch.search({
            query,
            pageSize: 1,
            startCursor: Option.getOrThrow(first.nextCursor),
          })
          expect(second.results).toHaveLength(1)
          expect(second.results[0]?.id).not.toBe(first.results[0]?.id)

          const streamed = yield* NotionSearch.searchStream({ query, pageSize: 1 }).pipe(
            Stream.runCollect,
          )
          expect(streamed.map((item) => item.id)).toEqual(
            expect.arrayContaining([page.id, dataSourceId]),
          )
        }).pipe(Effect.scoped, Effect.provide(IntegrationTestLayer)),
      { timeout: 120000 },
    )
  })
})
