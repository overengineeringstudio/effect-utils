import { describe, expect, it } from '@effect/vitest'
import { Effect, Option, Schema, Stream } from 'effect'

import { NotionSearch } from './search.ts'
import { collectSearchFixtures, collectStream, createTestLayer } from './test/test-utils.ts'

describe('NotionSearch pagination', () => {
  it.effect('observes every fixture before stopping without fetching unrelated trailing pages', () =>
    Effect.gen(function* () {
      for (const expectedIds of [['page-one'], ['page-one', 'source-one']]) {
        const pages = [
          { object: 'page', id: 'unrelated-before' },
          { object: 'page', id: 'page-one' },
          { object: 'page', id: 'unrelated-between' },
          { object: 'data_source', id: 'source-one' },
        ]
        let requests = 0
        const layer = createTestLayer(() => {
          const item = pages[requests++]
          expect(item).toBeDefined()
          return {
            status: 200,
            body: {
              object: 'list',
              results: [item],
              has_more: true,
              next_cursor: `cursor-${requests}`,
            },
          }
        })
        const observed = collectSearchFixtures(
          NotionSearch.searchStream({ query: 'unique-run-token', pageSize: 1 }),
          expectedIds,
        ).pipe(Effect.provide(layer))
        // Re-execution must not reuse a previous attempt's completed membership set.
        for (let attempt = 0; attempt < 2; attempt++) {
          requests = 0
          const items = yield* observed
          const expectedCount = expectedIds.length === 1 ? 2 : 4
          expect(items).toEqual(pages.slice(0, expectedCount))
          expect(requests).toBe(expectedCount)
          expect(items.map((item) => item.id)).toEqual(expect.arrayContaining(expectedIds))
        }
      }
    }),
  )

  it.effect('does not manufacture missing fixtures when the stream ends', () =>
    Effect.gen(function* () {
      const available = [{ id: 'page-one' }, { id: 'unrelated' }]
      const items = yield* collectSearchFixtures(Stream.fromIterable(available), [
        'page-one',
        'missing-source',
      ])
      expect(items).toEqual(available)
      expect(items.some((item) => item.id === 'missing-source')).toBe(false)
    }),
  )

  it.effect.prop(
    'forwards opaque cursors unchanged through manual and streamed pages, including an empty page',
    [Schema.String, Schema.String, Schema.String],
    ([first, second, third]) =>
      Effect.gen(function* () {
        // Prefixes keep the cursors distinct and ensure punctuation and Unicode in every run.
        const cursors = [
          `first:游標+/=?&%\n"${first}`,
          `second:🧭/+=?&%${second}`,
          `third:é+/=?&%${third}`,
        ]
        const results = [
          { object: 'page', id: 'page-one' },
          { object: 'data_source', id: 'source-one' },
          { object: 'page', id: 'page-two' },
          { object: 'data_source', id: 'source-two' },
          { object: 'page', id: 'page-three' },
        ] as const
        const pages = [
          { object: 'list', results: results.slice(0, 2), has_more: true, next_cursor: cursors[0] },
          { object: 'list', results: [], has_more: true, next_cursor: cursors[1] },
          { object: 'list', results: results.slice(2, 3), has_more: true, next_cursor: cursors[2] },
          { object: 'list', results: results.slice(3), has_more: false, next_cursor: null },
        ]
        const options = {
          query: 'effect-utils search fixture',
          pageSize: 2,
          sort: { direction: 'descending', timestamp: 'last_edited_time' },
        } as const
        const expectedBodies = [undefined, ...cursors].map((cursor) => {
          const body: Record<string, unknown> = {
            query: options.query,
            page_size: options.pageSize,
            sort: options.sort,
          }
          if (cursor !== undefined) body.start_cursor = cursor
          return body
        })
        for (const mode of ['manual', 'stream'] as const) {
          const bodies: unknown[] = []
          const layer = createTestLayer((request) => {
            expect(request.method).toBe('POST')
            expect(new URL(request.url).pathname).toBe('/v1/search')
            const body = request.body
            expect(body._tag).toBe('Uint8Array')
            if (body._tag === 'Uint8Array') {
              bodies.push(
                Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(
                  new TextDecoder().decode(body.body),
                ),
              )
            }
            const page = pages[bodies.length - 1]
            expect(page).toBeDefined()
            return { status: 200, body: page }
          })
          if (mode === 'manual') {
            let cursor = Option.none<string>()
            const collected: { readonly object: 'page' | 'data_source'; readonly id: string }[] = []
            for (const page of pages) {
              const result = yield* NotionSearch.search({
                ...options,
                ...(Option.isSome(cursor) === true ? { startCursor: cursor.value } : {}),
              }).pipe(Effect.provide(layer))
              expect(result.results).toEqual(page.results)
              expect(result.hasMore).toBe(page.has_more)
              expect(result.nextCursor).toEqual(Option.fromNullOr(page.next_cursor))
              collected.push(...result.results)
              cursor = result.nextCursor
            }
            expect(collected).toEqual(results)
          } else {
            const collected = yield* collectStream(NotionSearch.searchStream(options)).pipe(
              Effect.provide(layer),
            )
            expect(collected).toEqual(results)
          }
          // Exactly four requests: the empty non-terminal page continues and null terminates.
          expect(bodies).toEqual(expectedBodies)
        }
      }),
  )
})
