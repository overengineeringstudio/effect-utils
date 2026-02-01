import { Atom } from '@effect-atom/atom'
import React, { useMemo } from 'react'

import { Box, Text, Spinner, useTuiAtomValue } from '../../src/mod.ts'
import type { CounterState } from './schema.ts'

const HistoryView = ({ history }: { history: readonly string[] }) =>
  history.length > 0 ? (
    <Box marginTop={1} flexDirection="column">
      <Text dim>History:</Text>
      {history.map((entry, i) => (
        <Text key={i} dim>
          {'  '}
          {entry}
        </Text>
      ))}
    </Box>
  ) : null

const RunningView = ({ stateAtom }: { stateAtom: Atom.Atom<CounterState> }) => {
  const state = useTuiAtomValue(stateAtom) as Extract<CounterState, { _tag: 'Running' }>
  return (
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
      <HistoryView history={state.history} />
    </Box>
  )
}

const CompleteView = ({ stateAtom }: { stateAtom: Atom.Atom<CounterState> }) => {
  const state = useTuiAtomValue(stateAtom) as Extract<CounterState, { _tag: 'Complete' }>
  return (
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
      <HistoryView history={state.history} />
    </Box>
  )
}

const InterruptedView = ({ stateAtom }: { stateAtom: Atom.Atom<CounterState> }) => {
  const state = useTuiAtomValue(stateAtom) as Extract<CounterState, { _tag: 'Interrupted' }>
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="yellow">
        Counter Example - Interrupted
      </Text>
      <Box marginTop={1} flexDirection="row">
        <Text>Count at interruption: </Text>
        <Text bold>{state.count}</Text>
      </Box>
      <HistoryView history={state.history} />
    </Box>
  )
}

export const CounterView = ({ stateAtom }: { stateAtom: Atom.Atom<CounterState> }) => {
  const tagAtom = useMemo(() => Atom.map(stateAtom, (s) => s._tag), [stateAtom])
  const tag = useTuiAtomValue(tagAtom)

  switch (tag) {
    case 'Running':
      return <RunningView stateAtom={stateAtom} />
    case 'Complete':
      return <CompleteView stateAtom={stateAtom} />
    case 'Interrupted':
      return <InterruptedView stateAtom={stateAtom} />
  }
}
