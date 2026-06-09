import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import type { Block } from '@overeng/notion-effect-schema'

import type { BlockTree } from './blocks.ts'
import { observeFromSnapshots } from './body-observation.ts'

const block = (opts: {
  readonly id: string
  readonly type: string
  readonly payload: Record<string, unknown>
  readonly hasChildren?: boolean
}): Block =>
  ({
    object: 'block',
    id: opts.id,
    parent: { type: 'page_id', page_id: '00000000-0000-4000-8000-000000000000' },
    type: opts.type,
    created_time: '2026-06-09T00:00:00.000Z',
    created_by: { object: 'user', id: '00000000-0000-4000-8000-000000000010' },
    last_edited_time: '2026-06-09T00:00:00.000Z',
    last_edited_by: { object: 'user', id: '00000000-0000-4000-8000-000000000010' },
    has_children: opts.hasChildren ?? false,
    in_trash: false,
    [opts.type]: opts.payload,
  }) as Block

const text = (content: string) => [
  {
    type: 'text',
    text: { content, link: null },
    annotations: {
      bold: false,
      italic: false,
      strikethrough: false,
      underline: false,
      code: false,
      color: 'default',
    },
    plain_text: content,
    href: null,
  },
]

describe('NotionBody.observeFromSnapshots', () => {
  it('classifies endpoint Markdown missing rendered content after a divider as lossy', async () => {
    const tree: BlockTree = [
      {
        block: block({
          id: '00000000-0000-4000-8000-000000000001',
          type: 'paragraph',
          payload: { rich_text: text('Before') },
        }),
        children: [],
      },
      {
        block: block({
          id: '00000000-0000-4000-8000-000000000002',
          type: 'divider',
          payload: {},
        }),
        children: [],
      },
      {
        block: block({
          id: '00000000-0000-4000-8000-000000000003',
          type: 'paragraph',
          payload: { rich_text: text('After') },
        }),
        children: [],
      },
    ]

    const observed = await Effect.runPromise(
      observeFromSnapshots({
        pageId: '00000000-0000-4000-8000-000000000020',
        markdown: {
          object: 'page_markdown',
          markdown: 'Before\n\n---',
          truncated: false,
          unknown_block_ids: [],
        },
        tree,
      }),
    )

    expect(observed.completeness).toEqual({
      _tag: 'lossy',
      reasons: ['rendered_markdown_has_unobserved_suffix'],
    })
    expect(observed.inventory.entries.map((entry) => entry.type)).toEqual([
      'paragraph',
      'divider',
      'paragraph',
    ])
  })

  it('classifies endpoint Markdown missing heading children as lossy', async () => {
    const tree: BlockTree = [
      {
        block: block({
          id: '00000000-0000-4000-8000-000000000004',
          type: 'heading_1',
          payload: { rich_text: text('Heading'), is_toggleable: true },
          hasChildren: true,
        }),
        children: [
          {
            block: block({
              id: '00000000-0000-4000-8000-000000000005',
              type: 'paragraph',
              payload: { rich_text: text('Nested child') },
            }),
            children: [],
          },
        ],
      },
    ]

    const observed = await Effect.runPromise(
      observeFromSnapshots({
        pageId: '00000000-0000-4000-8000-000000000020',
        markdown: {
          object: 'page_markdown',
          markdown: '# Heading',
          truncated: false,
          unknown_block_ids: [],
        },
        tree,
      }),
    )

    expect(observed.inventory.renderedMarkdown).toBe('# Heading\n\nNested child')
    expect(observed.completeness).toEqual({
      _tag: 'lossy',
      reasons: ['rendered_markdown_has_unobserved_suffix'],
    })
  })
})
