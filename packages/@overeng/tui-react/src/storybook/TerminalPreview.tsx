/**
 * TerminalPreview component for rendering TUI React components in Storybook
 *
 * Uses xterm.js to create an authentic terminal experience.
 */

import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import React, { useEffect, useRef, useState } from 'react'
import '@xterm/xterm/css/xterm.css'
import { createRoot, type Root } from '../root.ts'
import { xtermTheme, containerStyles } from './theme.ts'

/**
 * Create a Terminal-compatible adapter for xterm.js
 * This allows createRoot to write to xterm.js instead of process.stdout
 */
const createXtermAdapter = (xterm: Terminal) => ({
  write: (data: string) => xterm.write(data),
  get columns() {
    return xterm.cols
  },
  get rows() {
    return xterm.rows
  },
  isTTY: true as const,
})

export interface TerminalPreviewProps {
  children: React.ReactNode
  /** Terminal height in pixels */
  height?: number
}

/**
 * TerminalPreview - renders TUI React components into an xterm.js terminal
 */
export const TerminalPreview: React.FC<TerminalPreviewProps> = ({ children, height = 400 }) => {
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
      theme: xtermTheme,
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
        ...containerStyles,
        height,
      }}
    />
  )
}
