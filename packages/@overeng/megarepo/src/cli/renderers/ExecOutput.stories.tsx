/**
 * Storybook stories for ExecOutput components.
 *
 * These stories demonstrate the various states of the exec command outputs.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React, { useEffect, useRef } from 'react'
import { renderToString, Box } from '@overeng/tui-react'
import { xtermTheme, containerStyles } from '@overeng/tui-react/storybook'
import { forceColorLevel } from '@overeng/cli-ui'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import {
  ExecErrorOutput,
  ExecVerboseHeader,
  ExecMemberSkipped,
  ExecMemberPath,
  ExecResultsOutput,
  type ExecErrorOutputProps,
  type ExecVerboseHeaderProps,
  type ExecResultsOutputProps,
  type ExecMemberResult,
} from './ExecOutput.tsx'

// =============================================================================
// Example Data
// =============================================================================

const exampleExecResults: ExecMemberResult[] = [
  {
    name: 'effect',
    exitCode: 0,
    stdout: 'v3.0.0',
    stderr: '',
  },
  {
    name: 'effect-utils',
    exitCode: 0,
    stdout: 'v1.2.3',
    stderr: '',
  },
  {
    name: 'livestore',
    exitCode: 1,
    stdout: '',
    stderr: 'Command failed: npm version',
  },
]

const exampleExecResultsWithOutput: ExecMemberResult[] = [
  {
    name: 'effect',
    exitCode: 0,
    stdout: `added 125 packages in 2.3s
15 packages are looking for funding
  run \`npm fund\` for details`,
    stderr: '',
  },
  {
    name: 'effect-utils',
    exitCode: 0,
    stdout: `added 45 packages in 1.1s`,
    stderr: '',
  },
]

// Force colors on in Storybook (browser environment has no TTY)
forceColorLevel('truecolor')

// =============================================================================
// Non-TTY Preview Component
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
// Error Output Stories
// =============================================================================

interface ExecErrorStoryProps extends ExecErrorOutputProps {
  renderMode: 'tty' | 'string'
}

const errorMeta: Meta<ExecErrorStoryProps> = {
  title: 'CLI/Exec/Error',
  component: ExecErrorOutput,
  parameters: {
    docs: {
      description: {
        component: 'Error outputs for the `mr exec` command.',
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
      description: 'Type of error',
      control: { type: 'select' },
      options: ['not_in_megarepo', 'member_not_found'],
      table: { category: 'Error' },
    },
  },
  args: {
    renderMode: 'tty',
  },
  render: ({ renderMode, ...props }) => {
    if (renderMode === 'string') {
      return <StringOutputPreview Component={ExecErrorOutput} props={props} />
    }
    return <ExecErrorOutput {...props} />
  },
}

export default errorMeta

type ExecErrorStory = StoryObj<ExecErrorStoryProps>

export const NotInMegarepo: ExecErrorStory = {
  args: {
    type: 'not_in_megarepo',
  },
}

export const MemberNotFound: ExecErrorStory = {
  args: {
    type: 'member_not_found',
  },
}

// =============================================================================
// Verbose Header Stories
// =============================================================================

interface ExecVerboseStoryProps extends ExecVerboseHeaderProps {
  renderMode: 'tty' | 'string'
}

export const VerboseMeta: Meta<ExecVerboseStoryProps> = {
  title: 'CLI/Exec/Verbose Header',
  component: ExecVerboseHeader,
  parameters: {
    docs: {
      description: {
        component: 'Verbose header output for the `mr exec` command when using `--verbose`.',
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
    mode: {
      description: 'Execution mode',
      control: { type: 'select' },
      options: ['parallel', 'sequential'],
      table: { category: 'Options' },
    },
  },
  args: {
    renderMode: 'tty',
    command: 'npm version',
    mode: 'parallel',
    members: ['effect', 'effect-utils', 'livestore'],
  },
  render: ({ renderMode, ...props }) => {
    if (renderMode === 'string') {
      return <StringOutputPreview Component={ExecVerboseHeader} props={props} />
    }
    return <ExecVerboseHeader {...props} />
  },
}

type ExecVerboseStory = StoryObj<ExecVerboseStoryProps>

export const VerboseParallel: ExecVerboseStory = {
  args: {
    command: 'npm version',
    mode: 'parallel',
    members: ['effect', 'effect-utils', 'livestore'],
  },
}

export const VerboseSequential: ExecVerboseStory = {
  args: {
    command: 'git status',
    mode: 'sequential',
    members: ['effect', 'effect-utils'],
  },
}

export const VerboseSingleMember: ExecVerboseStory = {
  args: {
    command: 'pnpm install',
    mode: 'parallel',
    members: ['effect'],
  },
}

// =============================================================================
// Results Output Stories
// =============================================================================

interface ExecResultsStoryProps extends ExecResultsOutputProps {
  renderMode: 'tty' | 'string'
}

export const ResultsMeta: Meta<ExecResultsStoryProps> = {
  title: 'CLI/Exec/Results',
  component: ExecResultsOutput,
  parameters: {
    docs: {
      description: {
        component: 'Results output for the `mr exec` command showing command output per member.',
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
  },
  render: ({ renderMode, ...props }) => {
    if (renderMode === 'string') {
      return <StringOutputPreview Component={ExecResultsOutput} props={props} />
    }
    return <ExecResultsOutput {...props} />
  },
}

type ExecResultsStory = StoryObj<ExecResultsStoryProps>

export const MixedResults: ExecResultsStory = {
  args: {
    results: exampleExecResults,
  },
}

export const WithMultilineOutput: ExecResultsStory = {
  args: {
    results: exampleExecResultsWithOutput,
  },
}

export const AllSuccess: ExecResultsStory = {
  args: {
    results: [
      { name: 'effect', exitCode: 0, stdout: 'ok', stderr: '' },
      { name: 'effect-utils', exitCode: 0, stdout: 'ok', stderr: '' },
      { name: 'livestore', exitCode: 0, stdout: 'ok', stderr: '' },
    ],
  },
}

export const AllErrors: ExecResultsStory = {
  args: {
    results: [
      { name: 'effect', exitCode: 1, stdout: '', stderr: 'Command not found: foo' },
      { name: 'effect-utils', exitCode: 1, stdout: '', stderr: 'Permission denied' },
      { name: 'livestore', exitCode: 127, stdout: '', stderr: 'sh: command not found' },
    ],
  },
}

// =============================================================================
// Verbose Member Status Stories (Composite)
// =============================================================================

/** Composite component showing verbose member status lines */
const VerboseMemberStatus = ({
  members,
}: {
  members: Array<{ name: string; synced: boolean; path?: string }>
}) => (
  <Box flexDirection="column">
    {members.map((m) =>
      m.synced ? (
        <ExecMemberPath key={m.name} name={m.name} path={m.path ?? `/repos/${m.name}`} />
      ) : (
        <ExecMemberSkipped key={m.name} name={m.name} />
      ),
    )}
  </Box>
)

