/**
 * RootOutput View
 */

import React from 'react'

import { Box, Text } from '@overeng/tui-react'

import type { RootState } from './schema.ts'
import { isRootError } from './schema.ts'

const symbols = {
  cross: '\u2717',
}

export interface RootViewProps {
  state: RootState
}

/**
 * RootView - View for root command.
 */
export const RootView = ({ state }: RootViewProps) => {
  // Handle error state
  if (isRootError(state)) {
    return (
      <Box flexDirection="row">
        <Text color="red">{symbols.cross}</Text>
        <Text> {state.message}</Text>
      </Box>
    )
  }

  // TTY mode: just show the path (for easy piping/copy-paste)
  return <Text>{state.root}</Text>
}
