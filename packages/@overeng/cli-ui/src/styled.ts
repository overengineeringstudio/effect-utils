/**
 * Text Styling Functions
 *
 * Simple functions to apply ANSI styles to text.
 * Respects NO_COLOR environment variable for accessibility.
 *
 * @see https://no-color.org/
 */

import { colors, semantic } from './tokens.ts'

// =============================================================================
// Color Detection
// =============================================================================

/** Check if colors should be disabled based on environment */
const shouldDisableColors = (): boolean => {
  // NO_COLOR takes precedence (any value disables colors)
  if (typeof process !== 'undefined' && process.env?.NO_COLOR !== undefined) {
    return true
  }

  // FORCE_COLOR overrides and enables colors
  if (typeof process !== 'undefined' && process.env?.FORCE_COLOR !== undefined) {
    return false
  }

  return false
}

/** Cached color state - computed once */
let colorsDisabled: boolean | undefined

const isColorDisabled = (): boolean => {
  if (colorsDisabled === undefined) {
    colorsDisabled = shouldDisableColors()
  }
  return colorsDisabled
}

/** Reset cached color state (useful for testing) */
export const resetColorCache = (): void => {
  colorsDisabled = undefined
}

// =============================================================================
// Style Application Helper
// =============================================================================

/** Apply ANSI codes to text, respecting NO_COLOR */
const applyStyle = (code: string, text: string): string => {
  if (isColorDisabled()) {
    return text
  }
  return `${code}${text}${colors.reset}`
}

/** Apply multiple ANSI codes to text */
const applyStyles = (codes: string[], text: string): string => {
  if (isColorDisabled()) {
    return text
  }
  return `${codes.join('')}${text}${colors.reset}`
}

// =============================================================================
// Text Style Functions
// =============================================================================

export const styled = {
  // Text decorations
  bold: (text: string) => applyStyle(colors.bold, text),
  dim: (text: string) => applyStyle(colors.dim, text),
  italic: (text: string) => applyStyle(colors.italic, text),
  underline: (text: string) => applyStyle(colors.underline, text),

  // Standard colors
  black: (text: string) => applyStyle(colors.black, text),
  red: (text: string) => applyStyle(colors.red, text),
  green: (text: string) => applyStyle(colors.green, text),
  yellow: (text: string) => applyStyle(colors.yellow, text),
  blue: (text: string) => applyStyle(colors.blue, text),
  magenta: (text: string) => applyStyle(colors.magenta, text),
  cyan: (text: string) => applyStyle(colors.cyan, text),
  white: (text: string) => applyStyle(colors.white, text),

  // Bright colors
  brightBlack: (text: string) => applyStyle(colors.brightBlack, text),
  brightRed: (text: string) => applyStyle(colors.brightRed, text),
  brightGreen: (text: string) => applyStyle(colors.brightGreen, text),
  brightYellow: (text: string) => applyStyle(colors.brightYellow, text),
  brightBlue: (text: string) => applyStyle(colors.brightBlue, text),
  brightMagenta: (text: string) => applyStyle(colors.brightMagenta, text),
  brightCyan: (text: string) => applyStyle(colors.brightCyan, text),
  brightWhite: (text: string) => applyStyle(colors.brightWhite, text),

  // Semantic colors
  success: (text: string) => applyStyle(semantic.success, text),
  error: (text: string) => applyStyle(semantic.error, text),
  warning: (text: string) => applyStyle(semantic.warning, text),
  info: (text: string) => applyStyle(semantic.info, text),
  muted: (text: string) => applyStyle(semantic.muted, text),

  // Combined styles (common patterns)
  boldRed: (text: string) => applyStyles([colors.bold, colors.red], text),
  boldGreen: (text: string) => applyStyles([colors.bold, colors.green], text),
  boldYellow: (text: string) => applyStyles([colors.bold, colors.yellow], text),
  boldBlue: (text: string) => applyStyles([colors.bold, colors.blue], text),
  boldCyan: (text: string) => applyStyles([colors.bold, colors.cyan], text),
  boldMagenta: (text: string) => applyStyles([colors.bold, colors.magenta], text),

  // Dim + color combinations (for subtle colored text)
  dimRed: (text: string) => applyStyles([colors.dim, colors.red], text),
  dimGreen: (text: string) => applyStyles([colors.dim, colors.green], text),
  dimYellow: (text: string) => applyStyles([colors.dim, colors.yellow], text),
  dimBlue: (text: string) => applyStyles([colors.dim, colors.blue], text),
  dimCyan: (text: string) => applyStyles([colors.dim, colors.cyan], text),
  dimMagenta: (text: string) => applyStyles([colors.dim, colors.magenta], text),
} as const

// =============================================================================
// Raw Style Application (for advanced use)
// =============================================================================

/** Apply raw ANSI codes (for custom combinations) */
export const raw = (codes: string | string[], text: string): string => {
  const codeArray = Array.isArray(codes) ? codes : [codes]
  return applyStyles(codeArray, text)
}
