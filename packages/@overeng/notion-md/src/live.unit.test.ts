import { describe, expect, it } from '@effect/vitest'

import type { NotionBodyObservation } from '@overeng/notion-effect-client'

import { remoteMarkdownFromBodyObservation } from './live.ts'

describe('remoteMarkdownFromBodyObservation', () => {
  it('adopts block-tree-rendered Markdown instead of endpoint Markdown', () => {
    const observation: NotionBodyObservation = {
      pageId: '00000000-0000-4000-8000-000000000001',
      markdown: {
        markdown: '## Section\nParagraph that the endpoint left adjacent\n---\n',
        truncated: false,
        unknownBlockIds: [],
      },
      inventory: {
        entries: [
          {
            id: '00000000-0000-4000-8000-000000000002',
            type: 'heading_2',
            hasChildren: false,
            inTrash: false,
          },
          {
            id: '00000000-0000-4000-8000-000000000003',
            type: 'paragraph',
            hasChildren: false,
            inTrash: false,
          },
          {
            id: '00000000-0000-4000-8000-000000000004',
            type: 'divider',
            hasChildren: false,
            inTrash: false,
          },
        ],
        renderedMarkdown: '## Section\n\nParagraph that the endpoint left adjacent\n\n---',
      },
      completeness: { _tag: 'complete' },
    }

    expect(remoteMarkdownFromBodyObservation(observation)).toEqual({
      markdown: '## Section\n\nParagraph that the endpoint left adjacent\n\n---\n',
      endpoint_markdown: '## Section\nParagraph that the endpoint left adjacent\n---\n',
      truncated: false,
      unknown_block_ids: [],
      completeness: { _tag: 'complete' },
    })
  })

  it('fails closed when block-tree-rendered Markdown is unavailable', () => {
    const observation: NotionBodyObservation = {
      pageId: '00000000-0000-4000-8000-000000000001',
      markdown: {
        markdown: 'Endpoint only',
        truncated: false,
        unknownBlockIds: [],
      },
      inventory: {
        entries: [],
      },
      completeness: { _tag: 'complete' },
    }

    expect(remoteMarkdownFromBodyObservation(observation)).toEqual({
      markdown: 'Endpoint only\n',
      endpoint_markdown: 'Endpoint only\n',
      truncated: false,
      unknown_block_ids: [],
      completeness: {
        _tag: 'lossy',
        reasons: ['rendered_markdown_unavailable'],
      },
    })
  })
})
