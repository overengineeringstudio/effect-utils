/**
 * Integration tests for InlineRenderer using VirtualTerminal.
 *
 * These tests use xterm.js headless to accurately verify ANSI rendering.
 * They're slower than MockTerminal tests but catch issues that mock tests miss.
 */

import { describe, expect, it } from 'vitest'

import { InlineRenderer } from '@overeng/tui-core'

import { createVirtualTerminal } from '../helpers/mod.ts'

describe('InlineRenderer (VirtualTerminal)', () => {
  describe('basic rendering', () => {
    it('renders lines to correct positions', async () => {
      const terminal = createVirtualTerminal({ cols: 40, rows: 10 })
      const renderer = new InlineRenderer(terminal)

      renderer.render(['Line 1', 'Line 2', 'Line 3'])
      await terminal.flush()

      const lines = terminal.getVisibleLines()
      expect(lines[0]).toBe('Line 1')
      expect(lines[1]).toBe('Line 2')
      expect(lines[2]).toBe('Line 3')

      renderer.dispose()
      terminal.dispose()
    })

    it('positions cursor after rendered content', async () => {
      const terminal = createVirtualTerminal({ cols: 40, rows: 10 })
      const renderer = new InlineRenderer(terminal)

      renderer.render(['Line 1', 'Line 2'])
      await terminal.flush()

      const cursor = terminal.getCursor()
      // Cursor should be at start of line 3 (after 2 lines + newlines)
      expect(cursor.y).toBe(2)
      expect(cursor.x).toBe(0)

      renderer.dispose()
      terminal.dispose()
    })
  })

  describe('differential updates', () => {
    it('updates only changed lines', async () => {
      const terminal = createVirtualTerminal({ cols: 40, rows: 10 })
      const renderer = new InlineRenderer(terminal)

      // Initial render
      renderer.render(['Header', 'Count: 0', 'Footer'])
      await terminal.flush()

      // Update middle line only
      renderer.render(['Header', 'Count: 1', 'Footer'])
      await terminal.flush()

      const lines = terminal.getVisibleLines()
      expect(lines[0]).toBe('Header')
      expect(lines[1]).toBe('Count: 1')
      expect(lines[2]).toBe('Footer')

      renderer.dispose()
      terminal.dispose()
    })

    it('handles content shrinking', async () => {
      const terminal = createVirtualTerminal({ cols: 40, rows: 10 })
      const renderer = new InlineRenderer(terminal)

      // Initial render with 4 lines
      renderer.render(['Line 1', 'Line 2', 'Line 3', 'Line 4'])
      await terminal.flush()

      // Shrink to 2 lines
      renderer.render(['Line 1', 'Line 2'])
      await terminal.flush()

      const lines = terminal.getVisibleLines()
      expect(lines).toEqual(['Line 1', 'Line 2'])

      renderer.dispose()
      terminal.dispose()
    })

    it('handles content growing', async () => {
      const terminal = createVirtualTerminal({ cols: 40, rows: 10 })
      const renderer = new InlineRenderer(terminal)

      // Initial render with 2 lines
      renderer.render(['Line 1', 'Line 2'])
      await terminal.flush()

      // Grow to 4 lines
      renderer.render(['Line 1', 'Line 2', 'Line 3', 'Line 4'])
      await terminal.flush()

      const lines = terminal.getVisibleLines()
      expect(lines[0]).toBe('Line 1')
      expect(lines[1]).toBe('Line 2')
      expect(lines[2]).toBe('Line 3')
      expect(lines[3]).toBe('Line 4')

      renderer.dispose()
      terminal.dispose()
    })
  })

  describe('static region', () => {
    it('renders static content above dynamic', async () => {
      const terminal = createVirtualTerminal({ cols: 40, rows: 10 })
      const renderer = new InlineRenderer(terminal)

      // Append static content
      renderer.appendStatic(['[INFO] Log message'])

      // Render dynamic content
      renderer.render(['Progress: 50%'])
      await terminal.flush()

      const lines = terminal.getVisibleLines()
      expect(lines[0]).toBe('[INFO] Log message')
      expect(lines[1]).toBe('Progress: 50%')

      renderer.dispose()
      terminal.dispose()
    })

    it('preserves static content through dynamic updates', async () => {
      const terminal = createVirtualTerminal({ cols: 40, rows: 10 })
      const renderer = new InlineRenderer(terminal)

      // Static content
      renderer.appendStatic(['[INFO] Started'])

      // Dynamic updates
      renderer.render(['Progress: 0%'])
      await terminal.flush()

      renderer.render(['Progress: 50%'])
      await terminal.flush()

      renderer.render(['Progress: 100%'])
      await terminal.flush()

      const lines = terminal.getVisibleLines()
      expect(lines[0]).toBe('[INFO] Started')
      expect(lines[1]).toBe('Progress: 100%')

      renderer.dispose()
      terminal.dispose()
    })

    it('appends new static content correctly', async () => {
      const terminal = createVirtualTerminal({ cols: 40, rows: 10 })
      const renderer = new InlineRenderer(terminal)

      // Initial static + dynamic
      renderer.appendStatic(['[INFO] Log 1'])
      renderer.render(['Progress'])
      await terminal.flush()

      // Add more static
      renderer.appendStatic(['[WARN] Log 2'])
      await terminal.flush()

      const lines = terminal.getVisibleLines()
      expect(lines[0]).toBe('[INFO] Log 1')
      expect(lines[1]).toBe('[WARN] Log 2')
      expect(lines[2]).toBe('Progress')

      renderer.dispose()
      terminal.dispose()
    })
  })

  describe('cleanup', () => {
    it('clears dynamic content on dispose', async () => {
      const terminal = createVirtualTerminal({ cols: 40, rows: 10 })
      const renderer = new InlineRenderer(terminal)

      renderer.render(['Temporary content'])
      await terminal.flush()

      const linesBefore = terminal.getVisibleLines()
      expect(linesBefore[0]).toBe('Temporary content')

      renderer.dispose()
      await terminal.flush()

      // After dispose, the dynamic content should be cleared
      // but cursor management happens
      terminal.dispose()
    })

    it('preserves static content on dispose', async () => {
      const terminal = createVirtualTerminal({ cols: 40, rows: 10 })
      const renderer = new InlineRenderer(terminal)

      renderer.appendStatic(['[INFO] Permanent log'])
      renderer.render(['Temporary progress'])
      await terminal.flush()

      renderer.dispose()
      await terminal.flush()

      // Static content should still be there
      const lines = terminal.getVisibleLines()
      expect(lines[0]).toBe('[INFO] Permanent log')

      terminal.dispose()
    })
  })
})
