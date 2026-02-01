/**
 * InitOutput View
 */

import path from 'node:path'

import type { Atom } from '@effect-atom/atom'
import React from 'react'

import { Box, Text, useTuiAtomValue } from '@overeng/tui-react'

import type { InitState } from './schema.ts'

const symbols = {
  check: '\u2713',
  cross: '\u2717',
}

export interface InitViewProps {
  stateAtom: Atom.Atom<InitState>
}

/**
 * InitView - View for init command.
 */
export const InitView = ({ stateAtom }: InitViewProps) => {
  const state = useTuiAtomValue(stateAtom)

  switch (state._tag) {
    case 'Error':
      return (
        <Box flexDirection="row">
          <Text color="red">{symbols.cross}</Text>
          <Text> {state.message}</Text>
        </Box>
      )
    case 'AlreadyInitialized':
      return <Text dim>megarepo already initialized</Text>
    case 'Success': {
      const dirName = path.basename(path.dirname(state.path))
      return (
        <Box flexDirection="row">
          <Text color="green">{symbols.check}</Text>
          <Text dim> initialized megarepo at </Text>
          <Text bold>{dirName}</Text>
        </Box>
      )
    }
  }
}
