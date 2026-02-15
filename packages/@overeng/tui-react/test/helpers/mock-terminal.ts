/**
 * Mock terminal for fast component tests (Ink-style).
 *
 * Captures all writes without interpreting ANSI codes.
 * Use this for quick iteration on component logic.
 * For accurate ANSI verification, use VirtualTerminal instead.
 */

import type { Terminal } from '@overeng/tui-core'

// ANSI escape code regex for stripping
// Using String.raw to avoid linter complaints about control characters
const ESC = '\x1b'
const ANSI_REGEX = new RegExp(
  `${ESC}\\[[0-9;]*[a-zA-Z]|${ESC}\\][^\\x07]*\\x07|${ESC}\\[\\?[0-9;]*[a-zA-Z]`,
  'g',
)

/**
 * Strip ANSI escape codes from a string.
 */
export const stripAnsi = (str: string): string => str.replace(ANSI_REGEX, '')

/**
 * Mock terminal that captures all writes.
 *
 * Provides frame-based history like ink-testing-library.
 */
export class MockTerminal implements Terminal {
  /** Terminal width in columns */
  readonly columns: number

  /** Terminal height in rows */
  readonly rows: number

  /** Whether this is a TTY */
  readonly isTTY: boolean

  /** All raw writes (including ANSI codes) */
  private readonly writes: string[] = []

  /** Frame history - each complete render cycle */
  private readonly _frames: string[] = []

  /** Current frame being built */
  private currentFrame = ''

  constructor(options?: { cols?: number; rows?: number; isTTY?: boolean }) {
    this.columns = options?.cols ?? 80
    this.rows = options?.rows ?? 24
    this.isTTY = options?.isTTY ?? true
  }

  /**
   * Write data to the terminal.
   */
  write(data: string): void {
    this.writes.push(data)
    this.currentFrame += data

    // Detect frame boundaries (newline at end suggests complete output)
    // This is a heuristic - not perfect but works for most cases
    if (data.endsWith('\n') === true || data.includes('\x1b[?2026l') === true) {
      // End of synchronized output or newline = frame complete
      this._frames.push(this.currentFrame)
      this.currentFrame = ''
    }
  }

  /**
   * Get all raw output (with ANSI codes).
   */
  getRawOutput(): string {
    return this.writes.join('')
  }

  /**
   * Get plain text output (ANSI stripped).
   */
  getPlainOutput(): string {
    return stripAnsi(this.getRawOutput())
  }

  /**
   * Get output split into lines (ANSI stripped).
   */
  getLines(): string[] {
    return this.getPlainOutput().split('\n')
  }

  /**
   * Get all rendered frames.
   *
   * Each frame represents a complete render cycle.
   */
  get frames(): readonly string[] {
    // Include current frame if not empty
    if (this.currentFrame !== undefined) {
      return [...this._frames, this.currentFrame]
    }
    return this._frames
  }

  /**
   * Get the last rendered frame (raw, with ANSI).
   */
  lastFrame(): string | undefined {
    if (this.currentFrame !== undefined) {
      return this.currentFrame
    }
    return this._frames[this._frames.length - 1]
  }

  /**
   * Get the last rendered frame (plain text).
   */
  lastFramePlain(): string | undefined {
    const frame = this.lastFrame()
    return frame !== undefined ? stripAnsi(frame) : undefined
  }

  /**
   * Check if output contains a specific ANSI escape sequence.
   */
  hasAnsiCode(code: string): boolean {
    return this.getRawOutput().includes(code)
  }

  /**
   * Check if cursor was hidden.
   */
  hasCursorHidden(): boolean {
    return this.hasAnsiCode('\x1b[?25l')
  }

  /**
   * Check if cursor was shown.
   */
  hasCursorShown(): boolean {
    return this.hasAnsiCode('\x1b[?25h')
  }

  /**
   * Check if synchronized output was used.
   */
  hasSyncOutput(): boolean {
    return this.hasAnsiCode('\x1b[?2026h') && this.hasAnsiCode('\x1b[?2026l')
  }

  /**
   * Clear all captured output.
   */
  clear(): void {
    this.writes.length = 0
    this._frames.length = 0
    this.currentFrame = ''
  }
}

/**
 * Create a mock terminal for testing.
 *
 * @example
 * ```ts
 * const terminal = createMockTerminal({ cols: 40 })
 * const renderer = new InlineRenderer(terminal)
 *
 * renderer.render(['Hello', 'World'])
 *
 * expect(terminal.getLines()).toContain('Hello')
 * expect(terminal.hasCursorHidden()).toBe(true)
 * ```
 */
export const createMockTerminal = (options?: {
  cols?: number
  rows?: number
  isTTY?: boolean
}): MockTerminal => new MockTerminal(options)
