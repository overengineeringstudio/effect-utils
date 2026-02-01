/**
 * Virtual terminal for testing using xterm.js headless.
 *
 * Provides accurate ANSI sequence interpretation without a real TTY.
 */

import { Terminal } from '@xterm/headless'

import type { Terminal as TuiTerminal } from '@overeng/tui-core'

/**
 * Virtual terminal that accurately interprets ANSI sequences.
 *
 * Uses xterm.js headless mode to simulate a real terminal.
 * Output can be inspected via getViewport() and getCursor().
 *
 * Note: Simulates terminal driver behavior by converting LF to CRLF.
 * Real terminal drivers do this conversion; xterm.js headless doesn't.
 */
export class VirtualTerminal implements TuiTerminal {
  private readonly xterm: Terminal
  private pending: Promise<void> = Promise.resolve()

  /** Terminal width in columns */
  readonly columns: number

  /** Terminal height in rows */
  readonly rows: number

  /** Always true for virtual terminal (supports ANSI) */
  readonly isTTY = true

  /** Whether to convert LF to CRLF (simulating terminal driver) */
  private readonly convertLfToCrLf: boolean

  constructor(options?: { cols?: number; rows?: number; convertLfToCrLf?: boolean }) {
    this.columns = options?.cols ?? 80
    this.rows = options?.rows ?? 24
    this.convertLfToCrLf = options?.convertLfToCrLf ?? true

    this.xterm = new Terminal({
      cols: this.columns,
      rows: this.rows,
      allowProposedApi: true,
    })
  }

  /**
   * Write data to the terminal.
   *
   * Writes are queued and can be awaited via flush().
   * By default, converts LF to CRLF to simulate terminal driver behavior.
   */
  write(data: string): void {
    // Simulate terminal driver: convert \n to \r\n
    // Real terminals do this via the tty driver (stty onlcr)
    // xterm.js headless doesn't, so we do it here
    const processedData = this.convertLfToCrLf ? data.replace(/\n/g, '\r\n') : data

    this.pending = this.pending.then(
      () =>
        new Promise<void>((resolve) => {
          this.xterm.write(processedData, resolve)
        }),
    )
  }

  /**
   * Wait for all pending writes to complete.
   */
  async flush(): Promise<void> {
    await this.pending
  }

  /**
   * Get the current viewport content as an array of lines.
   *
   * Lines are trimmed of trailing whitespace.
   */
  getViewport(): string[] {
    const lines: string[] = []
    const buffer = this.xterm.buffer.active
    // Read from the actual viewport position, not from line 0.
    // After terminal scrolling, baseY > 0 and lines 0..baseY-1 are scrollback.
    const baseY = buffer.baseY
    for (let i = baseY; i < baseY + this.rows; i++) {
      const line = buffer.getLine(i)
      lines.push(line?.translateToString(true).trimEnd() ?? '')
    }
    return lines
  }

  /**
   * Check if the terminal has scrolled (content exceeded viewport).
   */
  hasScrolled(): boolean {
    return this.xterm.buffer.active.baseY > 0
  }

  /**
   * Get the number of lines that have scrolled off the top.
   */
  getScrollbackSize(): number {
    return this.xterm.buffer.active.baseY
  }

  /**
   * Get viewport content with trailing empty lines removed.
   */
  getVisibleLines(): string[] {
    const lines = this.getViewport()
    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop()
    }
    return lines
  }

  /**
   * Get the current cursor position.
   */
  getCursor(): { x: number; y: number } {
    const buffer = this.xterm.buffer.active
    return { x: buffer.cursorX, y: buffer.cursorY }
  }

  /**
   * Get a specific cell's content and attributes.
   */
  getCell(row: number, col: number) {
    const buffer = this.xterm.buffer.active
    const line = buffer.getLine(row)
    return line?.getCell(col)
  }

  /**
   * Resize the terminal.
   */
  resize(cols: number, rows: number): void {
    this.xterm.resize(cols, rows)
    // Note: columns/rows are readonly, so we can't update them
    // This is a limitation - for resize testing, create a new VirtualTerminal
  }

  /**
   * Dispose of the terminal resources.
   */
  dispose(): void {
    this.xterm.dispose()
  }
}

/**
 * Create a virtual terminal for testing.
 *
 * @example
 * ```ts
 * const terminal = createVirtualTerminal({ cols: 40, rows: 10 })
 *
 * terminal.write('Hello\n')
 * terminal.write('World\n')
 * await terminal.flush()
 *
 * const lines = terminal.getVisibleLines()
 * expect(lines).toEqual(['Hello', 'World'])
 * ```
 */
export const createVirtualTerminal = (options?: {
  cols?: number
  rows?: number
}): VirtualTerminal => new VirtualTerminal(options)
