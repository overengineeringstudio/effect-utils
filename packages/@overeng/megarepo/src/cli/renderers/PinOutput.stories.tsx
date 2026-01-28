/**
 * Storybook stories for PinOutput component.
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
  PinOutput,
  PinErrorOutput,
  type PinOutputProps,
  type PinErrorOutputProps,
} from './PinOutput.tsx'

// =============================================================================
// Example Data
// =============================================================================

const examplePinSuccess: PinOutputProps = {
  action: 'pin',
  member: 'effect',
  status: 'success',
  ref: 'v3.0.0',
  commit: 'abc1234def5678',
}

const examplePinDryRun: PinOutputProps = {
  action: 'pin',
  member: 'effect',
  status: 'dry_run',
  ref: 'v3.0.0',
  dryRun: {
    currentSource: 'effect-ts/effect',
    newSource: 'effect-ts/effect#v3.0.0',
    currentSymlink: '~/.megarepo/.../refs/heads/main',
    newSymlink: '~/.megarepo/.../refs/tags/v3.0.0',
    lockChanges: ['ref: main → v3.0.0', 'pinned: true'],
    wouldCreateWorktree: true,
  },
}

const exampleUnpinSuccess: PinOutputProps = {
  action: 'unpin',
  member: 'effect',
  status: 'success',
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
// Pin Output Stories
// =============================================================================

interface PinOutputStoryProps extends PinOutputProps {
  renderMode: 'tty' | 'string'
}

const pinMeta: Meta<PinOutputStoryProps> = {
  title: 'CLI/Pin Output',
  component: PinOutput,
  argTypes: {
    renderMode: {
      description: 'Switch between TTY and string output',
      control: { type: 'radio' },
      options: ['tty', 'string'],
      table: { category: 'Render Mode' },
    },
    action: {
      control: { type: 'radio' },
      options: ['pin', 'unpin'],
    },
    status: {
      control: { type: 'select' },
      options: ['success', 'already_pinned', 'already_unpinned', 'dry_run'],
    },
  },
  args: {
    renderMode: 'tty',
  },
  render: ({ renderMode, ...props }) => {
    const component = <PinOutput {...props} />
    if (renderMode === 'string') {
      return <StringOutputPreview component={component} />
    }
    return component
  },
}

export default pinMeta

type PinStory = StoryObj<PinOutputStoryProps>

/**
 * Pin with ref and commit
 */
export const PinWithRef: PinStory = {
  args: examplePinSuccess,
}

/**
 * Pin to current commit (no ref change)
 */
export const PinCurrentCommit: PinStory = {
  args: {
    action: 'pin',
    member: 'effect',
    status: 'success',
    commit: 'abc1234def5678',
  },
}

/**
 * Unpin success
 */
export const Unpin: PinStory = {
  args: exampleUnpinSuccess,
}

/**
 * Already pinned
 */
export const AlreadyPinned: PinStory = {
  args: {
    action: 'pin',
    member: 'effect',
    status: 'already_pinned',
    commit: 'abc1234def5678',
  },
}

/**
 * Already unpinned
 */
export const AlreadyUnpinned: PinStory = {
  args: {
    action: 'unpin',
    member: 'effect',
    status: 'already_unpinned',
  },
}

/**
 * Dry run with all changes
 */
export const DryRunFull: PinStory = {
  args: examplePinDryRun,
}

/**
 * Dry run - pin to current commit
 */
export const DryRunSimple: PinStory = {
  args: {
    action: 'pin',
    member: 'effect',
    status: 'dry_run',
    commit: 'abc1234def5678',
    dryRun: {
      lockChanges: ['pinned: false → true'],
    },
  },
}

// =============================================================================
// Pin Error Stories
// =============================================================================

interface PinErrorStoryProps extends PinErrorOutputProps {
  renderMode: 'tty' | 'string'
}

export const ErrorNotInMegarepo: StoryObj<PinErrorStoryProps> = {
  args: {
    error: 'not_in_megarepo',
  },
  render: ({ renderMode, ...props }) => {
    const component = <PinErrorOutput {...props} />
    if (renderMode === 'string') {
      return <StringOutputPreview component={component} />
    }
    return component
  },
}

export const ErrorMemberNotFound: StoryObj<PinErrorStoryProps> = {
  args: {
    error: 'member_not_found',
    member: 'unknown-repo',
  },
  render: ({ renderMode, ...props }) => {
    const component = <PinErrorOutput {...props} />
    if (renderMode === 'string') {
      return <StringOutputPreview component={component} />
    }
    return component
  },
}

export const ErrorNotSynced: StoryObj<PinErrorStoryProps> = {
  args: {
    error: 'not_synced',
    member: 'effect',
  },
  render: ({ renderMode, ...props }) => {
    const component = <PinErrorOutput {...props} />
    if (renderMode === 'string') {
      return <StringOutputPreview component={component} />
    }
    return component
  },
}

export const ErrorLocalPath: StoryObj<PinErrorStoryProps> = {
  args: {
    error: 'local_path',
  },
  render: ({ renderMode, ...props }) => {
    const component = <PinErrorOutput {...props} />
    if (renderMode === 'string') {
      return <StringOutputPreview component={component} />
    }
    return component
  },
}
