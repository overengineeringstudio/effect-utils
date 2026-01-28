/**
 * Storybook stories for StoreGcOutput component.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React, { useEffect, useRef } from 'react'
import { renderToString } from '@overeng/tui-react'
import { xtermTheme, containerStyles } from '@overeng/tui-react/storybook'
import { forceColorLevel } from '@overeng/cli-ui'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { StoreGcOutput, type StoreGcOutputProps, type StoreGcResult } from './StoreOutput.tsx'

forceColorLevel('truecolor')

// =============================================================================
// Example Data
// =============================================================================

const exampleGcResults: StoreGcResult[] = [
  { repo: 'github.com/effect-ts/effect', ref: 'feat/old-branch', path: '/store/...', status: 'removed' },
  { repo: 'github.com/effect-ts/effect', ref: 'main', path: '/store/...', status: 'skipped_in_use' },
  { repo: 'github.com/overengineeringstudio/effect-utils', ref: 'dev', path: '/store/...', status: 'skipped_dirty' },
]

// =============================================================================
// String Output Preview
// =============================================================================

const StringOutputPreview = (props: StoreGcOutputProps) => {
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

    renderToString(React.createElement(StoreGcOutput, props))
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

interface StoreGcStoryProps extends StoreGcOutputProps {
  renderMode: 'tty' | 'string'
}

const meta: Meta<StoreGcStoryProps> = {
  title: 'CLI/Store/GC',
  component: StoreGcOutput,
  parameters: {
    docs: {
      description: {
        component: 'Output for the `mr store gc` command. Shows garbage collection results for worktrees.',
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
    dryRun: {
      description: 'Dry run mode - shows what would be removed without removing',
      control: { type: 'boolean' },
      table: { category: 'Options' },
    },
    showForceHint: {
      description: 'Show hint to use --force for dirty worktrees',
      control: { type: 'boolean' },
      table: { category: 'Options' },
    },
    maxInUseToShow: {
      description: 'Max number of in-use worktrees to show individually',
      control: { type: 'number' },
      table: { category: 'Options' },
    },
  },
  args: {
    renderMode: 'tty',
    basePath: '/Users/dev/.megarepo',
    results: [],
    dryRun: false,
    showForceHint: true,
    maxInUseToShow: 5,
  },
  render: ({ renderMode, ...props }) => {
    if (renderMode === 'string') {
      return <StringOutputPreview {...props} />
    }
    return <StoreGcOutput {...props} />
  },
}

export default meta

type Story = StoryObj<StoreGcStoryProps>

export const Mixed: Story = {
  args: {
    results: exampleGcResults,
  },
}

export const DryRun: Story = {
  args: {
    results: [
      { repo: 'github.com/effect-ts/effect', ref: 'feat/old-branch', path: '/store/...', status: 'removed' },
      { repo: 'github.com/effect-ts/effect', ref: 'fix/deprecated', path: '/store/...', status: 'removed' },
    ],
    dryRun: true,
  },
}

export const OnlyCurrentMegarepo: Story = {
  args: {
    results: exampleGcResults,
    warning: { type: 'only_current_megarepo' },
  },
}

export const NotInMegarepo: Story = {
  args: {
    results: [
      { repo: 'github.com/effect-ts/effect', ref: 'main', path: '/store/...', status: 'removed' },
      { repo: 'github.com/effect-ts/effect', ref: 'feat/old', path: '/store/...', status: 'removed' },
    ],
    warning: { type: 'not_in_megarepo' },
    dryRun: true,
  },
}

export const CustomWarning: Story = {
  args: {
    results: exampleGcResults,
    warning: { type: 'custom', message: 'Custom warning message for edge case' },
  },
}

export const Empty: Story = {
  args: {
    results: [],
  },
}

export const AllSkipped: Story = {
  args: {
    results: [
      { repo: 'github.com/effect-ts/effect', ref: 'main', path: '/store/...', status: 'skipped_in_use' },
      { repo: 'github.com/effect-ts/effect', ref: 'dev', path: '/store/...', status: 'skipped_dirty' },
      { repo: 'github.com/overengineeringstudio/effect-utils', ref: 'main', path: '/store/...', status: 'skipped_in_use' },
    ],
  },
}

// =============================================================================
// Edge Cases
// =============================================================================

/** All worktrees removed successfully */
export const AllRemoved: Story = {
  args: {
    results: [
      { repo: 'github.com/effect-ts/effect', ref: 'feat/old-1', path: '/store/...', status: 'removed' },
      { repo: 'github.com/effect-ts/effect', ref: 'feat/old-2', path: '/store/...', status: 'removed' },
      { repo: 'github.com/effect-ts/effect', ref: 'feat/old-3', path: '/store/...', status: 'removed' },
      { repo: 'github.com/overengineeringstudio/effect-utils', ref: 'experiment', path: '/store/...', status: 'removed' },
    ],
  },
}

