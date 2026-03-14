/**
 * DepsOutput View
 *
 * React component for rendering the dependency graph between megarepo members.
 * Shows upstream members with their downstream dependents indented below.
 */

import type { Atom } from '@effect-atom/atom'
import React from 'react'

import { Box, Text, useTuiAtomValue, useSymbols } from '@overeng/tui-react'

import type { DepsState } from './schema.ts'

/** Props for the deps dependency graph view component */
export interface DepsViewProps {
  stateAtom: Atom.Atom<DepsState>
}

/** Renders the dependency graph showing upstream members and their downstream dependents */
export const DepsView = ({ stateAtom }: DepsViewProps) => {
  const state = useTuiAtomValue(stateAtom)
  const symbols = useSymbols()

  if (state._tag === 'Error') {
    return (
      <Box flexDirection="row">
        <Text color="red">{symbols.status.cross}</Text>
        <Text> {state.message}</Text>
      </Box>
    )
  }

  if (state._tag === 'Empty') {
    return <Text dim>No inter-member dependencies found</Text>
  }

  const { members } = state

  return (
    <Box flexDirection="column">
      {members.map((upstream, upstreamIdx) => (
        <React.Fragment key={upstream.name}>
          <Text bold>{upstream.name}</Text>
          {upstream.downstreamMembers.map((downstream) => (
            <Box key={downstream.name} flexDirection="row">
              <Text dim> ← </Text>
              <Text>{downstream.name}</Text>
              <Text dim> [{downstream.files.join(', ')}]</Text>
            </Box>
          ))}
          {upstreamIdx < members.length - 1 && <Text> </Text>}
        </React.Fragment>
      ))}
    </Box>
  )
}
