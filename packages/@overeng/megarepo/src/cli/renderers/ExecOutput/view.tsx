/**
 * ExecOutput View
 *
 * React component for rendering exec output.
 * Handles running, complete, and error states.
 */

import type { Atom } from '@effect-atom/atom'
import React from 'react'

import { Box, Text, useTuiAtomValue, useSymbols } from '@overeng/tui-react'

import type { ExecState, MemberExecStatus } from './schema.ts'

// =============================================================================
// Main Component
// =============================================================================

export interface ExecViewProps {
  stateAtom: Atom.Atom<ExecState>
}

/**
 * ExecView - View for exec command.
 *
 * Renders:
 * - Running state: progress with spinners (not typical for batch, but supported)
 * - Complete state: results with stdout/stderr per member
 * - Error state: error message
 */
export const ExecView = ({ stateAtom }: ExecViewProps) => {
  const state = useTuiAtomValue(stateAtom)
  const symbols = useSymbols()

  // Handle error state
  if (state._tag === 'Error') {
    return (
      <Box flexDirection="row">
        <Text color="red">{symbols.status.cross}</Text>
        <Text> {state.message}</Text>
      </Box>
    )
  }

  // Handle running state - show verbose header if enabled
  if (state._tag === 'Running') {
    if (state.verbose) {
      return (
        <Box flexDirection="column">
          <Text dim>Command: {state.command}</Text>
          <Text dim>Mode: {state.mode}</Text>
          <Text dim>Members: {state.members.map((m) => m.name).join(', ')}</Text>
        </Box>
      )
    }
    // In non-verbose running, show nothing (output comes after completion)
    return null
  }

  // Handle complete state
  const { members, verbose } = state

  return (
    <Box flexDirection="column">
      {/* Verbose header if enabled */}
      {verbose && (
        <>
          <Text dim>Command: {state.command}</Text>
          <Text dim>Mode: {state.mode}</Text>
          <Text dim>Members: {members.map((m) => m.name).join(', ')}</Text>
          <Text> </Text>
        </>
      )}

      {/* Results for each member */}
      {members.map((member) => (
        <MemberResult key={member.name} member={member} />
      ))}
    </Box>
  )
}

// =============================================================================
// Internal Components
// =============================================================================

function MemberResult({ member }: { member: MemberExecStatus }) {
  const hasOutput = member.stdout || member.stderr

  return (
    <Box flexDirection="column">
      {/* Member header */}
      <Text bold>
        {'\n'}
        {member.name}:
      </Text>

      {/* Show skipped message */}
      {member.status === 'skipped' && <Text dim>skipped (not synced)</Text>}

      {/* Show stdout */}
      {member.stdout && <Text>{member.stdout}</Text>}

      {/* Show stderr in red */}
      {member.stderr && <Text color="red">{member.stderr}</Text>}

      {/* Show nothing message for success without output */}
      {member.status === 'success' && !hasOutput && <Text dim>(no output)</Text>}
    </Box>
  )
}
