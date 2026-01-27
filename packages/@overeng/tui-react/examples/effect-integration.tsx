/**
 * Effect Integration Example
 *
 * Demonstrates how to use @overeng/tui-react with Effect:
 * - TuiRenderer service for managed rendering
 * - useSubscriptionRef for reactive state
 * - Automatic cleanup when Effect scope closes
 *
 * Run: npx tsx examples/effect-integration.tsx
 */

import React from 'react'
import { Effect, SubscriptionRef, Schedule, Scope } from 'effect'
import {
  TuiRenderer,
  Box,
  Text,
  Static,
  Spinner,
  useSubscriptionRef,
  RefRegistryProvider,
  createRefRegistry,
  useRegistryRef,
} from '../src/mod.ts'

// =============================================================================
// Types
// =============================================================================

interface Task {
  id: string
  name: string
  status: 'pending' | 'running' | 'done' | 'error'
}

interface AppState {
  tasks: Task[]
  currentMessage: string
  logs: string[]
}

// =============================================================================
// React Components
// =============================================================================

const StatusIcon = ({ status }: { status: Task['status'] }) => {
  switch (status) {
    case 'pending':
      return <Text dim>○</Text>
    case 'running':
      return <Spinner />
    case 'done':
      return <Text color="green">✓</Text>
    case 'error':
      return <Text color="red">✗</Text>
  }
}

const TaskList = ({ tasks }: { tasks: Task[] }) => (
  <Box paddingLeft={2}>
    {tasks.map((task) => (
      <Box key={task.id} flexDirection="row">
        <StatusIcon status={task.status} />
        <Text
          color={task.status === 'done' ? 'green' : task.status === 'error' ? 'red' : undefined}
          dim={task.status === 'pending'}
        >
          {' '}
          {task.name}
        </Text>
      </Box>
    ))}
  </Box>
)

/**
 * Main App component that uses registry refs for state
 */
const App = () => {
  const state = useRegistryRef<AppState>('state', {
    tasks: [],
    currentMessage: 'Initializing...',
    logs: [],
  })

  const allDone = state.tasks.length > 0 && state.tasks.every((t) => t.status === 'done' || t.status === 'error')

  return (
    <>
      {/* Static region for logs */}
      <Static items={state.logs}>
        {(log, i) => (
          <Text key={i} dim>
            {log}
          </Text>
        )}
      </Static>

      {/* Dynamic region for progress */}
      <Box paddingTop={state.logs.length > 0 ? 1 : 0}>
        <Box flexDirection="row">
          {allDone ? <Text color="green">✓ </Text> : <><Spinner /><Text> </Text></>}
          <Text bold={!allDone}>{state.currentMessage}</Text>
        </Box>

        {state.tasks.length > 0 && <TaskList tasks={state.tasks} />}

        {!allDone && state.tasks.length > 0 && (
          <Box paddingTop={1}>
            <Text dim>
              Progress: {state.tasks.filter((t) => t.status === 'done').length}/{state.tasks.length}
            </Text>
          </Box>
        )}
      </Box>
    </>
  )
}

// =============================================================================
// Effect Program
// =============================================================================

const program = Effect.gen(function* () {
  // Create the registry for sharing state with React
  const registry = createRefRegistry()

  // Create reactive state ref
  const stateRef = yield* SubscriptionRef.make<AppState>({
    tasks: [],
    currentMessage: 'Initializing...',
    logs: [],
  })

  // Register the ref so React can access it
  registry.register('state', stateRef)

  // Get the TuiRenderer service
  const tui = yield* TuiRenderer

  // Render the app with the registry provider
  yield* tui.render(
    <RefRegistryProvider registry={registry}>
      <App />
    </RefRegistryProvider>,
  )

  // Helper to update state
  const updateState = (fn: (state: AppState) => AppState) =>
    SubscriptionRef.update(stateRef, fn)

  // Helper to add a log
  const addLog = (message: string) =>
    updateState((state) => ({
      ...state,
      logs: [...state.logs, `[${new Date().toISOString().split('T')[1]?.slice(0, 8)}] ${message}`],
    }))

  // Simulate some work
  yield* Effect.sleep('500 millis')
  yield* addLog('Starting task processing...')

  // Initialize tasks
  const taskNames = ['fetch-data', 'process-items', 'validate-results', 'generate-report', 'cleanup']
  yield* updateState((state) => ({
    ...state,
    currentMessage: 'Processing tasks...',
    tasks: taskNames.map((name, i) => ({
      id: `task-${i}`,
      name,
      status: 'pending' as const,
    })),
  }))

  // Process each task
  for (let i = 0; i < taskNames.length; i++) {
    // Mark task as running
    yield* updateState((state) => ({
      ...state,
      tasks: state.tasks.map((t, idx) => (idx === i ? { ...t, status: 'running' as const } : t)),
    }))

    // Simulate work
    yield* Effect.sleep(`${300 + Math.random() * 400} millis`)

    // Mark task as done (occasionally error)
    const isError = Math.random() < 0.1
    yield* updateState((state) => ({
      ...state,
      tasks: state.tasks.map((t, idx) =>
        idx === i ? { ...t, status: isError ? ('error' as const) : ('done' as const) } : t,
      ),
    }))

    if (isError) {
      yield* addLog(`Task "${taskNames[i]}" failed!`)
    } else {
      yield* addLog(`Task "${taskNames[i]}" completed`)
    }
  }

  // Final state
  const finalState = yield* SubscriptionRef.get(stateRef)
  const errorCount = finalState.tasks.filter((t) => t.status === 'error').length

  yield* updateState((state) => ({
    ...state,
    currentMessage: errorCount > 0 ? `Completed with ${errorCount} errors` : 'All tasks completed successfully!',
  }))

  // Wait a moment to show final state
  yield* Effect.sleep('1 second')

  // Cleanup is automatic when scope closes
  yield* tui.unmount()
})

// =============================================================================
// Run the program
// =============================================================================

const main = program.pipe(
  Effect.scoped,
  Effect.provide(TuiRenderer.live),
  Effect.catchAllCause((cause) => Effect.logError('Program failed', cause)),
)

Effect.runPromise(main).then(() => {
  process.exit(0)
})
