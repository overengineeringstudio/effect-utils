import { describe, expect, it } from 'vitest'

import { classifyBodyCompleteness, stableBodyFidelityStringify } from './body-fidelity.ts'

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
    })
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
    })
  })
})

describe('stableBodyFidelityStringify', () => {
  it('sorts object keys recursively', () => {
    expect(stableBodyFidelityStringify({ b: 1, a: { d: 4, c: 3 } })).toBe(
      '{"a":{"c":3,"d":4},"b":1}',
    )
  })
})
