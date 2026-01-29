/**
 * Basic tests to verify VirtualTerminal works correctly with ANSI codes.
 */

import { describe, expect, it } from 'vitest'

import { createVirtualTerminal } from '../helpers/mod.ts'

describe('VirtualTerminal basic', () => {
  it('renders plain text', async () => {
    const terminal = createVirtualTerminal()
    terminal.write('Hello World')
    await terminal.flush()

    const lines = terminal.getVisibleLines()
    expect(lines[0]).toBe('Hello World')
  })

  it('handles newlines', async () => {
    const terminal = createVirtualTerminal()
    terminal.write('Line 1\nLine 2\nLine 3')
    await terminal.flush()

    const lines = terminal.getVisibleLines()
    expect(lines[0]).toBe('Line 1')
    expect(lines[1]).toBe('Line 2')
    expect(lines[2]).toBe('Line 3')

    terminal.dispose()
  })

  it('tracks cursor position after newlines', async () => {
    const terminal = createVirtualTerminal()
    terminal.write('ABC\nDEF\n')
    await terminal.flush()

    const cursor = terminal.getCursor()
    expect(cursor.x).toBe(0)
    expect(cursor.y).toBe(2)

    terminal.dispose()
  })

  it('handles cursor movement up', async () => {
    const terminal = createVirtualTerminal()
    // Write 3 lines, then move up 2
    terminal.write('Line 1\nLine 2\nLine 3\n')
    terminal.write('\x1b[2A') // Move up 2 lines
    await terminal.flush()

    const cursor = terminal.getCursor()
    expect(cursor.y).toBe(1) // Should be on line 2

    terminal.dispose()
  })

  it('handles clear line', async () => {
    const terminal = createVirtualTerminal()
    terminal.write('AAAAAAAAAA\n') // Line 0: 10 A's
    terminal.write('BBBBBBBBBB\n') // Line 1: 10 B's
    terminal.write('\x1b[1A') // Move up 1 line (to line 1)
    terminal.write('\x1b[2K') // Clear entire line
    terminal.write('NEW') // Write "NEW"
    await terminal.flush()

    const lines = terminal.getVisibleLines()
    expect(lines[0]).toBe('AAAAAAAAAA')
    expect(lines[1]).toBe('NEW') // Should be "NEW", not "NEWBBBBBBB"

    terminal.dispose()
  })

  it('handles cursor to column', async () => {
    const terminal = createVirtualTerminal()
    terminal.write('AAAAAAAAAA') // Write 10 A's
    terminal.write('\x1b[1G') // Move cursor to column 1 (1-based)
    terminal.write('B') // Overwrite with B
    await terminal.flush()

    const lines = terminal.getVisibleLines()
    expect(lines[0]).toBe('BAAAAAAAAA') // First char should be B

    terminal.dispose()
  })

  it('handles carriage return', async () => {
    const terminal = createVirtualTerminal()
    terminal.write('AAAAAAAAAA')
    terminal.write('\r') // Return to start of line
    terminal.write('BB') // Overwrite first 2 chars
    await terminal.flush()

    const lines = terminal.getVisibleLines()
    expect(lines[0]).toBe('BBAAAAAAAA')

    terminal.dispose()
  })

  it('handles hide/show cursor', async () => {
    const terminal = createVirtualTerminal()
    terminal.write('\x1b[?25l') // Hide cursor
    terminal.write('Text')
    terminal.write('\x1b[?25h') // Show cursor
    await terminal.flush()

    const lines = terminal.getVisibleLines()
    expect(lines[0]).toBe('Text')

    terminal.dispose()
  })

  it('handles synchronized output', async () => {
    const terminal = createVirtualTerminal()
    terminal.write('\x1b[?2026h') // Begin sync
    terminal.write('Synced content')
    terminal.write('\x1b[?2026l') // End sync
    await terminal.flush()

    const lines = terminal.getVisibleLines()
    expect(lines[0]).toBe('Synced content')

    terminal.dispose()
  })
})
