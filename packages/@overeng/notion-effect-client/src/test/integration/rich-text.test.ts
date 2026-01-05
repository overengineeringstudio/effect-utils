import { describe, it } from '@effect/vitest'
import { Effect, Stream } from 'effect'
import { expect } from 'vitest'

import { RichTextUtils } from '@overeng/notion-effect-schema'

import { NotionBlocks } from '../../blocks.ts'
import { IntegrationTestLayer, SKIP_INTEGRATION, TEST_IDS } from './setup.ts'

describe.skipIf(SKIP_INTEGRATION)('RichTextUtils with real Notion data (integration)', () => {
  it.effect(
    'converts paragraph rich text to plain text',
    () =>
      Effect.gen(function* () {
        const stream = NotionBlocks.retrieveChildrenStream({
          blockId: TEST_IDS.richTextPage,
        })

        const blocks = yield* Stream.runCollect(stream).pipe(Effect.map((chunk) => [...chunk]))

        // Find a paragraph block
        const paragraphBlock = blocks.find((b) => b.type === 'paragraph')
        expect(paragraphBlock).toBeDefined()

        if (paragraphBlock) {
          const blockData = paragraphBlock as { paragraph?: { rich_text?: unknown[] } }
          const richText = blockData.paragraph?.rich_text ?? []

          if (richText.length > 0) {
            const plainText = RichTextUtils.toPlainText(
              richText as Parameters<typeof RichTextUtils.toPlainText>[0],
            )
            expect(typeof plainText).toBe('string')
          }
        }
      }).pipe(Effect.provide(IntegrationTestLayer)),
    { timeout: 30000 },
  )

  it.effect(
    'converts heading rich text to markdown',
    () =>
      Effect.gen(function* () {
        const stream = NotionBlocks.retrieveChildrenStream({
          blockId: TEST_IDS.richTextPage,
        })

        const blocks = yield* Stream.runCollect(stream).pipe(Effect.map((chunk) => [...chunk]))

        // Find a heading block
        const headingBlock = blocks.find(
          (b) => b.type === 'heading_1' || b.type === 'heading_2' || b.type === 'heading_3',
        )

        if (headingBlock) {
          const blockData = headingBlock as unknown as { [key: string]: { rich_text?: unknown[] } }
          const richText = blockData[headingBlock.type]?.rich_text ?? []

          if (richText.length > 0) {
            const markdown = RichTextUtils.toMarkdown(
              richText as Parameters<typeof RichTextUtils.toMarkdown>[0],
            )
            expect(typeof markdown).toBe('string')
          }
        }
      }).pipe(Effect.provide(IntegrationTestLayer)),
    { timeout: 30000 },
  )

  it.effect(
    'converts rich text with formatting to HTML',
    () =>
      Effect.gen(function* () {
        const stream = NotionBlocks.retrieveChildrenStream({
          blockId: TEST_IDS.richTextPage,
        })

        const blocks = yield* Stream.runCollect(stream).pipe(Effect.map((chunk) => [...chunk]))

        // Find a paragraph block with rich text
        for (const block of blocks) {
          if (block.type === 'paragraph') {
            const blockData = block as { paragraph?: { rich_text?: unknown[] } }
            const richText = blockData.paragraph?.rich_text ?? []

            if (richText.length > 0) {
              const html = RichTextUtils.toHtml(
                richText as Parameters<typeof RichTextUtils.toHtml>[0],
              )
              expect(typeof html).toBe('string')
              // HTML should not be empty if there's rich text
              expect(html.length).toBeGreaterThan(0)
              break
            }
          }
        }
      }).pipe(Effect.provide(IntegrationTestLayer)),
    { timeout: 30000 },
  )
})
