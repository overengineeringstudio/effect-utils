/**
 * PushRefsOutput View
 *
 * Renders results of propagating member refs from parent to nested megarepo configs.
 */

import type { Atom } from '@effect-atom/atom'
import React from 'react'

import { Box, Text, useTuiAtomValue, useSymbols } from '@overeng/tui-react'

import { StatusIcon, Separator } from '../../components/mod.ts'
import type { PushRefsState } from './schema.ts'

/** Props for the push-refs TUI view component */
export interface PushRefsViewProps {
  stateAtom: Atom.Atom<PushRefsState>
}

/** Renders the push-refs command output based on current state */
export const PushRefsView = ({ stateAtom }: PushRefsViewProps) => {
  const state = useTuiAtomValue(stateAtom)
  const symbols = useSymbols()

  switch (state._tag) {
    case 'Idle':
      return null

    case 'Scanning':
      return <Text dim>Scanning nested megarepos...</Text>

    case 'Aligned':
      return (
        <Box flexDirection="row">
          <StatusIcon status="success" />
          <Text> All nested megarepo refs are already aligned</Text>
        </Box>
      )

    case 'Result': {
      const prefix = state.dryRun === true ? '[dry-run] ' : ''
      const verb = state.dryRun === true ? 'would update' : 'updated'

      return (
        <Box flexDirection="column">
          {state.results.map((nested) => (
            <Box key={nested.name} flexDirection="column">
              {nested.updates.map((update) => (
                <Box key={`${nested.name}/${update.sharedMemberName}`} flexDirection="row">
                  <Text dim>{prefix}</Text>
                  <Text bold>{nested.name}</Text>
                  <Text>/</Text>
                  <Text>{update.sharedMemberName}</Text>
                  <Text dim> {update.oldSource}</Text>
                  <Text dim> {symbols.arrows.right} </Text>
                  <Text>{update.newSource}</Text>
                </Box>
              ))}
              {nested.hasGenie && (
                <Box flexDirection="row" paddingLeft={2}>
                  <StatusIcon status="skipped" />
                  <Text color="yellow">
                    {' '}
                    {nested.name} has a megarepo.json.genie.ts — update the genie source too
                  </Text>
                </Box>
              )}
            </Box>
          ))}

          <Separator />
          <Box flexDirection="row">
            <StatusIcon status="success" />
            <Text>
              {' '}
              {prefix}
              {verb} {state.totalUpdates} ref{state.totalUpdates !== 1 ? 's' : ''} across{' '}
              {state.results.length} nested megarepo{state.results.length !== 1 ? 's' : ''}
            </Text>
          </Box>
        </Box>
      )
    }

    case 'Error':
      return (
        <Box flexDirection="row">
          <StatusIcon status="error" />
          <Text> {state.message}</Text>
        </Box>
      )
  }
}
