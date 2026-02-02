import { type Atom } from '@effect-atom/atom'
import React from 'react'

import { Box, Text, useTuiAtomValue, useSymbols } from '@overeng/tui-react'

import type { GenerateState } from './schema.ts'

/** Props for {@link GenerateView}. */
export interface GenerateViewProps {
  stateAtom: Atom.Atom<GenerateState>
}

/** Renders single-database generation progress through introspect → generate → write stages. */
export const GenerateView = ({ stateAtom }: GenerateViewProps) => {
  const state = useTuiAtomValue(stateAtom)
  const symbols = useSymbols()

  if (state._tag === 'Introspecting') {
    return <Text>Introspecting database {state.databaseId}...</Text>
  }

  if (state._tag === 'Generating') {
    return (
      <Box flexDirection="column">
        <Text color="green">{symbols.status.check} Introspected</Text>
        <Text>Generating schema &quot;{state.schemaName}&quot;...</Text>
      </Box>
    )
  }

  if (state._tag === 'Writing') {
    return (
      <Box flexDirection="column">
        <Text color="green">{symbols.status.check} Introspected</Text>
        <Text color="green">{symbols.status.check} Generated</Text>
        <Text>Writing to {state.outputPath}...</Text>
      </Box>
    )
  }

  if (state._tag === 'DryRun') {
    return (
      <Box flexDirection="column">
        <Text bold>--- Generated Schema Code (dry-run) ---</Text>
        <Text> </Text>
        <Text>{state.code}</Text>
        <Text> </Text>
        <Text bold>--- End Generated Schema Code ---</Text>
        <Text> </Text>
        <Text dim>Would write to: {state.outputPath}</Text>
        {state.apiCode !== undefined && (
          <>
            <Text> </Text>
            <Text bold>--- Generated API Code (dry-run) ---</Text>
            <Text> </Text>
            <Text>{state.apiCode}</Text>
            <Text> </Text>
            <Text bold>--- End Generated API Code ---</Text>
            <Text> </Text>
            <Text dim>Would write to: {state.apiOutputPath}</Text>
          </>
        )}
      </Box>
    )
  }

  if (state._tag === 'Done') {
    return (
      <Box flexDirection="column">
        <Text color="green">{symbols.status.check} Introspected</Text>
        <Text color="green">{symbols.status.check} Generated</Text>
        <Text color="green">{symbols.status.check} Done</Text>
        <Text dim>
          Written to {state.outputPath}
          {state.writable ? '' : ' (read-only)'}
        </Text>
        {state.apiOutputPath !== undefined && (
          <Text dim>
            Written to {state.apiOutputPath}
            {state.writable ? '' : ' (read-only)'}
          </Text>
        )}
      </Box>
    )
  }

  // Error
  return (
    <Box flexDirection="row">
      <Text color="red">{symbols.status.cross}</Text>
      <Text> Error: {state.message}</Text>
    </Box>
  )
}
