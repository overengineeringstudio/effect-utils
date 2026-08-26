import { describe, expect, it } from 'vitest'

import { stripAnsi } from './setup.ts'

// Regression: Effect rc.111 Prompt frames under a real PTY emit DEC private-mode
// cursor sequences (`\x1b[?25l` / `\x1b[?25h`) alongside short SGR resets; the
// stripper must remove both (alignment register `prompt-pty-ansi-rendering`).
describe('stripAnsi', () => {
  it('strips short SGR and cursor-movement sequences', () => {
    expect(stripAnsi('\x1b[96m?\x1b[0m \x1b[1mmsg\x1b[0m\x1b[2K\x1b[1A\x1b[G')).toBe('? msg')
  })

  it('strips DEC private-mode cursor visibility sequences', () => {
    expect(stripAnsi('\x1b[?25lhidden\x1b[?25h')).toBe('hidden')
  })

  it('leaves plain text untouched', () => {
    expect(stripAnsi('plain')).toBe('plain')
  })
})
