import { describe, expect, it } from 'vitest'

import {
  classifyBodyCompleteness,
  describeBodyLossyRefusal,
  stableBodyFidelityStringify,
  tolerateTreeChildPages,
  type BodyCompleteness,
} from './body-fidelity.ts'

describe('classifyBodyCompleteness', () => {
  const inventory = {
    entries: [
      {
        id: '00000000-0000-4000-8000-000000000001',
        type: 'paragraph',
        hasChildren: false,
        inTrash: false,
      },
    ],
  }

  it('accepts a complete endpoint Markdown observation', () => {
    expect(
      classifyBodyCompleteness({
        markdown: { markdown: 'Before\n\n---\n\nAfter', truncated: false, unknownBlockIds: [] },
        inventory: { ...inventory, renderedMarkdown: 'Before\n\n---\n\nAfter' },
      }),
    ).toEqual({ _tag: 'complete' })
  })

  it('marks endpoint truncation and unknown blocks as lossy', () => {
    expect(
      classifyBodyCompleteness({
        markdown: {
          markdown: 'Before',
          truncated: true,
          unknownBlockIds: ['00000000-0000-4000-8000-000000000002'],
        },
        inventory,
      }),
    ).toEqual({
      _tag: 'lossy',
      reasons: ['endpoint_truncated', 'unknown_blocks'],
      lossyBlockTypes: [],
    })
  })

  it('marks rendered suffix missing from endpoint Markdown as lossy', () => {
    expect(
      classifyBodyCompleteness({
        markdown: { markdown: 'Before\n\n---', truncated: false, unknownBlockIds: [] },
        inventory: {
          ...inventory,
          renderedMarkdown: 'Before\n\n---\n\nAfter',
        },
      }),
    ).toEqual({
      _tag: 'lossy',
      reasons: ['rendered_markdown_has_unobserved_suffix'],
      lossyBlockTypes: [],
    })
  })

  it('marks empty endpoint Markdown with non-empty rendered Markdown as lossy', () => {
    expect(
      classifyBodyCompleteness({
        markdown: { markdown: '', truncated: false, unknownBlockIds: [] },
        inventory: {
          ...inventory,
          renderedMarkdown: 'Rendered content',
        },
      }),
    ).toEqual({
      _tag: 'lossy',
      reasons: ['rendered_markdown_has_unobserved_suffix'],
      lossyBlockTypes: [],
    })
  })

  it('accepts empty endpoint Markdown when rendered Markdown is also empty', () => {
    expect(
      classifyBodyCompleteness({
        markdown: { markdown: '', truncated: false, unknownBlockIds: [] },
        inventory: {
          ...inventory,
          renderedMarkdown: '',
        },
      }),
    ).toEqual({ _tag: 'complete' })
  })

  it('accepts empty endpoint Markdown when no rendered Markdown evidence exists', () => {
    expect(
      classifyBodyCompleteness({
        markdown: { markdown: '', truncated: false, unknownBlockIds: [] },
        inventory,
      }),
    ).toEqual({ _tag: 'complete' })
  })

  it('classifies unsupported block inventory as lossy', () => {
    expect(
      classifyBodyCompleteness({
        markdown: {
          markdown: '<unknown alt="unsupported"/>',
          truncated: false,
          unknownBlockIds: [],
        },
        inventory: {
          entries: [
            {
              id: '00000000-0000-4000-8000-000000000003',
              type: 'unsupported',
              hasChildren: false,
              inTrash: false,
            },
          ],
        },
      }),
    ).toEqual({
      _tag: 'lossy',
      reasons: ['unsupported_blocks'],
      lossyBlockTypes: ['unsupported'],
    })
  })

  const blockInventory = (type: string) => ({
    entries: [{ id: `id-${type}`, type, hasChildren: false, inTrash: false }],
  })

  // R38: a block whose body-Markdown rendering does not reparse to the same
  // block (round-trip-safety) must classify lossy so the pull gate refuses it.
  for (const type of [
    'child_database',
    'table_of_contents',
    'synced_block',
    'child_page',
    'breadcrumb',
    'bookmark',
    'embed',
    'link_preview',
    'link_to_page',
  ]) {
    it(`classifies not-round-trip-safe block "${type}" as lossy`, () => {
      expect(
        classifyBodyCompleteness({
          markdown: { markdown: 'Prose', truncated: false, unknownBlockIds: [] },
          inventory: { ...blockInventory(type), renderedMarkdown: 'Prose' },
        }),
      ).toEqual({
        _tag: 'lossy',
        reasons: ['not_round_trip_safe_blocks'],
        lossyBlockTypes: [type],
      })
    })
  }

  it('keeps representable media (image) complete', () => {
    expect(
      classifyBodyCompleteness({
        markdown: { markdown: 'Prose', truncated: false, unknownBlockIds: [] },
        inventory: { ...blockInventory('image'), renderedMarkdown: 'Prose' },
      }),
    ).toEqual({ _tag: 'complete' })
  })

  it('reports every distinct offending block type, sorted and deduplicated', () => {
    expect(
      classifyBodyCompleteness({
        markdown: { markdown: 'Prose', truncated: false, unknownBlockIds: [] },
        inventory: {
          entries: [
            { id: '1', type: 'synced_block', hasChildren: false, inTrash: false },
            { id: '2', type: 'table_of_contents', hasChildren: false, inTrash: false },
            { id: '3', type: 'synced_block', hasChildren: false, inTrash: false },
            { id: '4', type: 'unsupported', hasChildren: false, inTrash: false },
          ],
          renderedMarkdown: 'Prose',
        },
      }),
    ).toEqual({
      _tag: 'lossy',
      reasons: ['unsupported_blocks', 'not_round_trip_safe_blocks'],
      lossyBlockTypes: ['synced_block', 'table_of_contents', 'unsupported'],
    })
  })
})

