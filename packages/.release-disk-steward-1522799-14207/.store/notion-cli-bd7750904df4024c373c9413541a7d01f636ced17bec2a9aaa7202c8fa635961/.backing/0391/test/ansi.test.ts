import { describe, expect, it } from 'vitest'

import { bold, hyperlink, stripAnsi } from '../src/mod.ts'

describe('stripAnsi', () => {
  it('strips SGR color/style sequences', () => {
    expect(stripAnsi('\x1b[32mHello\x1b[0m')).toBe('Hello')
  })

  it('strips sequences produced by this module (bold, hyperlink)', () => {
    expect(stripAnsi(bold('hi'))).toBe('hi')
    expect(stripAnsi(hyperlink({ url: 'https://example.com', text: 'link' }))).toBe('link')
  })

  it('strips DEC private-mode CSI sequences (#1149 regression)', () => {
    expect(stripAnsi('\x1b[?25lhidden\x1b[?25h')).toBe('hidden')
    expect(stripAnsi('\x1b[?2026hbatched\x1b[?2026l')).toBe('batched')
  })

  it('strips charset selection and keypad modes', () => {
    expect(stripAnsi('\x1b(Btext')).toBe('text')
    expect(stripAnsi('\x1b=keypad\x1b>')).toBe('keypad')
  })

  it('strips cursor-movement CSI sequences', () => {
    expect(stripAnsi('a\x1b[2Kb\x1b[1Ac\x1b[Gd')).toBe('abcd')
  })

  it('leaves plain text untouched', () => {
    expect(stripAnsi('plain text 123')).toBe('plain text 123')
  })

  it('handles strings with no escapes and empty strings', () => {
    expect(stripAnsi('')).toBe('')
    expect(stripAnsi('no escapes here')).toBe('no escapes here')
  })
})
