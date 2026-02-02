import { type Atom } from '@effect-atom/atom'
import React from 'react'

import { Box, Text, useTuiAtomValue, useSymbols } from '@overeng/tui-react'

import type { DiffState } from './schema.ts'

export interface DiffViewProps {
  stateAtom: Atom.Atom<DiffState>
}

export const DiffView = ({ stateAtom }: DiffViewProps) => {
  const state = useTuiAtomValue(stateAtom)
  const symbols = useSymbols()

  if (state._tag === 'Loading') {
    return <Text dim>Loading...</Text>
  }

  if (state._tag === 'Error') {
    return (
      <Box flexDirection="row">
        <Text color="red">{symbols.status.cross}</Text>
        <Text color="red"> Error: {state.message}</Text>
      </Box>
    )
  }

  if (state._tag === 'NoDifferences') {
    return (
      <Box flexDirection="column">
        <Text bold>Schema Diff: {state.databaseId}</Text>
        <Text dim>File: {state.filePath}</Text>
        <Text> </Text>
        <Text color="green">{symbols.status.check} Schema is in sync</Text>
      </Box>
    )
  }

  const diffCount = state.properties.length + state.options.length

  return (
    <Box flexDirection="column">
      <Text bold>Schema Diff: {state.databaseId}</Text>
      <Text dim>File: {state.filePath}</Text>
      <Text> </Text>

      {state.properties.length > 0 && (
        <Box flexDirection="column">
          <Text bold>Properties:</Text>
          {state.properties.map((prop) => {
            if (prop.type === 'added') {
              return (
                <Text key={prop.name} color="green">
                  {'  '}+ {prop.name} ({prop.liveType} → {prop.liveTransform})
                </Text>
              )
            }
            if (prop.type === 'removed') {
              return (
                <Text key={prop.name} color="red">
                  {'  '}- {prop.name} ({prop.generatedTransformKey})
                </Text>
              )
            }
            return (
              <Text key={prop.name} color="yellow">
                {'  '}~ {prop.name}: {prop.generatedTransformKey} → {prop.liveTransform}
              </Text>
            )
          })}
        </Box>
      )}

      {state.options.length > 0 && (
        <Box flexDirection="column">
          <Text> </Text>
          <Text bold>Options:</Text>
          {state.options.map((opt) => (
            <Box key={opt.name} flexDirection="column">
              <Text bold>
                {'  '}
                {opt.name}:
              </Text>
              {opt.added.map((o) => (
                <Text key={`add-${o}`} color="green">
                  {'    '}+ {o}
                </Text>
              ))}
              {opt.removed.map((o) => (
                <Text key={`rm-${o}`} color="red">
                  {'    '}- {o}
                </Text>
              ))}
            </Box>
          ))}
        </Box>
      )}

      <Text> </Text>
      {state.hasDifferences ? (
        <Text color="yellow">
          {symbols.status.warning} {diffCount} difference(s) found
        </Text>
      ) : (
        <Text color="green">{symbols.status.check} No differences found</Text>
      )}
    </Box>
  )
}
