/**
 * GenerateOutput View
 */

import type { Atom } from '@effect-atom/atom'
import React from 'react'

import { Box, Text, useTuiAtomValue } from '@overeng/tui-react'

import type { GenerateState, GenerateResultItem } from './schema.ts'

const symbols = {
  check: '\u2713',
  cross: '\u2717',
}

export interface GenerateViewProps {
  stateAtom: Atom.Atom<GenerateState>
}

/**
 * Renders a single result item.
 */
const ResultItem = ({ item }: { item: GenerateResultItem }) => (
  <Box flexDirection="row">
    <Text color="green">{symbols.check}</Text>
    <Text> Generated </Text>
    <Text bold>{item.status}</Text>
  </Box>
)

/**
 * GenerateView - View for generate command.
 */
export const GenerateView = ({ stateAtom }: GenerateViewProps) => {
  const state = useTuiAtomValue(stateAtom)

  switch (state._tag) {
    case 'Idle':
      return null
    case 'Running':
      return (
        <Box flexDirection="row">
          <Text dim>Generating {state.generator}...</Text>
          {state.progress !== undefined && <Text dim> {state.progress}</Text>}
        </Box>
      )
    case 'Error':
      return (
        <Box flexDirection="row">
          <Text color="red">{symbols.cross}</Text>
          <Text> {state.message}</Text>
        </Box>
      )
    case 'Success': {
      const resultCount = state.results.length
      return (
        <Box flexDirection="column">
          {state.results.map((item) => (
            <ResultItem key={`${item.generator}-${item.status}`} item={item} />
          ))}
          {resultCount > 0 && (
            <>
              <Text />
              <Text dim>Generated {resultCount} file(s)</Text>
            </>
          )}
        </Box>
      )
    }
  }
}
