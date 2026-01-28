/**
 * Storybook stories for StoreFetchOutput component.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React, { useEffect, useRef } from 'react'
import { renderToString } from '@overeng/tui-react'
import { xtermTheme, containerStyles } from '@overeng/tui-react/storybook'
import { forceColorLevel } from '@overeng/cli-ui'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { StoreFetchOutput, type StoreFetchOutputProps, type StoreFetchResult } from './StoreOutput.tsx'

forceColorLevel('truecolor')

// =============================================================================
// Example Data
// =============================================================================

const exampleFetchResults: StoreFetchResult[] = [
  { path: 'github.com/effect-ts/effect', status: 'fetched' },
  { path: 'github.com/overengineeringstudio/effect-utils', status: 'fetched' },
  { path: 'github.com/schickling/dotfiles', status: 'error', message: 'network timeout' },
]

// =============================================================================
// String Output Preview
// =============================================================================

const StringOutputPreview = (props: StoreFetchOutputProps) => {
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

    renderToString(React.createElement(StoreFetchOutput, props))
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
  }, [props])

  useEffect(() => {
    return () => {
      terminalRef.current?.dispose()
      terminalRef.current = null
    }
  }, [])

  return <div ref={containerRef} style={containerStyles} />
}

// =============================================================================
// Stories
// =============================================================================

interface StoreFetchStoryProps extends StoreFetchOutputProps {
  renderMode: 'tty' | 'string'
}

const meta: Meta<StoreFetchStoryProps> = {
  title: 'CLI/Store/Fetch',
  component: StoreFetchOutput,
  parameters: {
    docs: {
      description: {
        component: 'Output for the `mr store fetch` command. Shows fetch results for all repositories.',
      },
    },
  },
  argTypes: {
    renderMode: {
      description: 'Switch between TTY (terminal) and non-TTY (string) output',
      control: { type: 'radio' },
      options: ['tty', 'string'],
      table: { category: 'Render Mode' },
    },
    elapsedMs: {
      description: 'Elapsed time in milliseconds',
      control: { type: 'number' },
      table: { category: 'Performance' },
    },
  },
  args: {
    renderMode: 'tty',
    basePath: '/Users/dev/.megarepo',
    results: [],
    elapsedMs: 2350,
  },
  render: ({ renderMode, ...props }) => {
    if (renderMode === 'string') {
      return <StringOutputPreview {...props} />
    }
    return <StoreFetchOutput {...props} />
  },
}

export default meta

type Story = StoryObj<StoreFetchStoryProps>

export const Success: Story = {
  args: {
    results: [
      { path: 'github.com/effect-ts/effect', status: 'fetched' },
      { path: 'github.com/overengineeringstudio/effect-utils', status: 'fetched' },
      { path: 'github.com/schickling/dotfiles', status: 'fetched' },
    ],
    elapsedMs: 1850,
  },
}

export const WithErrors: Story = {
  args: {
    results: exampleFetchResults,
    elapsedMs: 3200,
  },
}

export const AllErrors: Story = {
  args: {
    results: [
      { path: 'github.com/effect-ts/effect', status: 'error', message: 'network timeout' },
      { path: 'github.com/private/repo', status: 'error', message: 'authentication failed' },
    ],
    elapsedMs: 30500,
  },
}
