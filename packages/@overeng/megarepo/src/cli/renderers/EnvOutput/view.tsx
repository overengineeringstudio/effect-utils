/**
 * EnvOutput View
 *
 * React component for rendering env output.
 * TTY mode outputs shell-specific export commands.
 */

import React from 'react'

import { Box, Text } from '@overeng/tui-react'

import type { EnvState } from './schema.ts'
import { isEnvError } from './schema.ts'

const symbols = {
  cross: '\u2717',
}

// =============================================================================
// Main Component
// =============================================================================

export interface EnvViewProps {
  state: EnvState
}

/**
 * EnvView - View for env command.
 *
 * In TTY mode, outputs shell-specific export commands.
 * JSON mode outputs the environment variables as a JSON object.
 */
export const EnvView = ({ state }: EnvViewProps) => {
  // Handle error state
  if (isEnvError(state)) {
    return (
      <Box flexDirection="row">
        <Text color="red">{symbols.cross}</Text>
        <Text> {state.message}</Text>
      </Box>
    )
  }

  const { MEGAREPO_ROOT_OUTERMOST, MEGAREPO_ROOT_NEAREST, MEGAREPO_MEMBERS, shell = 'bash' } = state

  // Format based on shell type
  if (shell === 'fish') {
    return (
      <Box flexDirection="column">
        <Text>set -gx MEGAREPO_ROOT_OUTERMOST "{MEGAREPO_ROOT_OUTERMOST}"</Text>
        <Text>set -gx MEGAREPO_ROOT_NEAREST "{MEGAREPO_ROOT_NEAREST}"</Text>
        <Text>set -gx MEGAREPO_MEMBERS "{MEGAREPO_MEMBERS}"</Text>
      </Box>
    )
  }

  // bash/zsh (default)
  return (
    <Box flexDirection="column">
      <Text>export MEGAREPO_ROOT_OUTERMOST="{MEGAREPO_ROOT_OUTERMOST}"</Text>
      <Text>export MEGAREPO_ROOT_NEAREST="{MEGAREPO_ROOT_NEAREST}"</Text>
      <Text>export MEGAREPO_MEMBERS="{MEGAREPO_MEMBERS}"</Text>
    </Box>
  )
}
