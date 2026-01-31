/**
 * Storybook stories for ExecOutput components.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { Box } from '@overeng/tui-react'
import { TerminalPreview } from '@overeng/tui-react/storybook'

import {
  ExecErrorOutput,
  ExecVerboseHeader,
  ExecMemberSkipped,
  ExecMemberPath,
  ExecResultsOutput,
  type ExecErrorOutputProps,
  type ExecMemberResult,
} from './ExecOutput.tsx'

// =============================================================================
// Example Data
// =============================================================================

const exampleExecResults: ExecMemberResult[] = [
  { name: 'effect', exitCode: 0, stdout: 'v3.0.0', stderr: '' },
  { name: 'effect-utils', exitCode: 0, stdout: 'v1.2.3', stderr: '' },
  { name: 'livestore', exitCode: 1, stdout: '', stderr: 'Command failed: npm version' },
]

const exampleExecResultsWithOutput: ExecMemberResult[] = [
  {
    name: 'effect',
    exitCode: 0,
    stdout:
      'added 125 packages in 2.3s\n15 packages are looking for funding\n  run `npm fund` for details',
    stderr: '',
  },
  { name: 'effect-utils', exitCode: 0, stdout: 'added 45 packages in 1.1s', stderr: '' },
]

// =============================================================================
// Meta
// =============================================================================

const meta: Meta<ExecErrorOutputProps> = {
  title: 'CLI/Exec',
  component: ExecErrorOutput,
  args: {
    type: 'not_in_megarepo',
  },
  argTypes: {
    type: {
      description: 'Type of error',
      control: { type: 'select' },
      options: ['not_in_megarepo', 'member_not_found'],
      table: { category: 'Error' },
    },
  },
  decorators: [
    (Story) => (
      <TerminalPreview height={300}>
        <Story />
      </TerminalPreview>
    ),
  ],
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component: 'Error outputs for the `mr exec` command.',
      },
    },
  },
}

export default meta

type Story = StoryObj<typeof meta>

// =============================================================================
// Error Output Stories
// =============================================================================

export const NotInMegarepo: Story = {
  args: { type: 'not_in_megarepo' },
}

export const MemberNotFound: Story = {
  args: { type: 'member_not_found' },
}

// =============================================================================
// Verbose Header Stories
// =============================================================================

export const VerboseParallel: Story = {
  render: () => (
    <TerminalPreview height={200}>
      <ExecVerboseHeader
        command="npm version"
        mode="parallel"
        members={['effect', 'effect-utils', 'livestore']}
      />
    </TerminalPreview>
  ),
}

export const VerboseSequential: Story = {
  render: () => (
    <TerminalPreview height={200}>
      <ExecVerboseHeader command="git status" mode="sequential" members={['effect', 'effect-utils']} />
    </TerminalPreview>
  ),
}

export const VerboseSingleMember: Story = {
  render: () => (
    <TerminalPreview height={200}>
      <ExecVerboseHeader command="pnpm install" mode="parallel" members={['effect']} />
    </TerminalPreview>
  ),
}

// =============================================================================
// Results Output Stories
// =============================================================================

export const MixedResults: Story = {
  render: () => (
    <TerminalPreview height={300}>
      <ExecResultsOutput results={exampleExecResults} />
    </TerminalPreview>
  ),
}

export const WithMultilineOutput: Story = {
  render: () => (
    <TerminalPreview height={300}>
      <ExecResultsOutput results={exampleExecResultsWithOutput} />
    </TerminalPreview>
  ),
}

export const AllSuccess: Story = {
  render: () => (
    <TerminalPreview height={300}>
      <ExecResultsOutput
        results={[
          { name: 'effect', exitCode: 0, stdout: 'ok', stderr: '' },
          { name: 'effect-utils', exitCode: 0, stdout: 'ok', stderr: '' },
          { name: 'livestore', exitCode: 0, stdout: 'ok', stderr: '' },
        ]}
      />
    </TerminalPreview>
  ),
}

export const AllErrors: Story = {
  render: () => (
    <TerminalPreview height={300}>
      <ExecResultsOutput
        results={[
          { name: 'effect', exitCode: 1, stdout: '', stderr: 'Command not found: foo' },
          { name: 'effect-utils', exitCode: 1, stdout: '', stderr: 'Permission denied' },
          { name: 'livestore', exitCode: 127, stdout: '', stderr: 'sh: command not found' },
        ]}
      />
    </TerminalPreview>
  ),
}

// =============================================================================
// Verbose Member Status Stories (Composite)
// =============================================================================

type MemberStatusItem = { name: string; synced: boolean; path?: string | undefined }

const VerboseMemberStatus = ({ members }: { members: MemberStatusItem[] }) => (
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

export const AllSynced: Story = {
  render: () => (
    <TerminalPreview height={200}>
      <VerboseMemberStatus
        members={[
          {
            name: 'effect',
            synced: true,
            path: '/Users/dev/.megarepo/github.com/effect-ts/effect/main',
          },
          {
            name: 'effect-utils',
            synced: true,
            path: '/Users/dev/.megarepo/github.com/overeng/effect-utils/main',
          },
        ]}
      />
    </TerminalPreview>
  ),
}

export const SomeSkipped: Story = {
  render: () => (
    <TerminalPreview height={200}>
      <VerboseMemberStatus
        members={[
          {
            name: 'effect',
            synced: true,
            path: '/Users/dev/.megarepo/github.com/effect-ts/effect/main',
          },
          { name: 'effect-utils', synced: false },
          {
            name: 'livestore',
            synced: true,
            path: '/Users/dev/.megarepo/github.com/livestore/livestore/main',
          },
        ]}
      />
    </TerminalPreview>
  ),
}
