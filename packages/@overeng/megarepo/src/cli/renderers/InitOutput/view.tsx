/**
 * InitOutput View
 */

import path from 'node:path'

import type { Atom } from '@effect-atom/atom'
import React from 'react'

import { Box, Text, useTuiAtomValue, useSymbols } from '@overeng/tui-react'

import type { InitState } from './schema.ts'

export interface InitViewProps {
  stateAtom: Atom.Atom<InitState>
}

/**
 * InitView - View for init command.
 */
export const InitView = ({ stateAtom }: InitViewProps) => {
  const state = useTuiAtomValue(stateAtom)
  const symbols = useSymbols()

  switch (state._tag) {
    case 'Error':
      return (
        <Box flexDirection="row">
          <Text color="red">{symbols.status.cross}</Text>
          <Text> {state.message}</Text>
        </Box>
      )
    case 'AlreadyInitialized':
      return <Text dim>megarepo already initialized</Text>
    case 'Success': {
      const dirName = path.basename(path.dirname(state.path))
      return (
        <Box flexDirection="row">
          <Text color="green">{symbols.status.check}</Text>
          <Text dim> initialized megarepo at </Text>
          <Text bold>{dirName}</Text>
        </Box>
      )
    }
  }
}
