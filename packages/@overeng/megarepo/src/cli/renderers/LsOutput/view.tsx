/**
 * LsOutput View
 *
 * React component for rendering ls output.
 * Handles both success (member list) and error states.
 */

import React from 'react'

import { Box, Text } from '@overeng/tui-react'

import type { LsState } from './schema.ts'
import { isLsError } from './schema.ts'

// =============================================================================
// Symbols
// =============================================================================

const symbols = {
  cross: '\u2717',
}

// =============================================================================
// Main Component
// =============================================================================

export interface LsViewProps {
  state: LsState
}

/**
 * LsView - View for ls command.
 *
 * Renders either:
 * - A list of members with their sources (success)
 * - An error message (error)
 */
export const LsView = ({ state }: LsViewProps) => {
  // Handle error state
  if (isLsError(state)) {
    return (
      <Box flexDirection="row">
        <Text color="red">{symbols.cross}</Text>
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
