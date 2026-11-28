import { describe, expect, it } from 'vitest'

import { tolerateTreeChildPages } from '@overeng/notion-core'
import { NotionBody, type BlockTree } from '@overeng/notion-effect-client'
import type { Block } from '@overeng/notion-effect-schema'

import { remoteMarkdownCompleteness } from './model.ts'

const tree = (type: string, payload: Record<string, unknown> = {}): BlockTree => [
  {
    block: {
      id: '00000000-0000-4000-8000-000000000002',
      type,
      has_children: false,
      in_trash: false,
      [type]: payload,
    } as Block,
    children: [],
  },
]

const classify = (blocks: BlockTree, renderedMarkdown: string) =>
  NotionBody.classifyRenderedTypes({
    tree: blocks,
    renderedMarkdown,
    completeness: { _tag: 'complete' },
  })

describe('rendered body type completeness', () => {
  it.each([
    ['callout', '> Note', '<callout icon="💡">Note</callout>'],
    ['table', '| Cell |', '<table><tr><td>Cell</td></tr></table>'],
    ['table_row', '| Cell |', '<tr><td>Cell</td></tr>'],
    ['toggle', 'Summary', '<details><summary>Summary</summary></details>'],
  ])('refuses flattened %s but accepts its native construct', (type, lossy, native) => {
    expect(classify(tree(type), lossy)).toEqual({
      _tag: 'lossy',
      reasons: ['rendered_markdown_missing_types'],
      lossyBlockTypes: [type],
    })
    expect(classify(tree(type), native)).toEqual({ _tag: 'complete' })
  })

  it.each(['page', 'database', 'date', 'user'])(
    'requires native %s mentions, including table cells',
    (type) => {
      const mention = { type: 'mention', mention: { type } }
      const blocks = tree('table_row', { cells: [[mention]] })
      expect(classify(blocks, '<tr><td>[Label](https://notion.so/id)</td></tr>')).toEqual({
        _tag: 'lossy',
        reasons: ['rendered_markdown_missing_types'],
        lossyBlockTypes: ['table_row'],
      })
      expect(classify(blocks, `<tr><td><mention-${type} url="id"/></td></tr>`)).toEqual({
        _tag: 'complete',
      })
    },
  )

  it('refuses unknown block types and non-emoji callout icons', () => {
    expect(classify(tree('future_block'), 'Flattened')).toEqual({
      _tag: 'lossy',
      reasons: ['unsupported_blocks'],
      lossyBlockTypes: ['future_block'],
    })
    expect(
      classify(
        tree('callout', {
          icon: { type: 'external', external: { url: 'https://example.com/icon.png' } },
        }),
        '<callout>Note</callout>',
      ),
    ).toEqual({
      _tag: 'lossy',
      reasons: ['unsupported_blocks'],
      lossyBlockTypes: ['callout'],
    })
  })

  it('checks nested construct counts rather than mere tag presence', () => {
    const blocks: BlockTree = [{ ...tree('callout')[0]!, children: tree('callout') }]
    expect(classify(blocks, '<callout>One</callout>\n\n> Two')).toMatchObject({ _tag: 'lossy' })
    expect(classify(blocks, '<callout>One\n<callout>Two</callout></callout>')).toEqual({
      _tag: 'complete',
    })
  })

  it('does not count fenced code examples as construct evidence', () => {
    expect(
      classify(tree('callout'), '```xml\n<callout>Example</callout>\n```\n\n> Real'),
    ).toMatchObject({
      _tag: 'lossy',
    })
  })

  it('keeps other completeness failures when type coverage succeeds', () => {
    expect(
      NotionBody.classifyRenderedTypes({
        tree: tree('callout'),
        renderedMarkdown: '<callout>Note</callout>',
        completeness: { _tag: 'lossy', reasons: ['endpoint_truncated', 'unknown_blocks'] },
      }),
    ).toEqual({ _tag: 'lossy', reasons: ['endpoint_truncated', 'unknown_blocks'] })
  })

  it('tree child-page tolerance cannot erase a missing non-anchor construct', () => {
    const completeness = NotionBody.classifyRenderedTypes({
      tree: [...tree('child_page'), ...tree('callout')],
      renderedMarkdown: '<page url="id">Child</page>\n\n> Note',
      completeness: {
        _tag: 'lossy',
        reasons: ['not_round_trip_safe_blocks'],
        lossyBlockTypes: ['child_page'],
      },
    })
    expect(tolerateTreeChildPages(completeness)).toEqual({
      _tag: 'lossy',
      reasons: ['rendered_markdown_missing_types'],
      lossyBlockTypes: ['callout'],
    })
  })
})

describe('remote Markdown completeness policy', () => {
  it('refuses raw endpoint flags when block-observation evidence is absent', () => {
    expect(
      remoteMarkdownCompleteness({
        markdown: 'Partial',
        truncated: true,
        unknown_block_ids: ['missing'],
      }),
    ).toMatchObject({ _tag: 'lossy', reasons: ['endpoint_truncated', 'unknown_blocks'] })
  })

  it('preserves an authoritative observation verdict accounting for unsupported storage', () => {
    const completeness = { _tag: 'complete' } as const
    expect(
      remoteMarkdownCompleteness({
        markdown: 'Body with preserved unsupported storage',
        truncated: true,
        unknown_block_ids: ['stored-block'],
        completeness,
      }),
    ).toBe(completeness)
  })
})

describe('other known lossy projections', () => {
  it.each(['video', 'audio', 'file', 'pdf'])('requires native %s rather than a link', (type) => {
    expect(classify(tree(type), '[Media](https://example.com/media)')).toMatchObject({
      _tag: 'lossy',
      reasons: ['rendered_markdown_missing_types'],
      lossyBlockTypes: [type],
    })
    expect(classify(tree(type), `<${type} src="https://example.com/media"/>`)).toEqual({
      _tag: 'complete',
    })
  })

  it.each(['template_mention', 'future_mention'])(
    'refuses unmodeled %s mention semantics',
    (type) => {
      expect(
        classify(
          tree('paragraph', {
            rich_text: [{ type: 'mention', mention: { type } }],
          }),
          'Label',
        ),
      ).toEqual({
        _tag: 'lossy',
        reasons: ['unsupported_blocks'],
        lossyBlockTypes: [`mention:${type}`, 'paragraph'],
      })
    },
  )
})
