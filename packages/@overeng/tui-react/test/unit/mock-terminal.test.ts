/**
 * Tests for MockTerminal helper.
 */

import { describe, expect, it } from 'vitest'
import { createMockTerminal, stripAnsi } from '../helpers/mod.ts'

describe('stripAnsi', () => {
  it('strips basic color codes', () => {
    const input = '\x1b[31mred\x1b[0m'
    expect(stripAnsi(input)).toBe('red')
  })

  it('strips cursor movement codes', () => {
    const input = '\x1b[2Aup two\x1b[3Bdown three'
    expect(stripAnsi(input)).toBe('up twodown three')
  })

  it('strips cursor visibility codes', () => {
    const input = '\x1b[?25lhidden\x1b[?25h'
    expect(stripAnsi(input)).toBe('hidden')
  })

  it('preserves plain text', () => {
    const input = 'Hello World'
    expect(stripAnsi(input)).toBe('Hello World')
  })
})

describe('MockTerminal', () => {
  describe('basic operations', () => {
    it('captures writes', () => {
      const terminal = createMockTerminal()
      terminal.write('Hello')
      terminal.write(' World')

      expect(terminal.getRawOutput()).toBe('Hello World')
    })

    it('strips ANSI for plain output', () => {
      const terminal = createMockTerminal()
      terminal.write('\x1b[32mgreen\x1b[0m')

      expect(terminal.getPlainOutput()).toBe('green')
    })

    it('splits into lines', () => {
      const terminal = createMockTerminal()
      terminal.write('Line 1\nLine 2\nLine 3')

      expect(terminal.getLines()).toEqual(['Line 1', 'Line 2', 'Line 3'])
    })
  })

  describe('frame tracking', () => {
    it('tracks frames ending with newline', () => {
      const terminal = createMockTerminal()
      terminal.write('Frame 1\n')
      terminal.write('Frame 2\n')

      expect(terminal.frames).toHaveLength(2)
      expect(terminal.frames[0]).toBe('Frame 1\n')
      expect(terminal.frames[1]).toBe('Frame 2\n')
    })

    it('returns last frame', () => {
      const terminal = createMockTerminal()
      terminal.write('First\n')
      terminal.write('Second\n')

      expect(terminal.lastFrame()).toBe('Second\n')
    })

    it('returns last frame plain', () => {
      const terminal = createMockTerminal()
      terminal.write('\x1b[32mColored\x1b[0m\n')

      expect(terminal.lastFramePlain()).toBe('Colored\n')
    })
  })

  describe('ANSI detection', () => {
    it('detects cursor hidden', () => {
      const terminal = createMockTerminal()
      terminal.write('\x1b[?25l')

      expect(terminal.hasCursorHidden()).toBe(true)
      expect(terminal.hasCursorShown()).toBe(false)
    })

    it('detects cursor shown', () => {
      const terminal = createMockTerminal()
      terminal.write('\x1b[?25h')

      expect(terminal.hasCursorShown()).toBe(true)
    })

    it('detects synchronized output', () => {
      const terminal = createMockTerminal()
      terminal.write('\x1b[?2026h')
      terminal.write('content')
      terminal.write('\x1b[?2026l')

      expect(terminal.hasSyncOutput()).toBe(true)
    })
  })

  describe('configuration', () => {
    it('uses default dimensions', () => {
      const terminal = createMockTerminal()

      expect(terminal.columns).toBe(80)
      expect(terminal.rows).toBe(24)
      expect(terminal.isTTY).toBe(true)
    })

    it('accepts custom dimensions', () => {
      const terminal = createMockTerminal({ cols: 40, rows: 10 })

      expect(terminal.columns).toBe(40)
      expect(terminal.rows).toBe(10)
    })

    it('can disable TTY mode', () => {
      const terminal = createMockTerminal({ isTTY: false })

      expect(terminal.isTTY).toBe(false)
    })
  })

  describe('clear', () => {
    it('clears all captured output', () => {
      const terminal = createMockTerminal()
      terminal.write('Some output\n')
      terminal.write('More output\n')

      terminal.clear()

      expect(terminal.getRawOutput()).toBe('')
      expect(terminal.frames).toHaveLength(0)
    })
  })
})
