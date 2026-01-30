/**
 * Text Styling Functions
 *
 * Simple functions to apply ANSI styles to text.
 * Respects NO_COLOR environment variable for accessibility.
 *
 * @see https://no-color.org/
 */

import { supportsColor, resetColorCache as resetColorCacheInternal } from './color-support.ts'
import { colors, semantic } from './tokens.ts'

// =============================================================================
// Color Detection
// =============================================================================

/** Check if colors are disabled */
const isColorDisabled = (): boolean => !supportsColor()

/** Reset cached color state (useful for testing) */
export const resetColorCache = resetColorCacheInternal

// =============================================================================
// Style Application Helper
// =============================================================================

/** Apply ANSI codes to text, respecting NO_COLOR */
const applyStyle = ({ code, text }: { code: string; text: string }): string => {
  if (isColorDisabled()) {
    return text
  }
  return `${code}${text}${colors.reset}`
}

/** Apply multiple ANSI codes to text */
const applyStyles = ({ codes, text }: { codes: string[]; text: string }): string => {
  if (isColorDisabled()) {
    return text
  }
  return `${codes.join('')}${text}${colors.reset}`
}

// =============================================================================
// Text Style Functions
// =============================================================================

/** Text styling functions for terminal output */
export const styled = {
  // Text decorations
  bold: (text: string) => applyStyle({ code: colors.bold, text }),
  dim: (text: string) => applyStyle({ code: colors.dim, text }),
  italic: (text: string) => applyStyle({ code: colors.italic, text }),
  underline: (text: string) => applyStyle({ code: colors.underline, text }),

  // Standard colors
  black: (text: string) => applyStyle({ code: colors.black, text }),
  red: (text: string) => applyStyle({ code: colors.red, text }),
  green: (text: string) => applyStyle({ code: colors.green, text }),
  yellow: (text: string) => applyStyle({ code: colors.yellow, text }),
  blue: (text: string) => applyStyle({ code: colors.blue, text }),
  magenta: (text: string) => applyStyle({ code: colors.magenta, text }),
  cyan: (text: string) => applyStyle({ code: colors.cyan, text }),
  white: (text: string) => applyStyle({ code: colors.white, text }),

  // Bright colors
  brightBlack: (text: string) => applyStyle({ code: colors.brightBlack, text }),
  brightRed: (text: string) => applyStyle({ code: colors.brightRed, text }),
  brightGreen: (text: string) => applyStyle({ code: colors.brightGreen, text }),
  brightYellow: (text: string) => applyStyle({ code: colors.brightYellow, text }),
  brightBlue: (text: string) => applyStyle({ code: colors.brightBlue, text }),
  brightMagenta: (text: string) => applyStyle({ code: colors.brightMagenta, text }),
  brightCyan: (text: string) => applyStyle({ code: colors.brightCyan, text }),
  brightWhite: (text: string) => applyStyle({ code: colors.brightWhite, text }),

  // Semantic colors
  success: (text: string) => applyStyle({ code: semantic.success, text }),
  error: (text: string) => applyStyle({ code: semantic.error, text }),
  warning: (text: string) => applyStyle({ code: semantic.warning, text }),
  info: (text: string) => applyStyle({ code: semantic.info, text }),
  muted: (text: string) => applyStyle({ code: semantic.muted, text }),

  // Combined styles (common patterns)
  boldRed: (text: string) => applyStyles({ codes: [colors.bold, colors.red], text }),
  boldGreen: (text: string) => applyStyles({ codes: [colors.bold, colors.green], text }),
  boldYellow: (text: string) => applyStyles({ codes: [colors.bold, colors.yellow], text }),
  boldBlue: (text: string) => applyStyles({ codes: [colors.bold, colors.blue], text }),
  boldCyan: (text: string) => applyStyles({ codes: [colors.bold, colors.cyan], text }),
  boldMagenta: (text: string) => applyStyles({ codes: [colors.bold, colors.magenta], text }),

  // Dim + color combinations (for subtle colored text)
  dimRed: (text: string) => applyStyles({ codes: [colors.dim, colors.red], text }),
  dimGreen: (text: string) => applyStyles({ codes: [colors.dim, colors.green], text }),
  dimYellow: (text: string) => applyStyles({ codes: [colors.dim, colors.yellow], text }),
  dimBlue: (text: string) => applyStyles({ codes: [colors.dim, colors.blue], text }),
  dimCyan: (text: string) => applyStyles({ codes: [colors.dim, colors.cyan], text }),
  dimMagenta: (text: string) => applyStyles({ codes: [colors.dim, colors.magenta], text }),
} as const

// =============================================================================
// Raw Style Application (for advanced use)
// =============================================================================

/** Apply raw ANSI codes (for custom combinations) */
export const raw = ({ codes, text }: { codes: string | string[]; text: string }): string => {
  const codeArray = Array.isArray(codes) ? codes : [codes]
  return applyStyles({ codes: codeArray, text })
}
