import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { expect } from 'vitest'

import { NotionPages } from '../../pages.ts'
import { IntegrationTestLayer, SKIP_INTEGRATION, SKIP_MUTATIONS, TEST_IDS } from './setup.ts'

describe.skipIf(SKIP_INTEGRATION)('NotionPages (integration)', () => {
  describe('retrieve', () => {
    it.effect('fetches page by ID', () =>
      Effect.gen(function* () {
        const page = yield* NotionPages.retrieve({
          pageId: TEST_IDS.pageWithBlocks,
        })

        expect(page.object).toBe('page')
        // Notion API returns UUIDs with dashes
        expect(page.id.replace(/-/g, '')).toBe(TEST_IDS.pageWithBlocks.replace(/-/g, ''))
      }).pipe(Effect.provide(IntegrationTestLayer)),
    )

    it.effect('fetches database row as page', () =>
      Effect.gen(function* () {
        const page = yield* NotionPages.retrieve({
          pageId: TEST_IDS.rows.alpha,
        })

        expect(page.object).toBe('page')
        // Notion API returns UUIDs with dashes
        expect(page.id.replace(/-/g, '')).toBe(TEST_IDS.rows.alpha.replace(/-/g, ''))
      }).pipe(Effect.provide(IntegrationTestLayer)),
    )
  })

  describe.skipIf(SKIP_MUTATIONS)('create', () => {
    const createdPageIds: string[] = []

    it.effect(
      'creates a new page in database',
      () =>
        Effect.gen(function* () {
          const page = yield* NotionPages.create({
            parent: { type: 'database_id', database_id: TEST_IDS.database },
            properties: {
              Name: {
                title: [{ text: { content: 'Integration Test Page' } }],
              },
              Status: {
                select: { name: 'draft' },
              },
              Priority: {
                number: 99,
              },
            },
          })

          expect(page.object).toBe('page')
          expect(page.id).toBeDefined()
          createdPageIds.push(page.id)

          // Clean up: archive the created page
          yield* NotionPages.archive({ pageId: page.id })
        }).pipe(Effect.provide(IntegrationTestLayer)),
      { timeout: 30000 },
    )
  })

  describe.skipIf(SKIP_MUTATIONS)('update', () => {
    it.effect(
      'updates page properties',
      () =>
        Effect.gen(function* () {
          // Create a temporary page for update testing
          const created = yield* NotionPages.create({
            parent: { type: 'database_id', database_id: TEST_IDS.database },
            properties: {
              Name: {
                title: [{ text: { content: 'Update Test Page' } }],
              },
              Priority: {
                number: 1,
              },
            },
          })

          // Update the page
          const updated = yield* NotionPages.update({
            pageId: created.id,
            properties: {
              Priority: {
                number: 100,
              },
            },
          })

          expect(updated.object).toBe('page')
          expect(updated.id).toBe(created.id)

          // Clean up
          yield* NotionPages.archive({ pageId: created.id })
        }).pipe(Effect.provide(IntegrationTestLayer)),
      { timeout: 30000 },
    )
  })

  describe.skipIf(SKIP_MUTATIONS)('archive', () => {
    it.effect(
      'archives a page',
      () =>
        Effect.gen(function* () {
          // Create a temporary page to archive
          const created = yield* NotionPages.create({
            parent: { type: 'database_id', database_id: TEST_IDS.database },
            properties: {
              Name: {
                title: [{ text: { content: 'Archive Test Page' } }],
              },
            },
          })

          // Archive the page
          const archived = yield* NotionPages.archive({ pageId: created.id })

          expect(archived.object).toBe('page')
          expect(archived.id).toBe(created.id)
        }).pipe(Effect.provide(IntegrationTestLayer)),
      { timeout: 30000 },
    )
  })
})
