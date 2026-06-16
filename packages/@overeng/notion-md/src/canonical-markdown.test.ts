import { describe, expect, it } from '@effect/vitest'

import { canonicalizeBlockMarkdown, semanticEquivalent } from './canonical-markdown.ts'

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
   * List-tightness locking tests (decision 0018). The renderer joins sibling
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

describe('semanticEquivalent', () => {
  it('treats Notion-collapsed blank lines as equivalent to the sent form', () => {
    const sent = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n'
    const returnedFromNotion = 'First paragraph.\nSecond paragraph.\nThird paragraph.\n'
    expect(semanticEquivalent({ a: sent, b: returnedFromNotion })).toBe(true)
  })

  it('ignores list-indent style differences (spaces vs tabs)', () => {
    const sent = '- item one\n  continued\n- item two\n'
    const returnedFromNotion = '- item one\n\tcontinued\n- item two\n'
    expect(semanticEquivalent({ a: sent, b: returnedFromNotion })).toBe(true)
  })

  it('flags real content drift', () => {
    const sent = 'Hello world.\n'
    const returnedFromNotion = 'Hello mars.\n'
    expect(semanticEquivalent({ a: sent, b: returnedFromNotion })).toBe(false)
  })

  it('flags reordered tokens as drift', () => {
    const sent = 'one two three\n'
    const returnedFromNotion = 'three two one\n'
    expect(semanticEquivalent({ a: sent, b: returnedFromNotion })).toBe(false)
  })

  it('flags whitespace-significant diffs inside fenced code blocks', () => {
    const sent = 'Intro.\n\n```ts\nconst x = 1\n  const y = 2\n```\n'
    const drifted = 'Intro.\n\n```ts\nconst x = 1\nconst y = 2\n```\n'
    expect(semanticEquivalent({ a: sent, b: drifted })).toBe(false)
  })

  it('accepts equivalent fenced code blocks verbatim', () => {
    const sent = 'Intro.\n\n```ts\nconst x = 1\nconst y = 2\n```\n'
    const same = 'Intro.\n```ts\nconst x = 1\nconst y = 2\n```\n'
    expect(semanticEquivalent({ a: sent, b: same })).toBe(true)
  })

  it('treats two rotated hosted-media signature variants as equivalent', () => {
    const host = 'https://prod-files-secure.s3.us-west-2.amazonaws.com/abc/photo.png'
    const params =
      '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20260615T120000Z&X-Amz-Expires=3600'
    const pullOne = `![caption](${host}${params}&X-Amz-Signature=deadbeef)\n`
    const pullTwo = `![caption](${host}${params}&X-Amz-Signature=cafef00d)\n`
    expect(semanticEquivalent({ a: pullOne, b: pullTwo })).toBe(true)
  })

  it('still flags a real change to a hosted-media caption', () => {
    const host = 'https://prod-files-secure.s3.us-west-2.amazonaws.com/abc/photo.png'
    const a = `![before](${host}?X-Amz-Signature=deadbeef)\n`
    const b = `![after](${host}?X-Amz-Signature=cafef00d)\n`
    expect(semanticEquivalent({ a, b })).toBe(false)
  })
})