interface VerboseMemberStatusStoryProps {
  renderMode: 'tty' | 'string'
  members: Array<{ name: string; synced: boolean; path?: string }>
}

export const MemberStatusMeta: Meta<VerboseMemberStatusStoryProps> = {
  title: 'CLI/Exec/Member Status',
  component: VerboseMemberStatus,
  parameters: {
    docs: {
      description: {
        component: 'Verbose member status lines showing synced/skipped status for each member.',
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
  },
  render: ({ renderMode, ...props }) => {
    if (renderMode === 'string') {
      return <StringOutputPreview Component={VerboseMemberStatus} props={props} />
    }
    return <VerboseMemberStatus {...props} />
  },
}

type MemberStatusStory = StoryObj<VerboseMemberStatusStoryProps>

export const AllSynced: MemberStatusStory = {
  args: {
    members: [
      { name: 'effect', synced: true, path: '/Users/dev/.megarepo/github.com/effect-ts/effect/main' },
      { name: 'effect-utils', synced: true, path: '/Users/dev/.megarepo/github.com/overeng/effect-utils/main' },
    ],
  },
}

export const SomeSkipped: MemberStatusStory = {
  args: {
    members: [
      { name: 'effect', synced: true, path: '/Users/dev/.megarepo/github.com/effect-ts/effect/main' },
      { name: 'effect-utils', synced: false },
      { name: 'livestore', synced: true, path: '/Users/dev/.megarepo/github.com/livestore/livestore/main' },
    ],
  },
}
