/**
 * Text truncation utilities for terminal output.
 *
 * Handles ANSI escape codes correctly when measuring and truncating strings.
 * Used internally by the renderer to prevent soft wrapping, and exported
 * for components that want explicit truncation control.
 */

import cliTruncate from 'cli-truncate'
import stringWidth from 'string-width'

// =============================================================================
// Types
// =============================================================================

/** Options for controlling text truncation behavior (position and ellipsis character). */
export interface TruncateOptions {
  /**
   * Position to truncate from.
   * - 'end': Truncate from the end (default) - "long text..."
   * - 'start': Truncate from the start - "...ng text"
   * - 'middle': Truncate from the middle - "long...text"
   */
  readonly position?: 'start' | 'middle' | 'end'

  /**
   * String to use as ellipsis indicator.
   * @default '…'
   */
  readonly ellipsis?: string
}

// =============================================================================
// Main Truncation Function
// =============================================================================

/**
 * Truncate a string to fit within a specified width.
 *
 * Handles ANSI escape codes correctly - the width is calculated based on
 * visible characters only, and ANSI codes are preserved in the output.
 *
 * @param text - The string to truncate (may contain ANSI codes)
 * @param width - Maximum width in terminal columns
 * @param options - Truncation options
 * @returns Truncated string with ellipsis if truncation occurred
 *
 * @example
 * ```ts
 * // Basic usage
 * truncateText('Hello, World!', 10) // 'Hello, Wo…'
 *
 * // With ANSI codes
 * truncateText('\x1b[31mRed text\x1b[0m', 5) // '\x1b[31mRed …\x1b[0m'
 *
 * // Custom ellipsis
 * truncateText('Long text', 8, { ellipsis: '...' }) // 'Long ...'
 *
 * // Truncate from middle (useful for file paths)
 * truncateText('/very/long/path/to/file.ts', 20, { position: 'middle' })
 * // '/very/lo…/file.ts'
 * ```
 */
export const truncateText = (
  text: string,
  width: number,
  options: TruncateOptions = {},
): string => {
  const { position = 'end', ellipsis = '…' } = options

  // Don't truncate if it fits
  if (stringWidth(text) <= width) {
    return text
  }

  // Use cli-truncate for ANSI-safe truncation
  return cliTruncate(text, width, {
    position,
    truncationCharacter: ellipsis,
    preferTruncationOnSpace: false,
  })
}

// =============================================================================
// Line Truncation (Internal)
// =============================================================================

/**
 * Truncate an array of lines to fit within terminal width.
 *
 * Used internally by the renderer to prevent soft wrapping.
 *
 * @internal
 */
export const truncateLines = (
  lines: readonly string[],
  width: number,
  options: TruncateOptions = {},
): string[] => {
  return lines.map((line) => truncateText(line, width, options))
}

// =============================================================================
// Width Measurement
// =============================================================================

/**
 * Get the visible width of a string (excluding ANSI codes).
 *
 * @param text - String to measure (may contain ANSI codes)
 * @returns Width in terminal columns
 *
 * @example
 * ```ts
 * getTextWidth('Hello') // 5
 * getTextWidth('\x1b[31mHello\x1b[0m') // 5 (ANSI codes don't count)
 * getTextWidth('你好') // 4 (CJK characters are double-width)
 * ```
 */
export const getTextWidth = (text: string): number => {
  return stringWidth(text)
}
