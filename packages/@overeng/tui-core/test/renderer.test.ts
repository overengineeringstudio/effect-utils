import { describe, expect, it } from 'vitest'

import { InlineRenderer, type Terminal } from '../src/mod.ts'

/**
 * Mock terminal for basic testing.
 * For accurate ANSI testing, use VirtualTerminal from tui-react.
 */
class MockTerminal implements Terminal {
  readonly columns = 80
  readonly rows = 24
  readonly isTTY = true
  readonly output: string[] = []

  write(data: string): void {
    this.output.push(data)
  }

  getOutput(): string {
    return this.output.join('')
  }

  clear(): void {
    this.output.length = 0
  }
}

describe('InlineRenderer', () => {
  describe('basic rendering', () => {
    it('renders lines to terminal', () => {
      const terminal = new MockTerminal()
      const renderer = new InlineRenderer({ terminalOrStream: terminal })

      renderer.render(['Line 1', 'Line 2'])

      const output = terminal.getOutput()
      expect(output).toContain('Line 1')
      expect(output).toContain('Line 2')

      renderer.dispose()
    })

    it('tracks dynamic lines', () => {
      const terminal = new MockTerminal()
      const renderer = new InlineRenderer({ terminalOrStream: terminal })

      renderer.render(['Line 1', 'Line 2'])

      expect(renderer.getDynamicLines()).toEqual(['Line 1', 'Line 2'])

      renderer.dispose()
    })
  })

  describe('static region', () => {
    it('appends static content', () => {
      const terminal = new MockTerminal()
      const renderer = new InlineRenderer({ terminalOrStream: terminal })

      renderer.appendStatic(['[INFO] Log 1'])

      expect(renderer.getStaticLines()).toEqual(['[INFO] Log 1'])

      const output = terminal.getOutput()
      expect(output).toContain('[INFO] Log 1')

      renderer.dispose()
    })

    it('preserves static content when rendering dynamic', () => {
      const terminal = new MockTerminal()
      const renderer = new InlineRenderer({ terminalOrStream: terminal })

      renderer.appendStatic(['[INFO] Log 1'])
      renderer.render(['Progress: 50%'])

      expect(renderer.getStaticLines()).toEqual(['[INFO] Log 1'])
      expect(renderer.getDynamicLines()).toEqual(['Progress: 50%'])

      renderer.dispose()
    })
  })

  describe('cursor management', () => {
    it('hides cursor by default', () => {
      const terminal = new MockTerminal()
      const renderer = new InlineRenderer({ terminalOrStream: terminal })

      renderer.render(['Line 1'])

      const output = terminal.getOutput()
      // Hide cursor escape sequence
      expect(output).toContain('\x1b[?25l')

      renderer.dispose()
    })

    it('shows cursor on dispose', () => {
      const terminal = new MockTerminal()
      const renderer = new InlineRenderer({ terminalOrStream: terminal })

      renderer.render(['Line 1'])
      renderer.dispose()

      const output = terminal.getOutput()
      // Show cursor escape sequence
      expect(output).toContain('\x1b[?25h')
    })
  })

  describe('non-TTY fallback', () => {
    it('prints lines without ANSI codes on non-TTY', () => {
      const terminal = new MockTerminal()
      // @ts-expect-error - override for testing
      terminal.isTTY = false

      const renderer = new InlineRenderer({ terminalOrStream: terminal })
      renderer.render(['Line 1', 'Line 2'])

      const output = terminal.getOutput()
      expect(output).toContain('Line 1')
      expect(output).toContain('Line 2')
      // Should not contain cursor hide sequence
      expect(output).not.toContain('\x1b[?25l')

      renderer.dispose()
    })
  })
})
