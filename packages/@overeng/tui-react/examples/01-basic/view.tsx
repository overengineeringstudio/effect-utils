import { Atom } from '@effect-atom/atom'
import React, { useMemo } from 'react'

import { Box, Text, useTuiAtomValue } from '../../src/mod.ts'
import type { AppState } from './schema.ts'

/** Renders the hello world example with countdown, colors, and completion states. */
export const HelloWorldView = ({ stateAtom }: { stateAtom: Atom.Atom<AppState> }) => {
  const tagAtom = useMemo(() => Atom.map(stateAtom, (s) => s._tag), [stateAtom])
  const tag = useTuiAtomValue(tagAtom)

  switch (tag) {
    case 'Displaying':
      return <DisplayingView stateAtom={stateAtom} />
    case 'Finished':
      return <FinishedView stateAtom={stateAtom} />
    case 'Interrupted':
      return <InterruptedView />
  }
}

// =============================================================================
// Internal Components
// =============================================================================

const DisplayingView = ({ stateAtom }: { stateAtom: Atom.Atom<AppState> }) => {
  const state = useTuiAtomValue(stateAtom)
  if (state._tag !== 'Displaying') return null

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">
        Hello from tui-react!
      </Text>
      <Text dim>A React renderer for terminal UIs</Text>
      <Box marginTop={1}>
        <Text>Colors: </Text>
        <Text color="red">red </Text>
        <Text color="green">green </Text>
        <Text color="blue">blue </Text>
        <Text color="yellow">yellow</Text>
      </Box>
      <Box marginTop={1}>
        <Text dim>Exiting in {state.secondsRemaining}s... (Ctrl+C to exit now)</Text>
      </Box>
    </Box>
  )
}

const FinishedView = ({ stateAtom }: { stateAtom: Atom.Atom<AppState> }) => {
  const state = useTuiAtomValue(stateAtom)
  if (state._tag !== 'Finished') return null

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="green">
        Hello World - Complete
      </Text>
      <Text>{state.message}</Text>
    </Box>
  )
}

const InterruptedView = () => {
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="yellow">
        Hello World - Interrupted
      </Text>
      <Text dim>Goodbye! Come back soon.</Text>
    </Box>
  )
}