/** All worktrees have errors */
export const AllErrors: Story = {
  args: {
    results: [
      { repo: 'github.com/effect-ts/effect', ref: 'main', path: '/store/...', status: 'error', message: 'Permission denied' },
      { repo: 'github.com/effect-ts/effect', ref: 'dev', path: '/store/...', status: 'error', message: 'Directory not found' },
      { repo: 'github.com/overengineeringstudio/effect-utils', ref: 'main', path: '/store/...', status: 'error', message: 'Lock file in use' },
    ],
  },
}

/** Many in-use worktrees (exceeds maxInUseToShow) */
export const ManyInUse: Story = {
  args: {
    results: [
      { repo: 'github.com/effect-ts/effect', ref: 'main', path: '/store/...', status: 'skipped_in_use' },
      { repo: 'github.com/effect-ts/effect', ref: 'dev', path: '/store/...', status: 'skipped_in_use' },
      { repo: 'github.com/effect-ts/effect', ref: 'feat/a', path: '/store/...', status: 'skipped_in_use' },
      { repo: 'github.com/effect-ts/effect', ref: 'feat/b', path: '/store/...', status: 'skipped_in_use' },
      { repo: 'github.com/effect-ts/effect', ref: 'feat/c', path: '/store/...', status: 'skipped_in_use' },
      { repo: 'github.com/effect-ts/effect', ref: 'feat/d', path: '/store/...', status: 'skipped_in_use' },
      { repo: 'github.com/overengineeringstudio/effect-utils', ref: 'main', path: '/store/...', status: 'skipped_in_use' },
      { repo: 'github.com/overengineeringstudio/effect-utils', ref: 'dev', path: '/store/...', status: 'skipped_in_use' },
    ],
    maxInUseToShow: 3,
  },
}

/** Dirty worktrees with uncommitted changes count */
export const DirtyWithDetails: Story = {
  args: {
    results: [
      { repo: 'github.com/effect-ts/effect', ref: 'feature-branch', path: '/store/...', status: 'skipped_dirty', message: '5 uncommitted change(s)' },
      { repo: 'github.com/effect-ts/effect', ref: 'wip-branch', path: '/store/...', status: 'skipped_dirty', message: 'has unpushed commits' },
      { repo: 'github.com/overengineeringstudio/effect-utils', ref: 'experimental', path: '/store/...', status: 'skipped_dirty', message: '12 uncommitted change(s)' },
    ],
    showForceHint: true,
  },
}

/** Dry run with force hint disabled (force mode) */
export const DryRunForceMode: Story = {
  args: {
    results: [
      { repo: 'github.com/effect-ts/effect', ref: 'dirty-branch', path: '/store/...', status: 'removed' },
      { repo: 'github.com/effect-ts/effect', ref: 'clean-branch', path: '/store/...', status: 'removed' },
    ],
    dryRun: true,
    showForceHint: false,
  },
}

/** Large cleanup with all result types */
export const LargeCleanup: Story = {
  args: {
    results: [
      { repo: 'github.com/effect-ts/effect', ref: 'feat/old-1', path: '/store/...', status: 'removed' },
      { repo: 'github.com/effect-ts/effect', ref: 'feat/old-2', path: '/store/...', status: 'removed' },
      { repo: 'github.com/effect-ts/effect', ref: 'feat/old-3', path: '/store/...', status: 'removed' },
      { repo: 'github.com/overengineeringstudio/effect-utils', ref: 'wip', path: '/store/...', status: 'skipped_dirty', message: '3 uncommitted change(s)' },
      { repo: 'github.com/livestorejs/livestore', ref: 'main', path: '/store/...', status: 'skipped_in_use' },
      { repo: 'github.com/livestorejs/livestore', ref: 'dev', path: '/store/...', status: 'skipped_in_use' },
      { repo: 'github.com/private/repo', ref: 'main', path: '/store/...', status: 'error', message: 'Permission denied' },
    ],
    warning: { type: 'only_current_megarepo' },
  },
}
