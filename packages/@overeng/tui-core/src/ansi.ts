/**
 * ANSI escape code utilities for terminal manipulation.
 *
 * These are low-level building blocks for terminal rendering.
 * For higher-level styled text, use @overeng/cli-ui.
 */

/** CSI (Control Sequence Introducer) prefix */
const CSI = '\x1b['

/** OSC (Operating System Command) prefix */
const OSC = '\x1b]'

// =============================================================================
// Cursor Movement
// =============================================================================

/** Move cursor up N lines */
export const cursorUp = (n = 1): string => (n > 0 ? `${CSI}${n}A` : '')

/** Move cursor down N lines */
export const cursorDown = (n = 1): string => (n > 0 ? `${CSI}${n}B` : '')

/** Move cursor to column N (1-based) */
export const cursorToColumn = (n = 1): string => `${CSI}${n}G`

/** Save cursor position */
export const cursorSave = (): string => `${CSI}s`

/** Restore cursor position */
export const cursorRestore = (): string => `${CSI}u`

// =============================================================================
// Line Operations
// =============================================================================

/** Clear entire line */
export const clearLine = (): string => `${CSI}2K`

/** Clear from cursor to end of line */
export const clearToEndOfLine = (): string => `${CSI}0K`

/** Clear from cursor to start of line */
export const clearToStartOfLine = (): string => `${CSI}1K`

/**
 * Generate sequence to clear N lines above cursor.
 * Moves up, clears each line, then returns to original position.
 */
export const clearLinesAbove = (n: number): string => {
  if (n <= 0) return ''
  let seq = ''
  for (let i = 0; i < n; i++) {
    seq += cursorUp(1) + clearLine()
  }
  return seq
}

// =============================================================================
// Cursor Visibility
// =============================================================================

/** Hide cursor */
export const hideCursor = (): string => `${CSI}?25l`

/** Show cursor */
export const showCursor = (): string => `${CSI}?25h`

// =============================================================================
// Synchronized Output (CSI 2026)
// =============================================================================

/**
 * Begin synchronized output.
 *
 * Tells the terminal to buffer output until endSyncOutput() is called,
 * enabling flicker-free updates. Supported by iTerm2, Kitty, Alacritty, WezTerm, etc.
 *
 * Terminals that don't support this will simply ignore the sequence.
 */
export const beginSyncOutput = (): string => `${CSI}?2026h`

/**
 * End synchronized output.
 *
 * Tells the terminal to flush the buffer and render all pending output at once.
 */
export const endSyncOutput = (): string => `${CSI}?2026l`

// =============================================================================
// Text Styles
// =============================================================================

/** Reset all styles */
export const reset = (): string => `${CSI}0m`

/** Bold text */
export const bold = (text: string): string => `${CSI}1m${text}${CSI}22m`

/** Dim text */
export const dim = (text: string): string => `${CSI}2m${text}${CSI}22m`

/** Italic text */
export const italic = (text: string): string => `${CSI}3m${text}${CSI}23m`

/** Underlined text */
export const underline = (text: string): string => `${CSI}4m${text}${CSI}24m`

/** Strikethrough text */
export const strikethrough = (text: string): string => `${CSI}9m${text}${CSI}29m`

// =============================================================================
// Colors
// =============================================================================

/** Standard ANSI colors */
export type Color =
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'gray'
  | 'grey'
  // Bright variants
  | 'blackBright'
  | 'redBright'
  | 'greenBright'
  | 'yellowBright'
  | 'blueBright'
  | 'magentaBright'
  | 'cyanBright'
  | 'whiteBright'

/** Color name to ANSI foreground code */
const fgCodes: Record<Color, number> = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  gray: 90,
  grey: 90,
  blackBright: 90,
  redBright: 91,
  greenBright: 92,
  yellowBright: 93,
  blueBright: 94,
  magentaBright: 95,
  cyanBright: 96,
  whiteBright: 97,
}

/** Color name to ANSI background code */
const bgCodes: Record<Color, number> = {
  black: 40,
  red: 41,
  green: 42,
  yellow: 43,
  blue: 44,
  magenta: 45,
  cyan: 46,
  white: 47,
  gray: 100,
  grey: 100,
  blackBright: 100,
  redBright: 101,
  greenBright: 102,
  yellowBright: 103,
  blueBright: 104,
  magentaBright: 105,
  cyanBright: 106,
  whiteBright: 107,
}

/** Apply foreground color */
export const fg = (color: Color, text: string): string => `${CSI}${fgCodes[color]}m${text}${CSI}39m`

/** Apply background color */
export const bg = (color: Color, text: string): string => `${CSI}${bgCodes[color]}m${text}${CSI}49m`
