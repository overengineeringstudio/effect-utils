import { describe, expect, it } from 'vitest'

import { richTextPlainText } from './rich-text.ts'

describe('richTextPlainText', () => {
  it('concatenates plain_text fields from unknown rich text arrays', () => {
    expect(
      richTextPlainText([
        { type: 'text', plain_text: 'Hello' },
        { type: 'text', plain_text: ' ' },
        { type: 'mention', plain_text: 'world' },
      ]),
    ).toBe('Hello world')
  })

  it('tolerates malformed array elements', () => {
    expect(richTextPlainText([{ plain_text: 'A' }, undefined, { href: null }, 'B'])).toBe('A')
  })

  it('stringifies present non-string plain_text values', () => {
    expect(
      richTextPlainText([{ plain_text: 1 }, { plain_text: false }, { plain_text: null }]),
    ).toBe('1falsenull')
  })

  it('returns an empty string for non-array inputs', () => {
    expect(richTextPlainText(undefined)).toBe('')
    expect(richTextPlainText({ plain_text: 'ignored' })).toBe('')
  })
})
