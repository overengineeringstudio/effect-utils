/**
 * RootOutput View
 */

import type { Atom } from '@effect-atom/atom'
import React from 'react'

import { Box, Text, useTuiAtomValue } from '@overeng/tui-react'

import type { RootState } from './schema.ts'

const symbols = {
  cross: '\u2717',
}

export interface RootViewProps {
  stateAtom: Atom.Atom<RootState>
}

/**
 * RootView - View for root command.
 */
export const RootView = ({ stateAtom }: RootViewProps) => {
  const state = useTuiAtomValue(stateAtom)

  // Handle error state
  if (state._tag === 'Error') {
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
