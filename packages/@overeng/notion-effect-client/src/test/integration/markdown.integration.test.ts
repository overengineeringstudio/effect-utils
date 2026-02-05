import { Effect } from 'effect'
import { expect } from 'vitest'

import { RichTextUtils } from '@overeng/notion-effect-schema'
import { Vitest } from '@overeng/utils-dev/node-vitest'

import { BlockHelpers, NotionMarkdown } from '../../markdown.ts'
import { IntegrationTestLayer, SKIP_INTEGRATION, TEST_IDS } from './setup.ts'

Vitest.describe.skipIf(SKIP_INTEGRATION)('NotionMarkdown (integration)', () => {
  Vitest.describe('pageToMarkdown', () => {
    Vitest.it.effect(
      'converts all block types correctly',
      () =>
        Effect.gen(function* () {
          const markdown = yield* NotionMarkdown.pageToMarkdown({
            pageId: TEST_IDS.pageWithBlocks,
          })

          expect(markdown).toBeDefined()
          expect(typeof markdown).toBe('string')
          expect(markdown.length).toBeGreaterThan(0)

          // Headings
          expect(markdown).toMatch(/^# Heading 1$/m)
          expect(markdown).toMatch(/^## Heading 2$/m)
          expect(markdown).toMatch(/^### Heading 3$/m)

          // Paragraphs
          expect(markdown).toContain('simple paragraph')

          // Lists
          expect(markdown).toContain('- First bullet')
          expect(markdown).toContain('1. First numbered')

          // Quote
          expect(markdown).toContain('> This is a quote')

          // Code block
          expect(markdown).toContain('```typescript')
          expect(markdown).toContain('Hello, World!')

          // To-do items
          expect(markdown).toContain('[ ] Unchecked todo')
          expect(markdown).toContain('[x] Checked todo')

          // Divider
          expect(markdown).toContain('---')

          // Toggle (details/summary)
          expect(markdown).toContain('<details>')
          expect(markdown).toContain('<summary>')

          // Callout (blockquote with icon)
          expect(markdown).toMatch(/>\s*💡/)

          // Equation
          expect(markdown).toContain('$$')
          expect(markdown).toContain('E = mc^2')

          // Table
          expect(markdown).toContain('| Header 1 |')
          expect(markdown).toContain('| Cell A1 |')

          // Table of contents
          expect(markdown).toContain('[TOC]')
        }).pipe(Effect.provide(IntegrationTestLayer)),
      { timeout: 60000 },
    )

    Vitest.it.effect(
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

    Vitest.it.effect(
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

    Vitest.it.effect(
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

    Vitest.it.effect(
      'supports custom transformers with BlockHelpers',
      () =>
        Effect.gen(function* () {
          const markdown = yield* NotionMarkdown.pageToMarkdown({
            pageId: TEST_IDS.pageWithBlocks,
            transformers: {
              // Custom transformer using BlockHelpers
              paragraph: (block, children) => {
                const text = RichTextUtils.toPlainText(BlockHelpers.getRichText(block))
                return `[P] ${text}${children ? `\n${children}` : ''}`
              },
              // Custom callout using BlockHelpers
              callout: (block, children) => {
                const icon = BlockHelpers.getCalloutIcon(block)
                const text = RichTextUtils.toPlainText(BlockHelpers.getRichText(block))
                return `[CALLOUT ${icon}] ${text}${children ? `\n${children}` : ''}`
              },
            },
          })

          // Should have our custom markers
          expect(markdown).toContain('[P]')
          expect(markdown).toContain('[CALLOUT 💡]')
        }).pipe(Effect.provide(IntegrationTestLayer)),
      { timeout: 60000 },
    )
  })
})
