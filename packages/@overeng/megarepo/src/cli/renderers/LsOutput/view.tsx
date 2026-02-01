/**
 * LsOutput View
 *
 * React component for rendering ls output.
 * Handles both success (member list) and error states.
 */

import type { Atom } from '@effect-atom/atom'
import React from 'react'

import { Box, Text, useTuiAtomValue, useSymbols } from '@overeng/tui-react'

import type { LsState } from './schema.ts'

// =============================================================================
// Main Component
// =============================================================================

export interface LsViewProps {
  stateAtom: Atom.Atom<LsState>
}

/**
 * LsView - View for ls command.
 *
 * Renders either:
 * - A list of members with their sources (success)
 * - An error message (error)
 */
export const LsView = ({ stateAtom }: LsViewProps) => {
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

  // Handle success state
  const { members } = state

  if (members.length === 0) {
    return <Text dim>No members in megarepo</Text>
  }

  return (
    <Box flexDirection="column">
      {members.map((member) => (
        <Box key={member.name} flexDirection="row">
          <Text bold>{member.name}</Text>
          <Text dim> ({member.source})</Text>
        </Box>
      ))}
    </Box>
  )
}
