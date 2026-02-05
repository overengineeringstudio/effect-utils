/**
 * Log Capture Example - State and Action Schemas
 *
 * Simulates a task runner that produces logs via Effect.log() and console.log()
 * during execution. Demonstrates that these logs are captured rather than
 * printed to stdout/stderr, preventing TUI corruption.
 */

import { Schema } from 'effect'

// =============================================================================
// State Schema
// =============================================================================

/** Schema for task status values. */
export const TaskStatus = Schema.Literal('pending', 'running', 'done', 'error')

/** Schema for a single task item with name and status. */
export const TaskItem = Schema.Struct({
  name: Schema.String,
  status: TaskStatus,
})

/** Schema for the running state with task list and current task name. */
export const RunningState = Schema.TaggedStruct('Running', {
  tasks: Schema.Array(TaskItem),
  currentTaskName: Schema.String,
})

/** Schema for the completed state with final task results. */
export const CompleteState = Schema.TaggedStruct('Complete', {
  tasks: Schema.Array(TaskItem),
  totalTasks: Schema.Number,
})

/** Schema for the interrupted state preserving task list at interruption. */
export const InterruptedState = Schema.TaggedStruct('Interrupted', {
  tasks: Schema.Array(TaskItem),
})

/** Union schema of all task runner states (Running, Complete, Interrupted). */
export const TaskRunnerState = Schema.Union(RunningState, CompleteState, InterruptedState)

export type TaskRunnerState = typeof TaskRunnerState.Type

// =============================================================================
// Action Schema
// =============================================================================

/** Union schema of task runner actions (StartTask, CompleteTask, FailTask, Finish, Interrupted). */
export const TaskRunnerAction = Schema.Union(
  Schema.TaggedStruct('StartTask', { name: Schema.String }),
  Schema.TaggedStruct('CompleteTask', { name: Schema.String }),
  Schema.TaggedStruct('FailTask', { name: Schema.String }),
  Schema.TaggedStruct('Finish', {}),
  Schema.TaggedStruct('Interrupted', {}),
)

export type TaskRunnerAction = typeof TaskRunnerAction.Type

// =============================================================================
// Reducer
// =============================================================================

/** Reducer handling task start, complete, fail, finish, and interrupt actions. */
export const taskRunnerReducer = ({
  state,
  action,
}: {
  state: TaskRunnerState
  action: TaskRunnerAction
}): TaskRunnerState => {
  switch (action._tag) {
    case 'StartTask': {
      if (state._tag !== 'Running') return state
      return {
        ...state,
        currentTaskName: action.name,
        tasks: state.tasks.map((t) =>
          t.name === action.name ? { ...t, status: 'running' as const } : t,
        ),
      }
    }
    case 'CompleteTask': {
      if (state._tag !== 'Running') return state
      return {
        ...state,
        currentTaskName: '',
        tasks: state.tasks.map((t) =>
          t.name === action.name ? { ...t, status: 'done' as const } : t,
        ),
      }
    }
    case 'FailTask': {
      if (state._tag !== 'Running') return state
      return {
        ...state,
        currentTaskName: '',
        tasks: state.tasks.map((t) =>
          t.name === action.name ? { ...t, status: 'error' as const } : t,
        ),
      }
    }
    case 'Finish': {
      if (state._tag !== 'Running') return state
      return {
        _tag: 'Complete',
        tasks: state.tasks,
        totalTasks: state.tasks.length,
      }
    }
    case 'Interrupted': {
      if (state._tag !== 'Running') return state
      return {
        _tag: 'Interrupted',
        tasks: state.tasks,
      }
    }
  }
}
