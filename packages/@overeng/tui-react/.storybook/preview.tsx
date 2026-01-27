import type { Preview, Decorator } from '@storybook/react'
import React, { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { createRoot, type Root } from '../src/root.ts'

/**
 * Create a Terminal-compatible adapter for xterm.js
 * This allows createRoot to write to xterm.js instead of process.stdout
 */
const createXtermAdapter = (xterm: Terminal) => ({
  write: (data: string) => xterm.write(data),
  get columns() { return xterm.cols },
  get rows() { return xterm.rows },
  isTTY: true as const,
})

/**
 * TerminalPreview - renders TUI React components into an xterm.js terminal
 */
const TerminalPreview: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const rootRef = useRef<Root | null>(null)
  const [isReady, setIsReady] = useState(false)

  // Initialize terminal
  useEffect(() => {
    if (!containerRef.current || terminalRef.current) return

    const terminal = new Terminal({
      fontFamily: 'Monaco, Menlo, "DejaVu Sans Mono", Consolas, monospace',
      fontSize: 14,
      theme: {
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
      },
      allowProposedApi: true,
      cursorBlink: false,
      cursorStyle: 'bar',
      disableStdin: true,
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(containerRef.current)
    fitAddon.fit()

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon
    
    // Create TUI root with xterm adapter
    const adapter = createXtermAdapter(terminal)
    rootRef.current = createRoot(adapter)
    
    setIsReady(true)

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit()
    })
    resizeObserver.observe(containerRef.current)

    return () => {
      resizeObserver.disconnect()
      rootRef.current?.unmount()
      rootRef.current = null
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [])

  // Render TUI content when children change
  useEffect(() => {
    if (!isReady || !rootRef.current || !terminalRef.current) return
    
    // Clear terminal for fresh render when story changes
    // Note: We only clear on story change, not on animation frames
    // This is handled by the dependency on children
    terminalRef.current.clear()
    terminalRef.current.reset()
    
    // Recreate root for clean state (InlineRenderer has internal state)
    const adapter = createXtermAdapter(terminalRef.current)
    rootRef.current = createRoot(adapter)
    
    // Render the React element - createRoot handles re-renders automatically
    rootRef.current.render(children as React.ReactElement)
    
    return () => {
      rootRef.current?.unmount()
    }
  }, [children, isReady])

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '400px',
        backgroundColor: '#1a1a2e',
        borderRadius: '8px',
        overflow: 'hidden',
        padding: '8px',
      }}
    />
  )
}

/**
 * Decorator that wraps stories in TerminalPreview
 */
const withTerminalPreview: Decorator = (Story) => (
  <TerminalPreview>
    <Story />
  </TerminalPreview>
)

const preview: Preview = {
  parameters: {
    layout: 'padded',
    backgrounds: {
      default: 'dark',
      values: [
        { name: 'dark', value: '#0d1117' },
        { name: 'light', value: '#ffffff' },
      ],
    },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
  },
  decorators: [withTerminalPreview],
}

export default preview
