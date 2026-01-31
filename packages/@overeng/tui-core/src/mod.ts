/**
 * @overeng/tui-core
 *
 * Low-level terminal rendering utilities for inline (non-fullscreen) output.
 * Provides differential rendering, synchronized output, and static/dynamic region management.
 *
 * @example
 * ```ts
 * import { InlineRenderer, type Terminal } from '@overeng/tui-core'
 *
 * const renderer = new InlineRenderer(process.stdout)
 *
 * // Render dynamic content (updates in place)
 * renderer.render(['Line 1', 'Line 2'])
 * renderer.render(['Line 1 updated', 'Line 2'])
 *
 * // Append static content (permanent, above dynamic region)
 * renderer.appendStatic(['[INFO] Log message'])
 *
 * // Cleanup
 * renderer.dispose()
 * ```
 */

// Terminal abstraction
export {
  type Terminal,
  type TerminalLike,
  createTerminal,
  isTerminal,
  resolveTerminal,
} from './terminal.ts'

// ANSI escape code utilities
export {
  // Cursor movement
  cursorUp,
  cursorDown,
  cursorToColumn,
  cursorSave,
  cursorRestore,
  // Line operations
  clearLine,
  clearToEndOfLine,
  clearToStartOfLine,
  clearLinesAbove,
  // Cursor visibility
  hideCursor,
  showCursor,
  // Synchronized output
  beginSyncOutput,
  endSyncOutput,
  // Colors and styles
  reset,
  bold,
  dim,
  italic,
  underline,
  strikethrough,
  fg,
  bg,
  fgCode,
  bgCode,
  fgReset,
  bgReset,
  // Color types and guards
  type Color,
  type ColorName,
  type Color256,
  type ColorRgb,
  isColorName,
  isColor256,
  isColorRgb,
} from './ansi.ts'

// Inline renderer
export {
  InlineRenderer,
  type InlineRendererOptions,
  type ExitMode,
  type DisposeOptions,
} from './renderer.ts'
