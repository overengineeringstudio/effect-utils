import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { Page, Paragraph } from '../../components/blocks.tsx'
import { renderToNotion } from '../../renderer/render-to-notion.ts'
import {
  archiveScratchPage,
  createScratchPage,
  IntegrationTestLayer,
  readPageTree,
  SKIP_INTEGRATION,
} from './setup.ts'

describe.skipIf(SKIP_INTEGRATION)('integration harness (smoke)', () => {
  it('creates a scratch page, renders a paragraph, reads it back, archives', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const pageId = yield* createScratchPage('smoke')
        try {
          yield* renderToNotion(
            <Page>
              <Paragraph>hello</Paragraph>
            </Page>,
            { pageId },
          )
          const tree = yield* readPageTree(pageId)
          const paragraph = tree.find((b) => b.type === 'paragraph')
          expect(paragraph).toBeDefined()
          const richText = (paragraph!.payload.rich_text ?? []) as readonly {
            plain_text?: string
          }[]
          expect(richText[0]?.plain_text).toBe('hello')
        } finally {
          yield* archiveScratchPage(pageId)
        }
      }).pipe(Effect.provide(IntegrationTestLayer)),
    )
  }, 60_000)
})
