/**
 * Hello World - Pure View Components
 *
 * These components are pure and stateless, suitable for:
 * - Storybook stories
 * - Testing
 * - CLI usage via connected wrapper
 */

import React from 'react'

import { Box, Text } from '../../src/mod.ts'
import type { AppState } from './schema.ts'

// =============================================================================
// View Components
// =============================================================================

const DisplayingView = ({ state }: { state: Extract<AppState, { _tag: 'Displaying' }> }) => (
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

const FinishedView = ({ state }: { state: Extract<AppState, { _tag: 'Finished' }> }) => (
  <Box flexDirection="column" padding={1}>
    <Text bold color="green">
      Hello World - Complete
    </Text>
    <Text>{state.message}</Text>
  </Box>
)

const InterruptedView = () => (
  <Box flexDirection="column" padding={1}>
    <Text bold color="yellow">
      Hello World - Interrupted
    </Text>
    <Text dim>Goodbye! Come back soon.</Text>
  </Box>
)

// =============================================================================
// Main View (for Storybook)
// =============================================================================

export const HelloWorldView = ({ state }: { state: AppState }) => {
  switch (state._tag) {
    case 'Displaying':
      return <DisplayingView state={state} />
    case 'Finished':
      return <FinishedView state={state} />
    case 'Interrupted':
      return <InterruptedView />
  }
}
