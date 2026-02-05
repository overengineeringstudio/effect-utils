/**
 * Log Capture Example - View Component
 *
 * Uses useCapturedLogs() to render captured Effect.log() and console.log()
 * output in the Static region, above dynamic task progress.
 */

import { Atom } from '@effect-atom/atom'
import React, { useMemo } from 'react'

import { Box, Text, Static, Spinner, useTuiAtomValue, useCapturedLogs } from '../../src/mod.ts'
import type { TaskRunnerState } from './schema.ts'

/** Renders the task runner with captured logs in Static region and task progress below. */
export const TaskRunnerView = ({ stateAtom }: { stateAtom: Atom.Atom<TaskRunnerState> }) => {
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

// =============================================================================
// Internal Components
// =============================================================================

const CapturedLogPanel = () => {
  const logs = useCapturedLogs()

  if (logs.length === 0) return null

  return (
    <Static items={logs}>
      {(log) => (
        <Text key={log.id} dim>
          [{log.level}] {log.message}
        </Text>
      )}
    </Static>
  )
}

const TaskList = ({ tasks }: { tasks: readonly { name: string; status: string }[] }) => (
  <Box flexDirection="column">
    {tasks.map((task) => (
      <Box key={task.name} paddingLeft={2} flexDirection="row">
        {task.status === 'done' && <Text color="green">{'  \u2713 '}</Text>}
        {task.status === 'running' && (
          <>
            <Spinner color="yellow" />
            <Text> </Text>
          </>
        )}
        {task.status === 'pending' && <Text dim>{'  \u25CB '}</Text>}
        {task.status === 'error' && <Text color="red">{'  \u2717 '}</Text>}
        <Text>{task.name}</Text>
      </Box>
    ))}
  </Box>
)

const RunningView = ({ stateAtom }: { stateAtom: Atom.Atom<TaskRunnerState> }) => {
  const state = useTuiAtomValue(stateAtom)
  if (state._tag !== 'Running') return null

  const done = state.tasks.filter((t) => t.status === 'done').length

  return (
    <>
      <CapturedLogPanel />
      <Box flexDirection="column" padding={1}>
        <Text bold color="cyan">
          Task Runner ({done}/{state.tasks.length})
        </Text>
        <TaskList tasks={state.tasks} />
      </Box>
    </>
  )
}

const CompleteView = ({ stateAtom }: { stateAtom: Atom.Atom<TaskRunnerState> }) => {
  const state = useTuiAtomValue(stateAtom)
  if (state._tag !== 'Complete') return null

  return (
    <>
      <CapturedLogPanel />
      <Box flexDirection="column" padding={1}>
        <Text bold color="green">
          All {state.totalTasks} tasks complete
        </Text>
        <TaskList tasks={state.tasks} />
      </Box>
    </>
  )
}

const InterruptedView = ({ stateAtom }: { stateAtom: Atom.Atom<TaskRunnerState> }) => {
  const state = useTuiAtomValue(stateAtom)
  if (state._tag !== 'Interrupted') return null

  return (
    <>
      <CapturedLogPanel />
      <Box flexDirection="column" padding={1}>
        <Text bold color="yellow">
          Task Runner - Interrupted
        </Text>
        <TaskList tasks={state.tasks} />
      </Box>
    </>
  )
}
