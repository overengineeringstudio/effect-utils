/**
 * CLI Design System Tokens
 *
 * Primitive values for colors, symbols, and spacing.
 * Uses ANSI 256-color palette for wide compatibility.
 */

import { unicodeSymbols } from '@overeng/tui-core'

// =============================================================================
// Color Tokens (ANSI 256-color)
// =============================================================================

/** ANSI escape code prefix */
const ESC = '\x1b['

/** Raw ANSI color codes */
export const colors = {
  // Reset
  reset: `${ESC}0m`,

  // Text styles
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  italic: `${ESC}3m`,
  underline: `${ESC}4m`,

  // Standard colors (foreground)
  black: `${ESC}30m`,
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  blue: `${ESC}34m`,
  magenta: `${ESC}35m`,
  cyan: `${ESC}36m`,
  white: `${ESC}37m`,

  // Bright colors (foreground)
  brightBlack: `${ESC}90m`,
  brightRed: `${ESC}91m`,
  brightGreen: `${ESC}92m`,
  brightYellow: `${ESC}93m`,
  brightBlue: `${ESC}94m`,
  brightMagenta: `${ESC}95m`,
  brightCyan: `${ESC}96m`,
  brightWhite: `${ESC}97m`,

  // Background colors
  bgBlack: `${ESC}40m`,
  bgRed: `${ESC}41m`,
  bgGreen: `${ESC}42m`,
  bgYellow: `${ESC}43m`,
  bgBlue: `${ESC}44m`,
  bgMagenta: `${ESC}45m`,
  bgCyan: `${ESC}46m`,
  bgWhite: `${ESC}47m`,

  // 256-color support: use color256(n) for extended palette
} as const

/** Generate ANSI 256-color code (0-255) */
export const color256 = (n: number): string => `${ESC}38;5;${n}m`

/** Generate ANSI 256-color background code (0-255) */
export const bgColor256 = (n: number): string => `${ESC}48;5;${n}m`

// =============================================================================
// Symbol Tokens (Unicode)
// =============================================================================

/** Unicode symbols for CLI output */
export const symbols = {
  // Status indicators
  check: unicodeSymbols.status.check,
  cross: unicodeSymbols.status.cross,
  bullet: unicodeSymbols.status.dirty,
  circle: unicodeSymbols.status.circle,
  circleEmpty: '◌',
  dot: unicodeSymbols.status.dot,
  questionMark: '?',
  exclamation: '!',

  // Arrows
  arrowRight: unicodeSymbols.arrows.right,
  arrowLeft: '←',
  arrowUp: unicodeSymbols.arrows.up,
  arrowDown: '↓',
  arrowLeftRight: '↔',
  arrowUpDown: '↕',

  // Git/Version control
  dirty: '*',
  diverged: '↕',
  ahead: unicodeSymbols.arrows.up,
  behind: '↓',

  // Structural
  separator: unicodeSymbols.line.horizontal,
  verticalBar: '│',
  cornerTopLeft: '┌',
  cornerTopRight: '┐',
  cornerBottomLeft: '└',
  cornerBottomRight: '┘',
  teeRight: '├',
  teeLeft: '┤',

  // Tree structure
  treeMiddle: unicodeSymbols.tree.branch,
  treeLast: unicodeSymbols.tree.last,
  treeVertical: unicodeSymbols.tree.vertical,

  // Other
  ellipsis: '…',
  info: 'ℹ',
  warning: unicodeSymbols.status.warning,
  error: '✖',
} as const

// =============================================================================
// Spacing Tokens
// =============================================================================

/** Spacing tokens for consistent indentation */
export const spacing = {
  /** Single space indent */
  indent1: '  ',
  /** Double space indent */
  indent2: '    ',
  /** Triple space indent */
  indent3: '      ',
} as const

// =============================================================================
// Semantic Color Mappings
// =============================================================================

/** Semantic color mappings for common use cases */
export const semantic = {
  // Status colors
  success: colors.green,
  error: colors.red,
  warning: colors.yellow,
  info: colors.blue,

  // Text emphasis
  primary: colors.white,
  secondary: colors.dim,
  muted: colors.brightBlack,

  // Backgrounds for badges
  bgSuccess: colors.bgGreen,
  bgError: colors.bgRed,
  bgWarning: colors.bgYellow,
  bgInfo: colors.bgBlue,
} as const
