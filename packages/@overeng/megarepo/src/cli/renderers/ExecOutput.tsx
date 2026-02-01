/**
 * React components for rendering exec command outputs.
 *
 * These components provide consistent rendering for the exec command.
 */

import React from 'react'

import { Box, Text } from '@overeng/tui-react'

// =============================================================================
// Types
// =============================================================================

/** Result of executing a command in a member */
export type ExecMemberResult = {
  name: string
  exitCode: number
  stdout: string
  stderr: string
}

export type ExecErrorType = 'not_in_megarepo' | 'member_not_found'

export type ExecErrorOutputProps = {
  type: ExecErrorType
}

export type ExecVerboseHeaderProps = {
  command: string
  mode: 'parallel' | 'sequential'
  members: readonly string[]
}

export type ExecMemberSkippedProps = {
  name: string
  reason?: string | undefined
}

export type ExecMemberPathProps = {
  name: string
  path: string
}

export type ExecMemberHeaderProps = {
  name: string
}

export type ExecStderrProps = {
  stderr: string
}

export type ExecResultsOutputProps = {
  results: readonly ExecMemberResult[]
}

// =============================================================================
// Components
// =============================================================================

export const ExecErrorOutput = ({ type }: ExecErrorOutputProps) => {
  const errorMessages: Record<ExecErrorType, string> = {
    not_in_megarepo: 'Not in a megarepo',
    member_not_found: 'Member not found',
  }

  return (
    <Box flexDirection="row">
      <Text color="red">{'\u2717'}</Text>
      <Text> {errorMessages[type]}</Text>
    </Box>
  )
}

export const ExecVerboseHeader = ({ command, mode, members }: ExecVerboseHeaderProps) => (
  <Box flexDirection="column">
    <Text dim>Command: {command}</Text>
    <Text dim>Mode: {mode}</Text>
    <Text dim>Members: {members.join(', ')}</Text>
  </Box>
)

export const ExecMemberSkipped = ({ name, reason = 'not synced' }: ExecMemberSkippedProps) => (
  <Text dim>
    {' '}
    {name}: skipped ({reason})
  </Text>
)

export const ExecMemberPath = ({ name, path }: ExecMemberPathProps) => (
  <Text dim>
    {' '}
    {name}: {path}
  </Text>
)

export const ExecMemberHeader = ({ name }: ExecMemberHeaderProps) => (
  <Text bold>
    {'\n'}
    {name}:
  </Text>
)

export const ExecStderr = ({ stderr }: ExecStderrProps) => <Text color="red">{stderr}</Text>

/**
 * Renders all exec results (for parallel mode output).
 * In sequential mode, results are printed one at a time as they complete.
 */
export const ExecResultsOutput = ({ results }: ExecResultsOutputProps) => (
  <Box flexDirection="column">
    {results.map((result) => (
      <Box key={result.name} flexDirection="column">
        <ExecMemberHeader name={result.name} />
        {result.stdout && <Text>{result.stdout}</Text>}
        {result.stderr && <ExecStderr stderr={result.stderr} />}
      </Box>
    ))}
  </Box>
)
