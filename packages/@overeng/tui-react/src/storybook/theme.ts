/**
 * xterm.js theme configuration for TUI Storybook
 */

import type { ITheme } from '@xterm/xterm'

/** Default dark theme for TUI terminal preview */
export const xtermTheme: ITheme = {
  background: '#1a1a2e',
  foreground: '#eee',
  cursor: '#eee',
  cursorAccent: '#1a1a2e',
  black: '#1a1a2e',
  red: '#ff6b6b',
  green: '#51cf66',
  yellow: '#fcc419',
  blue: '#339af0',
  magenta: '#cc5de8',
  cyan: '#22b8cf',
  white: '#eeeeee',
  brightBlack: '#495057',
  brightRed: '#ff8787',
  brightGreen: '#69db7c',
  brightYellow: '#ffd43b',
  brightBlue: '#5c7cfa',
  brightMagenta: '#da77f2',
  brightCyan: '#3bc9db',
  brightWhite: '#ffffff',
}

/** Base container styles (no padding - applied separately) */
export const containerStyles: React.CSSProperties = {
  width: '100%',
  height: '400px',
  backgroundColor: '#1a1a2e',
  borderRadius: '8px',
  overflow: 'hidden',
  boxSizing: 'border-box',
}

/**
 * Padding for all preview containers.
 * Both terminal and text containers use the same padding to ensure
 * text alignment when switching between tabs.
 */
export const previewPadding = '8px'

/**
 * Text styles for plain text preview panes (matches xterm.js rendering).
 *
 * IMPORTANT: These must match xterm.js Terminal options exactly:
 * - fontFamily: Same as Terminal constructor
 * - fontSize: Same as Terminal constructor
 * - lineHeight: Must match xterm.js cell height (18px for 14px font)
 *
 * Measured via Playwright: xterm.js DOM renderer uses 18px line-height.
 * The first character must align vertically with xterm's first row.
 */
export const previewTextStyles: React.CSSProperties = {
  margin: 0,
  padding: previewPadding,
  color: '#eee', // Match xtermTheme.foreground
  fontFamily: 'Monaco, Menlo, "DejaVu Sans Mono", Consolas, monospace',
  fontSize: '14px',
  lineHeight: '18px', // Match xterm.js cell height (measured)
  whiteSpace: 'pre',
  wordBreak: 'break-word',
}
