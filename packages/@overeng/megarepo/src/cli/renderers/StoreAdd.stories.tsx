/**
 * Storybook stories for StoreAdd components.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React, { useEffect, useRef } from 'react'
import { renderToString } from '@overeng/tui-react'
import { xtermTheme, containerStyles } from '@overeng/tui-react/storybook'
import { forceColorLevel } from '@overeng/cli-ui'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import {
  StoreAddError,
  StoreAddProgress,
  StoreAddSuccess,
  type StoreAddErrorProps,
  type StoreAddProgressProps,
  type StoreAddSuccessProps,
} from './StoreOutput.tsx'

forceColorLevel('truecolor')

// =============================================================================
// Example Data
// =============================================================================

const exampleAddSuccess: StoreAddSuccessProps = {
  source: 'effect-ts/effect',
  ref: 'main',
  commit: 'abc1234567890',
  path: '/Users/me/.megarepo/store/github.com/effect-ts/effect/refs/main',
  alreadyExists: false,
}

const exampleAddSuccessExisting: StoreAddSuccessProps = {
  source: 'effect-ts/effect',
  ref: 'main',
  commit: 'abc1234567890',
  path: '/Users/me/.megarepo/store/github.com/effect-ts/effect/refs/main',
  alreadyExists: true,
}

// =============================================================================
// Generic String Output Preview
// =============================================================================

const StringOutputPreview = <P extends object>({
  Component,
  props,
}: {
  Component: React.ComponentType<P>
  props: P
}) => {
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

  return <div ref={containerRef} style={containerStyles} />
}

// =============================================================================
// Error Stories
// =============================================================================

interface StoreAddErrorStoryProps extends StoreAddErrorProps {
  renderMode: 'tty' | 'string'
}

const errorMeta: Meta<StoreAddErrorStoryProps> = {
  title: 'CLI/Store/Add/Error',
  component: StoreAddError,
  parameters: {
    docs: {
      description: {
        component: 'Error output for the `mr store add` command when inputs are invalid.',
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
    type: {
      description: 'Error type',
      control: { type: 'select' },
      options: ['invalid_source', 'local_path', 'no_url'],
      table: { category: 'Error' },
    },
    source: {
      description: 'Source string that caused the error (for invalid_source)',
      control: { type: 'text' },
      table: { category: 'Error' },
    },
  },
  args: {
    renderMode: 'tty',
    type: 'invalid_source',
  },
  render: ({ renderMode, ...props }) => {
    if (renderMode === 'string') {
      return <StringOutputPreview Component={StoreAddError} props={props} />
    }
    return <StoreAddError {...props} />
  },
}

export default errorMeta

type ErrorStory = StoryObj<StoreAddErrorStoryProps>

export const InvalidSource: ErrorStory = {
  args: {
    type: 'invalid_source',
    source: 'not-a-valid-source',
  },
}

export const LocalPath: ErrorStory = {
  args: {
    type: 'local_path',
  },
}

export const NoUrl: ErrorStory = {
  args: {
    type: 'no_url',
  },
}

// =============================================================================
// Progress Stories (exported for separate story file import)
// =============================================================================

interface StoreAddProgressStoryProps extends StoreAddProgressProps {
  renderMode: 'tty' | 'string'
}

export const progressMeta: Meta<StoreAddProgressStoryProps> = {
  title: 'CLI/Store/Add/Progress',
  component: StoreAddProgress,
  parameters: {
    docs: {
      description: {
        component: 'Progress output for the `mr store add` command during clone/worktree creation.',
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
    type: {
      description: 'Progress step type',
      control: { type: 'select' },
      options: ['cloning', 'creating_worktree'],
      table: { category: 'Progress' },
    },
  },
  args: {
    renderMode: 'tty',
    type: 'cloning',
  },
  render: ({ renderMode, ...props }) => {
    if (renderMode === 'string') {
      return <StringOutputPreview Component={StoreAddProgress} props={props} />
    }
    return <StoreAddProgress {...props} />
  },
}

type ProgressStory = StoryObj<StoreAddProgressStoryProps>

export const Cloning: ProgressStory = {
  args: {
    type: 'cloning',
    source: 'effect-ts/effect',
  },
}

export const CreatingWorktree: ProgressStory = {
  args: {
    type: 'creating_worktree',
    ref: 'main',
  },
}

// =============================================================================
// Success Stories (exported for separate story file import)
// =============================================================================

interface StoreAddSuccessStoryProps extends StoreAddSuccessProps {
  renderMode: 'tty' | 'string'
}

export const successMeta: Meta<StoreAddSuccessStoryProps> = {
  title: 'CLI/Store/Add/Success',
  component: StoreAddSuccess,
  parameters: {
    docs: {
      description: {
        component: 'Success output for the `mr store add` command after successful add.',
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
    alreadyExists: {
      description: 'Whether the repository already existed in the store',
      control: { type: 'boolean' },
      table: { category: 'Status' },
    },
  },
  args: {
    renderMode: 'tty',
    ...exampleAddSuccess,
  },
  render: ({ renderMode, ...props }) => {
    if (renderMode === 'string') {
      return <StringOutputPreview Component={StoreAddSuccess} props={props} />
    }
    return <StoreAddSuccess {...props} />
  },
}

type SuccessStory = StoryObj<StoreAddSuccessStoryProps>

export const SuccessNew: SuccessStory = {
  args: exampleAddSuccess,
}

export const SuccessExisting: SuccessStory = {
  args: exampleAddSuccessExisting,
}

export const SuccessWithRef: SuccessStory = {
  args: {
    source: 'effect-ts/effect#feat/new-feature',
    ref: 'feat/new-feature',
    commit: 'def456789012',
    path: '/Users/me/.megarepo/store/github.com/effect-ts/effect/refs/feat/new-feature',
    alreadyExists: false,
  },
}

export const SuccessNoCommit: SuccessStory = {
  args: {
    source: 'effect-ts/effect',
    ref: 'v3.0.0',
    commit: undefined,
    path: '/Users/me/.megarepo/store/github.com/effect-ts/effect/refs/v3.0.0',
    alreadyExists: false,
  },
}
