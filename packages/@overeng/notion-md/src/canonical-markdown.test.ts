import { describe, expect, it } from '@effect/vitest'

import { canonicalizeBlockMarkdown, semanticEquivalent } from './canonical-markdown.ts'

describe('canonicalizeBlockMarkdown re-export', () => {
  // The canonical function now lives in `@overeng/notion-effect-client` (its
  // own unit tests cover behavior); notion-md re-exports it. Smoke-test that
  // the re-export resolves and produces the canonical (tight-list) form.
  it('re-exports the canonical body function', () => {
    expect(canonicalizeBlockMarkdown('- a\n\n- b\n')).toBe('- a\n- b\n')
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