describe('tolerateTreeChildPages', () => {
  it('clears a child_page-only verdict to complete (tree node owns its sub-pages)', () => {
    const verdict = classifyBodyCompleteness({
      markdown: { markdown: 'Prose', truncated: false, unknownBlockIds: [] },
      inventory: {
        entries: [{ id: '1', type: 'child_page', hasChildren: false, inTrash: false }],
        renderedMarkdown: 'Prose',
      },
    })
    expect(verdict).toEqual({
      _tag: 'lossy',
      reasons: ['not_round_trip_safe_blocks'],
      lossyBlockTypes: ['child_page'],
    })
    expect(tolerateTreeChildPages(verdict)).toEqual({ _tag: 'complete' })
  })

  it('still refuses a tree node that ALSO has a real lossy block (#785 stays fixed)', () => {
    const verdict = classifyBodyCompleteness({
      markdown: { markdown: 'Prose', truncated: false, unknownBlockIds: [] },
      inventory: {
        entries: [
          { id: '1', type: 'child_page', hasChildren: false, inTrash: false },
          { id: '2', type: 'table_of_contents', hasChildren: false, inTrash: false },
        ],
        renderedMarkdown: 'Prose',
      },
    })
    expect(tolerateTreeChildPages(verdict)).toEqual({
      _tag: 'lossy',
      reasons: ['not_round_trip_safe_blocks'],
      lossyBlockTypes: ['table_of_contents'],
    })
  })

  it('preserves Markdown-level reasons even when child_page is tolerated', () => {
    const verdict: BodyCompleteness = {
      _tag: 'lossy',
      reasons: ['endpoint_truncated', 'not_round_trip_safe_blocks'],
      lossyBlockTypes: ['child_page'],
    }
    expect(tolerateTreeChildPages(verdict)).toEqual({
      _tag: 'lossy',
      reasons: ['endpoint_truncated'],
      lossyBlockTypes: [],
    })
  })

  it('is a no-op for a complete verdict', () => {
    expect(tolerateTreeChildPages({ _tag: 'complete' })).toEqual({ _tag: 'complete' })
  })
})

describe('describeBodyLossyRefusal', () => {
  it('names the offending block class and points to the Notion UI', () => {
    const message = describeBodyLossyRefusal({
      pageId: 'page-1',
      completeness: {
        _tag: 'lossy',
        reasons: ['not_round_trip_safe_blocks'],
        lossyBlockTypes: ['table_of_contents'],
      },
      context: 'refusing to treat it as a clean notion-md base',
    })
    expect(message).toContain('table_of_contents')
    expect(message).toContain('Notion UI')
  })

  it('omits the block clause when no block types are known', () => {
    const message = describeBodyLossyRefusal({
      pageId: 'page-1',
      completeness: { _tag: 'lossy', reasons: ['endpoint_truncated'] },
      context: 'refusing verified body operation',
    })
    expect(message).not.toContain('block(s):')
    expect(message).toContain('endpoint_truncated')
  })
})

describe('stableBodyFidelityStringify', () => {
  it('sorts object keys recursively', () => {
    expect(stableBodyFidelityStringify({ b: 1, a: { d: 4, c: 3 } })).toBe(
      '{"a":{"c":3,"d":4},"b":1}',
    )
  })
})
