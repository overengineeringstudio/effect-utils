/**
 * Task List Component Showcase
 *
 * Demonstrates:
 * - Effect CLI integration for proper signal handling
 * - createTuiApp pattern with state management
 * - TaskList component with different states
 * - Spinner component
 * - Static region for logs
 * - Progressive state updates
 * - Graceful Ctrl+C handling
 *
 * Run:
 *   bun examples/02-components/task-list.tsx
 *   bun examples/02-components/task-list.tsx --json
 *   bun examples/02-components/task-list.tsx --help
 */

import { Command } from '@effect/cli'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { Effect, Schema } from 'effect'
import React from 'react'

import {
  createTuiApp,
  Box,
  Text,
  Spinner,
  Static,
  TaskList,
  TaskItemSchema,
  type TaskItem,
  type TaskStatus,
  outputModeOptions,
  outputModeLayerFromFlagsWithTTY,
} from '../../src/mod.ts'

// =============================================================================
// State Schema
// =============================================================================

const RunningState = Schema.Struct({
  _tag: Schema.Literal('Running'),
  tasks: Schema.Array(TaskItemSchema),
  logs: Schema.Array(Schema.String),
  currentTask: Schema.Number,
})

const FinishedState = Schema.Struct({
  _tag: Schema.Literal('Finished'),
  tasks: Schema.Array(TaskItemSchema),
  logs: Schema.Array(Schema.String),
  hasErrors: Schema.Boolean,
})

const InterruptedState = Schema.Struct({
  _tag: Schema.Literal('Interrupted'),
  tasks: Schema.Array(TaskItemSchema),
  logs: Schema.Array(Schema.String),
  completedCount: Schema.Number,
})

const AppState = Schema.Union(RunningState, FinishedState, InterruptedState)

type AppState = Schema.Schema.Type<typeof AppState>

// =============================================================================
// Action Schema
// =============================================================================

const AppAction = Schema.Union(
  Schema.TaggedStruct('StartTask', { index: Schema.Number }),
  Schema.TaggedStruct('CompleteTask', { index: Schema.Number, success: Schema.Boolean }),
  Schema.TaggedStruct('AddLog', { message: Schema.String }),
  Schema.TaggedStruct('Finish', {}),
  Schema.TaggedStruct('Interrupted', {}),
)

type AppAction = Schema.Schema.Type<typeof AppAction>

// =============================================================================
// Reducer
// =============================================================================

const timestamp = () => new Date().toISOString().slice(11, 19)

const appReducer = ({
  state,
  action,
}: {
  state: AppState
  action: AppAction
}): AppState => {
  switch (action._tag) {
    case 'StartTask': {
      if (state._tag !== 'Running') return state
      return {
        ...state,
        tasks: state.tasks.map((t, i) =>
          i === action.index ? { ...t, status: 'active' as TaskStatus } : t,
        ),
        currentTask: action.index,
      }
    }

    case 'CompleteTask': {
      if (state._tag !== 'Running') return state
      return {
        ...state,
        tasks: state.tasks.map((t, i) =>
          i === action.index
            ? { ...t, status: (action.success ? 'success' : 'error') as TaskStatus }
            : t,
        ),
      }
    }

    case 'AddLog': {
      if (state._tag === 'Finished') return state
      return {
        ...state,
        logs: [...state.logs, `[${timestamp()}] ${action.message}`],
      }
    }

    case 'Finish': {
      if (state._tag !== 'Running') return state
      const hasErrors = state.tasks.some((t) => t.status === 'error')
      return {
        _tag: 'Finished',
        tasks: state.tasks,
        logs: state.logs,
        hasErrors,
      }
    }

    case 'Interrupted': {
      if (state._tag !== 'Running') return state
      const completedCount = state.tasks.filter(
        (t) => t.status === 'success' || t.status === 'error',
      ).length
      return {
        _tag: 'Interrupted',
        tasks: state.tasks.map((t) =>
          t.status === 'active' ? { ...t, status: 'pending' as TaskStatus } : t,
        ),
        logs: [...state.logs, `[${timestamp()}] Interrupted by user`],
        completedCount,
      }
    }
  }
}

// =============================================================================
// Initial Tasks
// =============================================================================

