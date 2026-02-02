import { type Atom } from '@effect-atom/atom'
import React from 'react'

import { Box, Text, useTuiAtomValue, useSymbols } from '@overeng/tui-react'

import { DatabaseHeader } from '../shared/DatabaseHeader.tsx'
import { PropertyList, type PropertyInfo } from '../shared/PropertyList.tsx'
import type { IntrospectState } from './schema.ts'

/** Props for {@link IntrospectView}. */
export interface IntrospectViewProps {
  stateAtom: Atom.Atom<IntrospectState>
}

/** Renders introspection results showing database metadata and a detailed property list. */
export const IntrospectView = ({ stateAtom }: IntrospectViewProps) => {
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
      <PropertyList properties={state.properties as readonly PropertyInfo[]} detailed={true} />
    </Box>
  )
}
