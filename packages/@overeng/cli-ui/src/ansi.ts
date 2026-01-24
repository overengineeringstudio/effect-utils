/**
 * ANSI Escape Code Helpers
 *
 * Low-level helpers for terminal cursor control and output.
 * Used by progress components for live updates.
 */

// =============================================================================
// Cursor Control
// =============================================================================

/** Move cursor up n lines */
export const cursorUp = (n: number): string => (n > 0 ? `\x1b[${n}A` : '')

/** Move cursor down n lines */
export const cursorDown = (n: number): string => (n > 0 ? `\x1b[${n}B` : '')

/** Move cursor to beginning of line */
export const cursorToStart = '\r'

/** Move cursor to column n (1-based) */
export const cursorToColumn = (n: number): string => `\x1b[${n}G`

// =============================================================================
// Line Clearing
// =============================================================================

/** Clear from cursor to end of line */
export const clearToEOL = '\x1b[K'

/** Clear from cursor to beginning of line */
export const clearToBOL = '\x1b[1K'

/** Clear entire line */
export const clearLine = '\x1b[2K'

// =============================================================================
// Cursor Visibility
// =============================================================================

/** Hide cursor */
export const hideCursor = '\x1b[?25l'

/** Show cursor */
export const showCursor = '\x1b[?25h'

// =============================================================================
// Output Helpers
// =============================================================================

/** Write to stdout without newline */
export const write = (text: string): void => {
  process.stdout.write(text)
}

/** Write a line to stdout with newline */
export const writeLine = (text: string): void => {
  process.stdout.write(text + '\n')
}

/** Check if stdout is a TTY (supports ANSI codes) */
export const isTTY = (): boolean => {
  return typeof process !== 'undefined' && process.stdout?.isTTY === true
}

// =============================================================================
// Compound Operations
// =============================================================================

/** Move up and clear line, ready for rewriting */
export const rewriteLine = (linesUp: number): string => {
  return cursorUp(linesUp) + cursorToStart + clearToEOL
}

/** Clear n lines above cursor (moves up, clears each, ends at top) */
export const clearLinesAbove = (n: number): string => {
  let result = ''
  for (let i = 0; i < n; i++) {
    result += cursorUp(1) + clearLine
  }
  return result
}
