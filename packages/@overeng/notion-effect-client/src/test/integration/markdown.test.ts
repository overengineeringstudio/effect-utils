import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { expect } from 'vitest'
import { NotionMarkdown } from '../../markdown.ts'
import { IntegrationTestLayer, SKIP_INTEGRATION, TEST_IDS } from './setup.ts'

describe.skipIf(SKIP_INTEGRATION)('NotionMarkdown (integration)', () => {
  describe('pageToMarkdown', () => {
    it.effect(
      'converts a page with blocks to markdown',
      () =>
        Effect.gen(function* () {
          const markdown = yield* NotionMarkdown.pageToMarkdown({
            pageId: TEST_IDS.pageWithBlocks,
          })

          expect(markdown).toBeDefined()
          expect(typeof markdown).toBe('string')
          expect(markdown.length).toBeGreaterThan(0)

          // Should contain some expected markdown elements
          // The page has: paragraph, bullet list, code block, etc.
          expect(markdown).toContain('-') // Bullet list items
        }).pipe(Effect.provide(IntegrationTestLayer)),
      { timeout: 60000 },
    )

    it.effect(
      'converts a page with rich text formatting',
      () =>
        Effect.gen(function* () {
          const markdown = yield* NotionMarkdown.pageToMarkdown({
            pageId: TEST_IDS.richTextPage,
          })

          expect(markdown).toBeDefined()
          expect(typeof markdown).toBe('string')
          expect(markdown.length).toBeGreaterThan(0)

          // The rich text page has headings
          expect(markdown).toMatch(/^##\s/m) // Heading 2
        }).pipe(Effect.provide(IntegrationTestLayer)),
      { timeout: 60000 },
    )

    it.effect(
      'converts nested blocks correctly',
      () =>
        Effect.gen(function* () {
          const markdown = yield* NotionMarkdown.pageToMarkdown({
            pageId: TEST_IDS.nestedPage,
            maxDepth: 5,
          })

          expect(markdown).toBeDefined()
          expect(typeof markdown).toBe('string')
          expect(markdown.length).toBeGreaterThan(0)
        }).pipe(Effect.provide(IntegrationTestLayer)),
      { timeout: 60000 },
    )

    it.effect(
      'handles empty page',
      () =>
        Effect.gen(function* () {
          const markdown = yield* NotionMarkdown.pageToMarkdown({
            pageId: TEST_IDS.emptyPage,
          })

          expect(markdown).toBe('')
        }).pipe(Effect.provide(IntegrationTestLayer)),
      { timeout: 30000 },
    )

    it.effect(
      'supports custom transformers',
      () =>
        Effect.gen(function* () {
          const markdown = yield* NotionMarkdown.pageToMarkdown({
            pageId: TEST_IDS.pageWithBlocks,
            transformers: {
              // Custom transformer that adds a marker
              paragraph: (block, children) => {
                const typeData = block.paragraph as { rich_text?: { plain_text: string }[] }
                const text = typeData?.rich_text?.map((rt) => rt.plain_text).join('') ?? ''
                return `[P] ${text}${children ? `\n${children}` : ''}`
              },
            },
          })

          // Should have our custom marker for paragraphs
          expect(markdown).toContain('[P]')
        }).pipe(Effect.provide(IntegrationTestLayer)),
      { timeout: 60000 },
    )
  })
})
