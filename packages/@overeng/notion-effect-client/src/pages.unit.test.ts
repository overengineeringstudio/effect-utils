import { Effect, Option } from 'effect'
import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import { NotionPages } from './pages.ts'
import { createTestLayer } from './test/test-utils.ts'

Vitest.describe('NotionPages.retrieveProperty', () => {
  Vitest.it.effect('calls the page-property endpoint with pagination query params', () => {
    const requests: Array<{ readonly method: string; readonly path: string }> = []

    return Effect.gen(function* () {
      const result = yield* NotionPages.retrieveProperty({
        pageId: 'page-1',
        propertyId: 'relation',
        startCursor: 'cursor-1',
        pageSize: 50,
      })

      expect(requests).toEqual([
        {
          method: 'GET',
          path: '/v1/pages/page-1/properties/relation?start_cursor=cursor-1&page_size=50',
        },
      ])
      expect(result.results).toEqual([
        {
          object: 'property_item',
          id: 'relation',
          type: 'relation',
          relation: { id: 'related-page-1' },
        },
      ])
      expect(result.hasMore).toBe(true)
      expect(Option.getOrNull(result.nextCursor)).toBe('cursor-2')
    }).pipe(
      Effect.provide(
        createTestLayer((request) => {
          const url = new URL(request.url)
          requests.push({ method: request.method, path: `${url.pathname}${url.search}` })

          return {
            status: 200,
            body: {
              object: 'list',
              type: 'property_item',
              property_item: {
                id: 'relation',
                type: 'relation',
                relation: {},
                next_url: null,
              },
              results: [
                {
                  object: 'property_item',
                  id: 'relation',
                  type: 'relation',
                  relation: { id: 'related-page-1' },
                },
              ],
              next_cursor: 'cursor-2',
              has_more: true,
            },
          }
        }),
      ),
    )
  })
})