const initialTasks: TaskItem[] = [
  { id: '1', label: 'Validate configuration', status: 'pending' },
  { id: '2', label: 'Build application', status: 'pending' },
  { id: '3', label: 'Run tests', status: 'pending' },
  { id: '4', label: 'Deploy to staging', status: 'pending' },
  { id: '5', label: 'Health check', status: 'pending' },
]

// =============================================================================
// View Components
// =============================================================================

/** Header - changes based on state */
const Header = ({ state }: { state: AppState }) => {
  switch (state._tag) {
    case 'Running':
      return (
        <Text bold color="cyan">
          Task List Component Demo
        </Text>
      )
    case 'Finished':
      return (
        <Text bold color={state.hasErrors ? 'yellow' : 'green'}>
          Task List Demo - {state.hasErrors ? 'Completed with Errors' : 'All Tasks Complete'}
        </Text>
      )
    case 'Interrupted':
      return (
        <Text bold color="yellow">
          Task List Demo - Interrupted
        </Text>
      )
  }
}

/** Footer status - changes based on state */
const Footer = ({ state }: { state: AppState }) => {
  switch (state._tag) {
    case 'Running':
      return (
        <Box marginTop={1} flexDirection="row">
          <Spinner color="cyan" />
          <Text> Processing tasks...</Text>
        </Box>
      )
    case 'Finished':
      return (
        <Box marginTop={1}>
          <Text dim>
            {state.tasks.filter((t) => t.status === 'success').length}/{state.tasks.length} tasks
            succeeded
          </Text>
        </Box>
      )
    case 'Interrupted':
      return (
        <Box marginTop={1}>
          <Text dim>
            {state.completedCount}/{state.tasks.length} tasks completed before interruption
          </Text>
        </Box>
      )
  }
}

// =============================================================================
// Main Program
// =============================================================================

const runTaskListDemo = Effect.gen(function* () {
  const TaskListApp = createTuiApp({
    stateSchema: AppState,
    actionSchema: AppAction,
    initial: {
      _tag: 'Running',
      tasks: initialTasks,
      logs: [],
      currentTask: -1,
    } as AppState,
    reducer: appReducer,
    interruptTimeout: 200,
  })

  const TaskListView = () => {
    const state = TaskListApp.useState()

    return (
      <Box flexDirection="column" padding={1}>
        <Header state={state} />

        {/* Single Static instance - persists across state changes */}
        <Static items={state.logs}>
          {/* oxlint-disable-next-line overeng/named-args -- React render callback */}
          {(log, i) => (
            <Text key={i} dim>
              {log}
            </Text>
          )}
        </Static>

        {/* Task list */}
        <Box marginTop={1}>
          <TaskList items={state.tasks as TaskItem[]} />
        </Box>

        <Footer state={state} />
      </Box>
    )
  }

  const tui = yield* TaskListApp.run(<TaskListView />)

  // Process each task
  for (let i = 0; i < initialTasks.length; i++) {
    if (tui.getState()._tag !== 'Running') break

    const task = initialTasks[i]!

    // Start task
    tui.dispatch({ _tag: 'StartTask', index: i })
    tui.dispatch({ _tag: 'AddLog', message: `Starting: ${task.label}` })

    // Simulate work (random duration between 400-800ms)
    yield* Effect.sleep(`${400 + Math.random() * 400} millis`)

    if (tui.getState()._tag !== 'Running') break

    // Complete task (30% chance of failure on "Run tests")
    const willFail = i === 2 && Math.random() < 0.3
    tui.dispatch({ _tag: 'CompleteTask', index: i, success: !willFail })
    tui.dispatch({
      _tag: 'AddLog',
      message: `${willFail ? 'Failed' : 'Done'}: ${task.label}`,
    })
  }

  // Finish if still running
  if (tui.getState()._tag === 'Running') {
    tui.dispatch({ _tag: 'Finish' })
  }
}).pipe(Effect.scoped)

// =============================================================================
// CLI Command
// =============================================================================

const taskListCommand = Command.make('task-list', outputModeOptions, ({ json, stream, visual }) =>
  runTaskListDemo.pipe(Effect.provide(outputModeLayerFromFlagsWithTTY({ json, stream, visual }))),
)

const cli = Command.run(taskListCommand, {
  name: 'Task List Demo',
  version: '1.0.0',
})

// Run with Effect CLI (handles SIGINT/SIGTERM properly)
cli(process.argv).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain)
