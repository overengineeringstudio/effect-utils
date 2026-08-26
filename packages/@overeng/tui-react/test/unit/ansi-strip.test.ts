/**
 * Regression tests for ANSI stripping against the exact escape-sequence shapes
 * emitted by Effect rc.111 `Prompt` under a real PTY (alignment register entry
 * `prompt-pty-ansi-rendering`). v4 emits shorter per-attribute SGR resets
 * (`\x1b[0m`, single-digit attributes) plus DEC private-mode cursor visibility
 * (`\x1b[?25l` / `\x1b[?25h`) on every frame; strippers must remove all of them.
 */

import { describe, expect, it } from 'vitest'

import { stripAnsi as stripAnsiOutputMode } from '../../src/effect/OutputMode.tsx'
import { stripAnsi as stripAnsiTestRenderer } from '../../src/effect/TestRenderer.ts'

// Verbatim fragment of a real PTY capture of `Prompt.select` under effect@4.0.0-rc.111
// (80x24 terminal): short SGR attributes, SGR 0 resets, cursor movement
// (`\x1b[2K`, `\x1b[1A`, `\x1b[G`), and DEC private-mode cursor visibility.
const rc111PromptFrame =
  '\x1b[?25l\x1b[96m?\x1b[0m \x1b[1mChoose action\x1b[0m \x1b[90m›\x1b[0m \r\n' +
  '\x1b[96m❯\x1b[0m \x1b[4m\x1b[96mCreate\x1b[0m \r\n' +
  '  Skip \x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[G\x1b[32m✔\x1b[0m \x1b[37mSkip\x1b[0m\r\n' +
  '\x1b[?25h'

describe.each([
  ['OutputMode.stripAnsi', stripAnsiOutputMode],
  ['TestRenderer stripAnsi', stripAnsiTestRenderer],
] as const)('%s', (_, strip) => {
  it('strips every sequence shape emitted by rc.111 Prompt under a PTY', () => {
    expect(strip(rc111PromptFrame)).toBe('? Choose action › \r\n❯ Create \r\n  Skip ✔ Skip\r\n')
  })

  it('strips DEC private-mode cursor visibility codes', () => {
    expect(strip('\x1b[?25lhidden\x1b[?25h')).toBe('hidden')
    expect(strip('\x1b[?2026hsynced\x1b[?2026l')).toBe('synced')
  })

  it('leaves plain text untouched', () => {
    expect(strip('plain text')).toBe('plain text')
  })
})
