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

/** Container styles for the terminal preview */
export const containerStyles: React.CSSProperties = {
  width: '100%',
  height: '400px',
  backgroundColor: '#1a1a2e',
  borderRadius: '8px',
  overflow: 'hidden',
  padding: '8px',
}
