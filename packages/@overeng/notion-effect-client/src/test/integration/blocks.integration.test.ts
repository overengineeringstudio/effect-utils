import { describe, it } from '@effect/vitest'
import { Effect, Stream } from 'effect'
import { expect } from 'vitest'

import { NotionBlocks } from '../../blocks.ts'
import { NotionPages } from '../../pages.ts'
import { IntegrationTestLayer, SKIP_INTEGRATION, SKIP_MUTATIONS, TEST_IDS } from './setup.ts'

describe.skipIf(SKIP_INTEGRATION)('NotionBlocks (integration)', () => {
  describe('retrieveChildren', () => {
    it.effect('fetches children of a page', () =>
      Effect.gen(function* () {
        const result = yield* NotionBlocks.retrieveChildren({
          blockId: TEST_IDS.pageWithBlocks,
        })

        // Test page has: paragraph, bullet list (3 items), code block, child page
        expect(result.results.length).toBeGreaterThanOrEqual(1)
        expect(result.results[0]?.object).toBe('block')
      }).pipe(Effect.provide(IntegrationTestLayer)),
    )

    it.effect('fetches with page size limit', () =>
      Effect.gen(function* () {
        const result = yield* NotionBlocks.retrieveChildren({
          blockId: TEST_IDS.pageWithBlocks,
          pageSize: 1,
        })

        expect(result.results.length).toBe(1)
      }).pipe(Effect.provide(IntegrationTestLayer)),
    )
  })

  describe('retrieveChildrenStream', () => {
    it.effect(
      'streams all children',
      () =>
        Effect.gen(function* () {
          const stream = NotionBlocks.retrieveChildrenStream({
            blockId: TEST_IDS.pageWithBlocks,
            pageSize: 1, // Force multiple pages
          })

          const items = yield* Stream.runCollect(stream).pipe(Effect.map((chunk) => [...chunk]))

          // Should get all blocks
          expect(items.length).toBeGreaterThanOrEqual(1)
          for (const item of items) {
            expect(item.object).toBe('block')
          }
        }).pipe(Effect.provide(IntegrationTestLayer)),
      { timeout: 30000 },
    )
  })

  describe('retrieve', () => {
    it.effect('fetches a specific block by ID', () =>
      Effect.gen(function* () {
        // First get children to find a block ID
        const children = yield* NotionBlocks.retrieveChildren({
          blockId: TEST_IDS.pageWithBlocks,
          pageSize: 1,
        })

        const firstBlock = children.results[0]
        expect(firstBlock).toBeDefined()
        if (!firstBlock) throw new Error('Expected at least one block')

        // Now retrieve that specific block
        const block = yield* NotionBlocks.retrieve({
          blockId: firstBlock.id,
        })

        expect(block.object).toBe('block')
        expect(block.id).toBe(firstBlock.id)
      }).pipe(Effect.provide(IntegrationTestLayer)),
    )
  })

  describe.skipIf(SKIP_MUTATIONS)('append', () => {
    it.effect(
      'appends a block to a page',
      () =>
        Effect.gen(function* () {
          // Create a temporary page for block mutation testing
          const tempPage = yield* NotionPages.create({
            parent: { type: 'page_id', page_id: TEST_IDS.rootPage },
            properties: {
              title: {
                title: [{ text: { content: 'Block Test Page' } }],
              },
            },
          })

          // Append a paragraph block
          const result = yield* NotionBlocks.append({
            blockId: tempPage.id,
            children: [
              {
                object: 'block',
                type: 'paragraph',
                paragraph: {
                  rich_text: [
                    { type: 'text', text: { content: 'Test paragraph from integration test' } },
                  ],
                },
              },
            ],
          })

          expect(result.object).toBe('list')
          expect(result.results.length).toBe(1)
          expect(result.results[0]?.type).toBe('paragraph')

          // Clean up
          yield* NotionPages.archive({ pageId: tempPage.id })
        }).pipe(Effect.provide(IntegrationTestLayer)),
      { timeout: 30000 },
    )
  })

  describe.skipIf(SKIP_MUTATIONS)('update', () => {
    it.effect(
      'updates a block',
      () =>
        Effect.gen(function* () {
          // Create a temporary page with a block
          const tempPage = yield* NotionPages.create({
            parent: { type: 'page_id', page_id: TEST_IDS.rootPage },
            properties: {
              title: {
                title: [{ text: { content: 'Update Block Test Page' } }],
              },
            },
          })

          // Append a paragraph block
          const appendResult = yield* NotionBlocks.append({
            blockId: tempPage.id,
            children: [
              {
                object: 'block',
                type: 'paragraph',
                paragraph: {
                  rich_text: [{ type: 'text', text: { content: 'Original text' } }],
                },
              },
            ],
          })

          const block = appendResult.results[0]
          if (!block) throw new Error('Expected appended block')

          // Update the block
          const updated = yield* NotionBlocks.update({
            blockId: block.id,
            paragraph: {
              rich_text: [{ type: 'text', text: { content: 'Updated text' } }],
            },
          })

          expect(updated.object).toBe('block')
          expect(updated.id).toBe(block.id)

          // Clean up
          yield* NotionPages.archive({ pageId: tempPage.id })
        }).pipe(Effect.provide(IntegrationTestLayer)),
      { timeout: 30000 },
    )
  })

  describe.skipIf(SKIP_MUTATIONS)('delete', () => {
    it.effect(
      'deletes a block',
      () =>
        Effect.gen(function* () {
          // Create a temporary page with a block
          const tempPage = yield* NotionPages.create({
            parent: { type: 'page_id', page_id: TEST_IDS.rootPage },
            properties: {
              title: {
                title: [{ text: { content: 'Delete Block Test Page' } }],
              },
            },
          })

          // Append a paragraph block
          const appendResult = yield* NotionBlocks.append({
            blockId: tempPage.id,
            children: [
              {
                object: 'block',
                type: 'paragraph',
                paragraph: {
                  rich_text: [{ type: 'text', text: { content: 'To be deleted' } }],
                },
              },
            ],
          })

          const blockToDelete = appendResult.results[0]
          if (!blockToDelete) throw new Error('Expected appended block')

          // Delete the block
          const deleted = yield* NotionBlocks.delete({ blockId: blockToDelete.id })

          expect(deleted.object).toBe('block')
          expect(deleted.id).toBe(blockToDelete.id)

          // Clean up
          yield* NotionPages.archive({ pageId: tempPage.id })
        }).pipe(Effect.provide(IntegrationTestLayer)),
      { timeout: 30000 },
    )
  })
})
