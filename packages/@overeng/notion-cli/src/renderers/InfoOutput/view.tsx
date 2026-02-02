import { type Atom } from '@effect-atom/atom'
import React from 'react'

import { Box, Text, useTuiAtomValue, useSymbols } from '@overeng/tui-react'

import { DatabaseHeader } from '../shared/DatabaseHeader.tsx'
import { PropertyList } from '../shared/PropertyList.tsx'
import type { InfoState } from './schema.ts'

export interface InfoViewProps {
  stateAtom: Atom.Atom<InfoState>
}

export const InfoView = ({ stateAtom }: InfoViewProps) => {
  const state = useTuiAtomValue(stateAtom)
  const symbols = useSymbols()

  if (state._tag === 'Loading') {
    return <Text dim>Loading...</Text>
  }

  if (state._tag === 'Error') {
    return (
      <Box flexDirection="row">
        <Text color="red">{symbols.status.cross}</Text>
        <Text> {state.message}</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <DatabaseHeader name={state.dbName} id={state.dbId} url={state.dbUrl} />
      <Text> </Text>
      <PropertyList properties={state.properties} />
      <Text> </Text>
      <Box flexDirection="row">
        <Text bold>Rows: </Text>
        <Text>{state.rowCount}</Text>
      </Box>
    </Box>
  )
}
