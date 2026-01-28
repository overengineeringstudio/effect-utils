/**
 * Storybook stories for StoreListOutput component.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React, { useEffect, useRef } from 'react'
import { renderToString } from '@overeng/tui-react'
import { xtermTheme, containerStyles } from '@overeng/tui-react/storybook'
import { forceColorLevel } from '@overeng/cli-ui'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { StoreListOutput, type StoreListOutputProps, type StoreRepo } from './StoreOutput.tsx'

forceColorLevel('truecolor')

// =============================================================================
// Example Data
// =============================================================================

const exampleStoreRepos: StoreRepo[] = [
  { relativePath: 'github.com/effect-ts/effect' },
  { relativePath: 'github.com/overengineeringstudio/effect-utils' },
  { relativePath: 'github.com/schickling/dotfiles' },
]

// =============================================================================
// String Output Preview
// =============================================================================

const StringOutputPreview = (props: StoreListOutputProps) => {
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

    renderToString(React.createElement(StoreListOutput, props))
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

interface StoreListStoryProps extends StoreListOutputProps {
  renderMode: 'tty' | 'string'
}

const meta: Meta<StoreListStoryProps> = {
  title: 'CLI/Store/List',
  component: StoreListOutput,
  parameters: {
    docs: {
      description: {
        component: 'Output for the `mr store ls` command. Shows repositories in the store.',
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
  },
  args: {
    renderMode: 'tty',
    basePath: '/Users/dev/.megarepo',
  },
  render: ({ renderMode, ...props }) => {
    if (renderMode === 'string') {
      return <StringOutputPreview {...props} />
    }
    return <StoreListOutput {...props} />
  },
}

export default meta

type Story = StoryObj<StoreListStoryProps>

export const WithRepos: Story = {
  args: {
    repos: exampleStoreRepos,
  },
}

export const Empty: Story = {
  args: {
    repos: [],
  },
}

export const ManyRepos: Story = {
  args: {
    repos: [
      { relativePath: 'github.com/effect-ts/effect' },
      { relativePath: 'github.com/effect-ts/effect-schema' },
      { relativePath: 'github.com/effect-ts/effect-platform' },
      { relativePath: 'github.com/overengineeringstudio/effect-utils' },
      { relativePath: 'github.com/overengineeringstudio/tui-react' },
      { relativePath: 'github.com/schickling/dotfiles' },
      { relativePath: 'github.com/schickling/config' },
      { relativePath: 'gitlab.com/company/internal-lib' },
    ],
  },
}
