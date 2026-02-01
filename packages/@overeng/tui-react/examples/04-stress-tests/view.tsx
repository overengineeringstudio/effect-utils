import { Atom } from '@effect-atom/atom'
import React, { useMemo } from 'react'

import { Box, Text, useTuiAtomValue } from '../../src/mod.ts'
import type { StressTestState } from './schema.ts'

const ProgressBar = ({ progress, width = 40 }: { progress: number; width?: number }) => {
  const filled = Math.round((progress / 100) * width)
  return (
    <Box flexDirection="row">
      <Text>Progress: </Text>
      <Text color="green">{'█'.repeat(filled)}</Text>
      <Text dim>{'░'.repeat(width - filled)}</Text>
      <Text> {progress}%</Text>
    </Box>
  )
}

const Spinner = ({ frame }: { frame: number }) => {
  const spinnerChars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  return (
    <Box flexDirection="row">
      <Text dim>Spinner: </Text>
      <Text color="cyan">{spinnerChars[frame % spinnerChars.length]}</Text>
    </Box>
  )
}

const RunningView = ({ stateAtom }: { stateAtom: Atom.Atom<StressTestState> }) => {
  const state = useTuiAtomValue(stateAtom)
  if (state._tag !== 'Running') return null

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">
        Rapid Updates Stress Test
      </Text>
      <Text dim>Testing renderer at ~60fps</Text>

      <Box flexDirection="row" marginTop={1}>
        <Text>Frame: </Text>
        <Text color="yellow" bold>
          {state.frame.toString().padStart(5)}
        </Text>
      </Box>

      <Box flexDirection="row">
        <Text>FPS: </Text>
        <Text color={state.fps >= 50 ? 'green' : state.fps >= 30 ? 'yellow' : 'red'} bold>
          {state.fps.toString().padStart(3)}
        </Text>
      </Box>

      <ProgressBar progress={state.progress} />
      <Spinner frame={state.frame} />
    </Box>
  )
}

const FinishedView = ({ stateAtom }: { stateAtom: Atom.Atom<StressTestState> }) => {
  const state = useTuiAtomValue(stateAtom)
  if (state._tag !== 'Finished') return null

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="green">
        Stress Test Complete
      </Text>

      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row">
          <Text>Total Frames: </Text>
          <Text bold>{state.totalFrames}</Text>
        </Box>
        <Box flexDirection="row">
          <Text>Average FPS: </Text>
          <Text
            color={state.averageFps >= 50 ? 'green' : state.averageFps >= 30 ? 'yellow' : 'red'}
            bold
          >
            {state.averageFps}
          </Text>
        </Box>
        <Box flexDirection="row">
          <Text>Duration: </Text>
          <Text bold>{(state.duration / 1000).toFixed(1)}s</Text>
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text dim>
          {state.averageFps >= 50
            ? 'Excellent! Renderer handled 60fps updates smoothly.'
            : state.averageFps >= 30
              ? 'Good performance, but some frames were dropped.'
              : 'Performance issues detected. Check terminal capabilities.'}
        </Text>
      </Box>
    </Box>
  )
}

const InterruptedView = ({ stateAtom }: { stateAtom: Atom.Atom<StressTestState> }) => {
  const state = useTuiAtomValue(stateAtom)
  if (state._tag !== 'Interrupted') return null

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="yellow">
        Stress Test Interrupted
      </Text>

      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row">
          <Text>Frames rendered: </Text>
          <Text bold>{state.frame}</Text>
        </Box>
        <Box flexDirection="row">
          <Text>Last FPS: </Text>
          <Text bold>{state.fps}</Text>
        </Box>
        <Box flexDirection="row">
          <Text>Progress: </Text>
          <Text bold>{state.progress}%</Text>
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text dim>Test was cancelled by user (Ctrl+C).</Text>
      </Box>
    </Box>
  )
}

export const StressTestView = ({ stateAtom }: { stateAtom: Atom.Atom<StressTestState> }) => {
  const tagAtom = useMemo(() => Atom.map(stateAtom, (s) => s._tag), [stateAtom])
  const tag = useTuiAtomValue(tagAtom)

  switch (tag) {
    case 'Running':
      return <RunningView stateAtom={stateAtom} />
    case 'Finished':
      return <FinishedView stateAtom={stateAtom} />
    case 'Interrupted':
      return <InterruptedView stateAtom={stateAtom} />
  }
}
