import React from 'react'

import { type Atom, Box, Text, useTuiAtomValue, useSymbols } from '@overeng/tui-react'

import type { GenerateConfigState } from './schema.ts'

export interface GenerateConfigViewProps {
  stateAtom: Atom.Atom<GenerateConfigState>
}

export const GenerateConfigView = ({ stateAtom }: GenerateConfigViewProps) => {
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

  if (state._tag === 'Done') {
    return (
      <Box flexDirection="column">
        <Text dim>Config: {state.configPath}</Text>
        <Box flexDirection="row">
          <Text color="green">
            {symbols.status.check} Generated {state.count} schema(s)
          </Text>
        </Box>
      </Box>
    )
  }

  // Running state
  return (
    <Box flexDirection="column">
      <Text dim>Config: {state.configPath}</Text>
      {state.databases.map((db) => {
        switch (db.status) {
          case 'pending':
            return (
              <Box key={db.id} flexDirection="row">
                <Text dim>
                  {symbols.status.circle} {db.name}
                </Text>
              </Box>
            )
          case 'introspecting':
          case 'generating':
          case 'writing':
            return (
              <Box key={db.id} flexDirection="row">
                <Text color="cyan">
                  {symbols.status.dot} {db.name} ({db.status})
                </Text>
              </Box>
            )
          case 'done':
            return (
              <Box key={db.id} flexDirection="row">
                <Text color="green">
                  {symbols.status.check} {db.name}
                </Text>
              </Box>
            )
          default:
            return (
              <Box key={db.id} flexDirection="row">
                <Text color="red">
                  {symbols.status.cross} {db.name}
                </Text>
              </Box>
            )
        }
      })}
    </Box>
  )
}
