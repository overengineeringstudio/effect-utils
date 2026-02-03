/**
 * EnvOutput View
 *
 * React component for rendering env output.
 * TTY mode outputs shell-specific export commands.
 */

import type { Atom } from '@effect-atom/atom'
import React from 'react'

import { Box, Text, useTuiAtomValue, useSymbols } from '@overeng/tui-react'

import type { EnvState } from './schema.ts'

// =============================================================================
// Main Component
// =============================================================================

/** Props for the EnvView component that renders shell export commands for megarepo environment variables. */
export interface EnvViewProps {
  stateAtom: Atom.Atom<EnvState>
}

/**
 * EnvView - View for env command.
 *
 * In TTY mode, outputs shell-specific export commands.
 * JSON mode outputs the environment variables as a JSON object.
 */
export const EnvView = ({ stateAtom }: EnvViewProps) => {
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

  const { MEGAREPO_STORE, shell = 'bash' } = state

  // Format based on shell type
  if (shell === 'fish') {
    return (
      <Box flexDirection="column">
        <Text>set -gx MEGAREPO_STORE "{MEGAREPO_STORE}"</Text>
      </Box>
    )
  }

  // bash/zsh (default)
  return (
    <Box flexDirection="column">
      <Text>export MEGAREPO_STORE="{MEGAREPO_STORE}"</Text>
    </Box>
  )
}
