/**
 * CLI Utility Functions
 *
 * Helpers for working with ANSI-styled text.
 */

// =============================================================================
// ANSI Stripping
// =============================================================================

/**
 * Regex pattern to match ANSI escape sequences.
 * Matches sequences like \x1b[31m, \x1b[1;31m, \x1b[38;5;196m, etc.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: required for ANSI matching
// oxlint-disable-next-line eslint(no-control-regex) -- required for ANSI matching
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g

/** Strip all ANSI escape codes from a string */
export const stripAnsi = (text: string): string => {
  return text.replace(ANSI_PATTERN, '')
}

// =============================================================================
// Text Measurement
// =============================================================================

/** Get visible length of text (excluding ANSI codes) */
export const visibleLength = (text: string): string['length'] => {
  return stripAnsi(text).length
}

// =============================================================================
// Text Padding
// =============================================================================

/** Options for text padding functions */
export type PadOptions = {
  /** Character to pad with */
  char?: string
}

/** Pad text to specified visible width (right padding) */
// oxlint-disable-next-line overeng/named-args -- text + width + options is idiomatic for pad functions
export const padEnd = (text: string, width: number, options?: PadOptions): string => {
  const char = options?.char ?? ' '
  const visible = visibleLength(text)
  if (visible >= width) return text
  return text + char.repeat(width - visible)
}

/** Pad text to specified visible width (left padding) */
// oxlint-disable-next-line overeng/named-args -- text + width + options is idiomatic for pad functions
export const padStart = (text: string, width: number, options?: PadOptions): string => {
  const char = options?.char ?? ' '
  const visible = visibleLength(text)
  if (visible >= width) return text
  return char.repeat(width - visible) + text
}

/** Center text within specified visible width */
// oxlint-disable-next-line overeng/named-args -- text + width + options is idiomatic for pad functions
export const center = (text: string, width: number, options?: PadOptions): string => {
  const char = options?.char ?? ' '
  const visible = visibleLength(text)
  if (visible >= width) return text
  const padding = width - visible
  const leftPad = Math.floor(padding / 2)
  const rightPad = padding - leftPad
  return char.repeat(leftPad) + text + char.repeat(rightPad)
}

// =============================================================================
// Text Truncation
// =============================================================================

/** Options for text truncation */
export type TruncateOptions = {
  /** Truncation indicator */
  ellipsis?: string
}

/** Truncate text to specified visible width */
// oxlint-disable-next-line overeng/named-args -- text + maxWidth + options is idiomatic
export const truncate = (text: string, maxWidth: number, options?: TruncateOptions): string => {
  const ellipsis = options?.ellipsis ?? '…'
  const stripped = stripAnsi(text)

  if (stripped.length <= maxWidth) return text

  // For ANSI text, we need to be careful - just truncate the stripped version
  // This loses styling but is safe
  return stripped.slice(0, maxWidth - ellipsis.length) + ellipsis
}

// =============================================================================
// Line Wrapping
// =============================================================================

/** Wrap text to specified width (simple word wrap, ignores ANSI codes) */
// oxlint-disable-next-line overeng/named-args -- text + maxWidth is idiomatic
export const wrap = (text: string, maxWidth: number): string[] => {
  const stripped = stripAnsi(text)
  const words = stripped.split(' ')
  const lines: string[] = []
  let currentLine = ''

  for (const word of words) {
    if (currentLine.length === 0) {
      currentLine = word
    } else if (currentLine.length + 1 + word.length <= maxWidth) {
      currentLine += ' ' + word
    } else {
      lines.push(currentLine)
      currentLine = word
    }
  }

  if (currentLine.length > 0) {
    lines.push(currentLine)
  }

  return lines
}

// =============================================================================
// Output Helpers
// =============================================================================

/** Join lines with newline character */
export const joinLines = (lines: string[]): string => lines.join('\n')

/** Split text into lines */
export const splitLines = (text: string): string[] => text.split('\n')
