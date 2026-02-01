/**
 * AddOutput View
 */

import type { Atom } from '@effect-atom/atom'
import React from 'react'

import { Box, Text, useTuiAtomValue } from '@overeng/tui-react'

import type { AddState } from './schema.ts'

const symbols = {
  check: '\u2713',
  cross: '\u2717',
}

export interface AddViewProps {
  stateAtom: Atom.Atom<AddState>
}

/**
 * AddView - View for add command.
 */
export const AddView = ({ stateAtom }: AddViewProps) => {
  const state = useTuiAtomValue(stateAtom)

  switch (state._tag) {
    case 'Idle':
      return null

    case 'Adding':
      return (
        <Box flexDirection="row">
          <Text dim>Adding </Text>
          <Text bold>{state.member}</Text>
          <Text dim>...</Text>
        </Box>
      )

    case 'Error':
      return (
        <Box>
          <Box flexDirection="row">
            <Text color="red">{symbols.cross}</Text>
            <Text> {state.message}</Text>
          </Box>
          {state.error === 'invalid_repo' && (
            <Text dim>
              {'  Expected: owner/repo, git@host:owner/repo.git, https://host/owner/repo.git, or /path/to/repo'}
            </Text>
          )}
        </Box>
      )

    case 'Success':
      return (
        <Box>
          <Box flexDirection="row">
            <Text color="green">{symbols.check}</Text>
            <Text> Added </Text>
            <Text bold>{state.member}</Text>
          </Box>

          {state.synced && state.syncStatus && (
            <>
              <Text dim>Syncing...</Text>
              <Box flexDirection="row">
                <Text color={state.syncStatus === 'error' ? 'red' : 'green'}>
                  {state.syncStatus === 'error' ? symbols.cross : symbols.check}
                </Text>
                <Text> </Text>
                <Text bold>{state.member}</Text>
                <Text dim>
                  {' '}
                  ({state.syncStatus === 'cloned' ? 'cloned' : state.syncStatus})
                </Text>
              </Box>
            </>
          )}
        </Box>
      )
  }
}
