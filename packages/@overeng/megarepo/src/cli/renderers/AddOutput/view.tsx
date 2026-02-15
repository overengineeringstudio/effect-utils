/**
 * AddOutput View
 */

import type { Atom } from '@effect-atom/atom'
import React from 'react'

import { Box, Text, useTuiAtomValue, useSymbols } from '@overeng/tui-react'

import { StatusIcon } from '../../components/mod.ts'
import type { AddState } from './schema.ts'

/** Props for the AddView component that renders add command progress and results. */
export interface AddViewProps {
  stateAtom: Atom.Atom<AddState>
}

/**
 * AddView - View for add command.
 */
export const AddView = ({ stateAtom }: AddViewProps) => {
  const state = useTuiAtomValue(stateAtom)
  const symbols = useSymbols()

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
            <Text color="red">{symbols.status.cross}</Text>
            <Text> {state.message}</Text>
          </Box>
          {state.error === 'invalid_repo' && (
            <Text dim>
              {
                '  Expected: owner/repo, git@host:owner/repo.git, https://host/owner/repo.git, or /path/to/repo'
              }
            </Text>
          )}
        </Box>
      )

    case 'Success':
      return (
        <Box>
          <Box flexDirection="row">
            <Text color="green">{symbols.status.check}</Text>
            <Text> Added </Text>
            <Text bold>{state.member}</Text>
            {!state.synced && <Text dim> (sync skipped)</Text>}
          </Box>

          {state.synced !== undefined && state.syncStatus !== undefined && (
            <Box flexDirection="row">
              <StatusIcon
                status={
                  state.syncStatus === 'cloned'
                    ? 'cloned'
                    : state.syncStatus === 'synced'
                      ? 'synced'
                      : 'error'
                }
                variant="sync"
              />
              <Text> </Text>
              <Text bold>{state.member}</Text>
              <Text> </Text>
              <Text color={state.syncStatus === 'error' ? 'red' : 'green'}>{state.syncStatus}</Text>
            </Box>
          )}
        </Box>
      )
  }
}
