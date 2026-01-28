/**
 * Storybook stories for ExecOutput components.
 */

import type { StoryObj } from '@storybook/react'
import React from 'react'
import { Box } from '@overeng/tui-react'
import { createCliMeta } from '@overeng/tui-react/storybook'
import { forceColorLevel } from '@overeng/cli-ui'
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

forceColorLevel('truecolor')

// =============================================================================
// Example Data
// =============================================================================

const exampleExecResults: ExecMemberResult[] = [
  { name: 'effect', exitCode: 0, stdout: 'v3.0.0', stderr: '' },
  { name: 'effect-utils', exitCode: 0, stdout: 'v1.2.3', stderr: '' },
  { name: 'livestore', exitCode: 1, stdout: '', stderr: 'Command failed: npm version' },
]

const exampleExecResultsWithOutput: ExecMemberResult[] = [
  { name: 'effect', exitCode: 0, stdout: 'added 125 packages in 2.3s\n15 packages are looking for funding\n  run `npm fund` for details', stderr: '' },
  { name: 'effect-utils', exitCode: 0, stdout: 'added 45 packages in 1.1s', stderr: '' },
]

// =============================================================================
// Error Output Stories
// =============================================================================

const errorMeta = createCliMeta<ExecErrorOutputProps>(ExecErrorOutput, {
  title: 'CLI/Exec/Error',
  description: 'Error outputs for the `mr exec` command.',
  defaultArgs: {
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
})

export default errorMeta

type ExecErrorStory = StoryObj<typeof errorMeta>

export const NotInMegarepo: ExecErrorStory = {
  args: { type: 'not_in_megarepo' },
}

export const MemberNotFound: ExecErrorStory = {
  args: { type: 'member_not_found' },
}

// =============================================================================
// Verbose Header Stories
// =============================================================================

export const verboseMeta = createCliMeta<ExecVerboseHeaderProps>(ExecVerboseHeader, {
  title: 'CLI/Exec/Verbose Header',
  description: 'Verbose header output for the `mr exec` command when using `--verbose`.',
  defaultArgs: {
    command: 'npm version',
    mode: 'parallel',
    members: ['effect', 'effect-utils', 'livestore'],
  },
  argTypes: {
    mode: {
      description: 'Execution mode',
      control: { type: 'select' },
      options: ['parallel', 'sequential'],
      table: { category: 'Options' },
    },
  },
})

type ExecVerboseStory = StoryObj<typeof verboseMeta>

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

export const resultsMeta = createCliMeta<ExecResultsOutputProps>(ExecResultsOutput, {
  title: 'CLI/Exec/Results',
  description: 'Results output for the `mr exec` command showing command output per member.',
  defaultArgs: {
    results: [],
  },
})

type ExecResultsStory = StoryObj<typeof resultsMeta>

export const MixedResults: ExecResultsStory = {
  args: { results: exampleExecResults },
}

export const WithMultilineOutput: ExecResultsStory = {
  args: { results: exampleExecResultsWithOutput },
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

export const memberStatusMeta = createCliMeta<{ members: MemberStatusItem[] }>(VerboseMemberStatus, {
  title: 'CLI/Exec/Member Status',
  description: 'Verbose member status lines showing synced/skipped status for each member.',
  defaultArgs: {
    members: [],
  },
})

type MemberStatusStory = StoryObj<typeof memberStatusMeta>

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
