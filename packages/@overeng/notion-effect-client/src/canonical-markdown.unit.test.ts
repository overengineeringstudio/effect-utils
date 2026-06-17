import { describe, expect, it } from '@effect/vitest'

import { canonicalizeBlockMarkdown } from './canonical-markdown.ts'

describe('canonicalizeBlockMarkdown', () => {
  it('unwraps soft-wrapped paragraph lines into one logical line', () => {
    const wrapped = [
      'Use this skill when designing software and you need a',
      'principled read on whether a code-level solution makes the system',
      'simpler.',
    ].join('\n')

    expect(canonicalizeBlockMarkdown(wrapped)).toBe(
      'Use this skill when designing software and you need a principled read on whether a code-level solution makes the system simpler.\n',
    )
  })

  it('preserves paragraph boundaries on blank lines', () => {
    const input = 'First paragraph.\n\nSecond paragraph.'
    expect(canonicalizeBlockMarkdown(input)).toBe('First paragraph.\n\nSecond paragraph.\n')
  })

  it('preserves explicit hard breaks', () => {
    const input = 'Line one.\\\nLine two.'
    expect(canonicalizeBlockMarkdown(input)).toBe('Line one.\\\nLine two.\n')
  })

  it('keeps list structure with unwrapped continuations', () => {
    const input = ['- first item that wraps across', '  two lines', '- second item'].join('\n')
    expect(canonicalizeBlockMarkdown(input)).toBe(
      '- first item that wraps across two lines\n- second item\n',
    )
  })

  it('leaves fenced code blocks untouched', () => {
    const input = '```ts\nconst x = 1\nconst y = 2\n```'
    expect(canonicalizeBlockMarkdown(input)).toBe('```ts\nconst x = 1\nconst y = 2\n```\n')
  })

  it('does not turn email-like plain text into angle autolinks', () => {
    const once = canonicalizeBlockMarkdown('0@.A')
    expect(once).toBe('0@.A\n')
    expect(canonicalizeBlockMarkdown(once)).toBe(once)
  })

  it('keeps bare URLs plain so preview-link text is not rewritten', () => {
    const once = canonicalizeBlockMarkdown('https://example.com/preview')
    expect(once).toBe('https://example.com/preview\n')
    expect(canonicalizeBlockMarkdown(once)).toBe(once)
  })

  it('preserves explicit markdown links', () => {
    expect(canonicalizeBlockMarkdown('[Example](https://example.com)')).toBe(
      '[Example](https://example.com)\n',
    )
  })

  it('keeps selected GFM features available', () => {
    const input = ['- [x] task', '', '~~done~~', '', '| A | B |', '| - | - |', '| 1 | 2 |'].join(
      '\n',
    )
    expect(canonicalizeBlockMarkdown(input)).toBe(
      ['- [x] task', '', '~~done~~', '', '| A | B |', '| - | - |', '| 1 | 2 |', ''].join('\n'),
    )
  })

  it('is idempotent', () => {
    const input = 'Paragraph one wraps\nacross lines.\n\nParagraph two.'
    const once = canonicalizeBlockMarkdown(input)
    expect(canonicalizeBlockMarkdown(once)).toBe(once)
  })

  it('normalizes CRLF line endings to LF', () => {
    const input = 'Line one\r\nstill line one.\r\n\r\nLine two.'
    expect(canonicalizeBlockMarkdown(input)).toBe('Line one still line one.\n\nLine two.\n')
  })

  /*
   * List-tightness locking tests (decision 0019). The renderer joins sibling
   * blocks with `\n\n`, producing a *loose* list; the canonical layer is the
   * single place that forces lists tight (`spread = false`) while leaving the
   * blank line before a following non-list block intact.
   */
  it('forces a loose bulleted list tight', () => {
    expect(canonicalizeBlockMarkdown('- a\n\n- b\n\n- c\n')).toBe('- a\n- b\n- c\n')
  })

  it('keeps the blank line before a paragraph following a list', () => {
    expect(canonicalizeBlockMarkdown('- a\n\n- b\n\nA paragraph after.\n')).toBe(
      '- a\n- b\n\nA paragraph after.\n',
    )
  })

  it('keeps consecutive headings blank-separated even from tight input', () => {
    expect(canonicalizeBlockMarkdown('# H1\n## H2\n### H3\n')).toBe('# H1\n\n## H2\n\n### H3\n')
  })

  it('removes the stray indented blank line inside a nested list', () => {
    // The shape `treeToMarkdown` produces for a nested list: loose siblings
    // plus a `  ` whitespace-only line between nested items.
    expect(canonicalizeBlockMarkdown('- A\n\n- B\n  - B1\n  \n  - B2\n\n- C\n')).toBe(
      '- A\n- B\n  - B1\n  - B2\n- C\n',
    )
  })

  it('is idempotent over a list + paragraph body', () => {
    const input = '- a\n\n- b\n\nAfter.\n'
    const once = canonicalizeBlockMarkdown(input)
    expect(canonicalizeBlockMarkdown(once)).toBe(once)
    expect(once).toBe('- a\n- b\n\nAfter.\n')
  })
})
