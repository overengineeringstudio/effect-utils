import { type Atom } from '@effect-atom/atom'
import React from 'react'

import { Box, Text, useTuiAtomValue, useSymbols } from '@overeng/tui-react'

import type { DumpState } from './schema.ts'

/** Props for {@link DumpView}. */
export interface DumpViewProps {
  stateAtom: Atom.Atom<DumpState>
}

const formatBytes = (bytes: number): string => {
  if (bytes > 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }
  return `${(bytes / 1024).toFixed(1)} KB`
}

/** Renders dump progress and completion summary including page count, asset stats, and failures. */
export const DumpView = ({ stateAtom }: DumpViewProps) => {
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

  if (state._tag === 'Introspecting') {
    return <Text dim>Introspecting database {state.databaseId}...</Text>
  }

  if (state._tag === 'Fetching') {
    return <Text>Fetching pages... ({state.pageCount} so far)</Text>
  }

  // Done state
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color="green">
          {symbols.status.check} Dumped {state.pageCount} pages to {state.outputPath}
        </Text>
      </Box>
      {state.assetsSkipped > 0 && (
        <Text dim>Info: {state.assetsSkipped} assets found but not downloaded (use --assets)</Text>
      )}
      {state.assetsDownloaded > 0 && (
        <Text>
          Downloaded {state.assetsDownloaded} assets ({formatBytes(state.assetBytes)})
        </Text>
      )}
      {state.failures > 0 && <Text color="yellow">Warning: {state.failures} failure(s)</Text>}
    </Box>
  )
}
