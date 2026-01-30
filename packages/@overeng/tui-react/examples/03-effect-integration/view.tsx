/**
 * Counter Example - Pure View Components
 */

import React from 'react'

import { Box, Text, Spinner } from '../../src/mod.ts'
import type { CounterState } from './schema.ts'

// =============================================================================
// View Components
// =============================================================================

const RunningView = ({ state }: { state: Extract<CounterState, { _tag: 'Running' }> }) => (
  <Box flexDirection="column" padding={1}>
    <Text bold color="cyan">
      Counter Example
    </Text>

    <Box marginTop={1} flexDirection="row">
      {state.status === 'loading' ? (
        <>
          <Spinner color="yellow" />
          <Text> Processing...</Text>
        </>
      ) : (
        <>
          <Text>Count: </Text>
          <Text color={state.count >= 0 ? 'green' : 'red'} bold>
            {state.count}
          </Text>
        </>
      )}
    </Box>

    {state.history.length > 0 && (
      <Box marginTop={1} flexDirection="column">
        <Text dim>History:</Text>
        {state.history.map((entry, i) => (
          <Text key={i} dim>
            {'  '}
            {entry}
          </Text>
        ))}
      </Box>
    )}
  </Box>
)

const CompleteView = ({ state }: { state: Extract<CounterState, { _tag: 'Complete' }> }) => (
  <Box flexDirection="column" padding={1}>
    <Text bold color="green">
      Counter Example - Complete
    </Text>

    <Box marginTop={1} flexDirection="row">
      <Text>Final Count: </Text>
      <Text color={state.finalCount >= 0 ? 'green' : 'red'} bold>
        {state.finalCount}
      </Text>
    </Box>

    {state.history.length > 0 && (
      <Box marginTop={1} flexDirection="column">
        <Text dim>History:</Text>
        {state.history.map((entry, i) => (
          <Text key={i} dim>
            {'  '}
            {entry}
          </Text>
        ))}
      </Box>
    )}
  </Box>
)

const InterruptedView = ({ state }: { state: Extract<CounterState, { _tag: 'Interrupted' }> }) => (
  <Box flexDirection="column" padding={1}>
    <Text bold color="yellow">
      Counter Example - Interrupted
    </Text>

    <Box marginTop={1} flexDirection="row">
      <Text>Count at interruption: </Text>
      <Text bold>{state.count}</Text>
    </Box>

    {state.history.length > 0 && (
      <Box marginTop={1} flexDirection="column">
        <Text dim>History:</Text>
        {state.history.map((entry, i) => (
          <Text key={i} dim>
            {'  '}
            {entry}
          </Text>
        ))}
      </Box>
    )}
  </Box>
)

// =============================================================================
// Main View (for Storybook)
// =============================================================================

export const CounterView = ({ state }: { state: CounterState }) => {
  switch (state._tag) {
    case 'Running':
      return <RunningView state={state} />
    case 'Complete':
      return <CompleteView state={state} />
    case 'Interrupted':
      return <InterruptedView state={state} />
  }
}
