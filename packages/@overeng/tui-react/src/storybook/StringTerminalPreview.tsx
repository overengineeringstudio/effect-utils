/**
 * StringTerminalPreview component for rendering TUI React components as ANSI strings
 *
 * Unlike TerminalPreview which renders through the TUI reconciler,
 * this component uses renderToString to get the ANSI output and displays it in xterm.
 */

import React, { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

import { renderToString } from '../renderToString.ts'
import { xtermTheme, containerStyles } from './theme.ts'

export interface StringTerminalPreviewProps<P extends object> {
  /** The component to render */
  component: React.ComponentType<P>
  /** Props to pass to the component */
  props: P
  /** Terminal height in pixels */
  height?: number | undefined
}

/**
 * StringTerminalPreview - renders TUI React components as ANSI strings in xterm.js
 *
 * This simulates non-TTY output where components are rendered once to a string.
 */
export const StringTerminalPreview = <P extends object>({
  component: Component,
  props,
  height = 400,
}: StringTerminalPreviewProps<P>) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    if (!terminalRef.current) {
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
    }

    const terminal = terminalRef.current
    terminal.clear()
    terminal.reset()

    renderToString(React.createElement(Component, props))
      .then((ansiOutput) => {
        const lines = ansiOutput.split('\n')
        lines.forEach((line, i) => {
          terminal.write(line)
          if (i < lines.length - 1) {
            terminal.write('\r\n')
          }
        })
      })
      .catch((err: Error) => {
        terminal.write(`Error: ${err.message}`)
      })

    return () => {}
  }, [props, Component])

  useEffect(() => {
    return () => {
      terminalRef.current?.dispose()
      terminalRef.current = null
    }
  }, [])

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
