/**
 * Storybook stories for AddOutput component.
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
  AddOutput,
  AddErrorOutput,
  type AddOutputProps,
  type AddErrorOutputProps,
} from './AddOutput.tsx'

// =============================================================================
// Example Data
// =============================================================================

const exampleAddSuccess: AddOutputProps = {
  member: 'effect',
  source: 'effect-ts/effect',
}

const exampleAddWithSync: AddOutputProps = {
  member: 'effect',
  source: 'effect-ts/effect',
  synced: true,
  syncStatus: 'cloned',
}

const exampleAddSyncError: AddOutputProps = {
  member: 'private-repo',
  source: 'org/private-repo',
  synced: true,
  syncStatus: 'error',
  syncMessage: 'authentication required',
}

// Force colors on in Storybook
forceColorLevel('truecolor')

// =============================================================================
// String Output Preview
// =============================================================================

const StringOutputPreview = ({ component }: { component: React.ReactElement }) => {
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

    renderToString(component)
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
  }, [component])

  useEffect(() => {
    return () => {
      terminalRef.current?.dispose()
      terminalRef.current = null
    }
  }, [])

  return <div ref={containerRef} style={{ ...containerStyles, height: 200 }} />
}

// =============================================================================
// Add Output Stories
// =============================================================================

interface AddOutputStoryProps extends AddOutputProps {
  renderMode: 'tty' | 'string'
}

const addMeta: Meta<AddOutputStoryProps> = {
  title: 'CLI/Add Output',
  component: AddOutput,
  argTypes: {
    renderMode: {
      description: 'Switch between TTY and string output',
      control: { type: 'radio' },
      options: ['tty', 'string'],
      table: { category: 'Render Mode' },
    },
    syncStatus: {
      control: { type: 'select' },
      options: ['cloned', 'synced', 'error'],
    },
  },
  args: {
    renderMode: 'tty',
  },
  render: ({ renderMode, ...props }) => {
    const component = <AddOutput {...props} />
    if (renderMode === 'string') {
      return <StringOutputPreview component={component} />
    }
    return component
  },
}

export default addMeta

type AddStory = StoryObj<AddOutputStoryProps>

/**
 * Simple add without sync
 */
export const AddSimple: AddStory = {
  args: exampleAddSuccess,
}

/**
 * Add with immediate sync (cloned)
 */
export const AddWithSync: AddStory = {
  args: exampleAddWithSync,
}

/**
 * Add with sync that succeeded (synced status)
 */
export const AddWithSyncExisting: AddStory = {
  args: {
    member: 'effect',
    source: 'effect-ts/effect',
    synced: true,
    syncStatus: 'synced',
  },
}

/**
 * Add with sync error
 */
export const AddWithSyncError: AddStory = {
  args: exampleAddSyncError,
}

// =============================================================================
// Add Error Stories
// =============================================================================

interface AddErrorStoryProps extends AddErrorOutputProps {
  renderMode: 'tty' | 'string'
}

export const ErrorNotInMegarepo: StoryObj<AddErrorStoryProps> = {
  args: {
    error: 'not_in_megarepo',
  },
  render: ({ renderMode, ...props }) => {
    const component = <AddErrorOutput {...props} />
    if (renderMode === 'string') {
      return <StringOutputPreview component={component} />
    }
    return component
  },
}

export const ErrorInvalidRepo: StoryObj<AddErrorStoryProps> = {
  args: {
    error: 'invalid_repo',
    repo: 'not-a-valid-repo',
  },
  render: ({ renderMode, ...props }) => {
    const component = <AddErrorOutput {...props} />
    if (renderMode === 'string') {
      return <StringOutputPreview component={component} />
    }
    return component
  },
}

export const ErrorAlreadyExists: StoryObj<AddErrorStoryProps> = {
  args: {
    error: 'already_exists',
    member: 'effect',
  },
  render: ({ renderMode, ...props }) => {
    const component = <AddErrorOutput {...props} />
    if (renderMode === 'string') {
      return <StringOutputPreview component={component} />
    }
    return component
  },
}
