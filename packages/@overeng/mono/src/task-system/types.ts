/**
 * Core types for the task execution system.
 *
 * This module provides the foundation for declarative, graph-based task execution
 * with streaming output capture and pluggable rendering.
 */

import type { Exit } from 'effect'
import { Schema } from 'effect'

// =============================================================================
// Task Definition
// =============================================================================

/**
 * Definition of a task that can be executed.
 * Tasks can be arbitrary Effects or shell commands.
 */
export interface TaskDef<TId extends string, A, E, R> {
  /** Unique identifier for the task */
  readonly id: TId
  /** Human-readable name for display */
  readonly name: string
  /** Task dependencies (must complete before this task starts) */
  readonly dependencies?: ReadonlyArray<TId>
  /** Event stream for the task (emits stdout/stderr during execution, can fail) */
  readonly eventStream: (
    taskId: TId,
  ) => import('effect').Stream.Stream<TaskEvent<TId>, unknown, any>
  /** The Effect to execute (optional - some tasks only emit events) */
  readonly effect?: import('effect').Effect.Effect<A, E, R>
}

// =============================================================================
// Task Events (Streaming)
// =============================================================================

/**
 * Events emitted during task execution.
 * These flow through a Stream for real-time processing.
 */
export type TaskEvent<TId extends string> =
  | { readonly type: 'registered'; readonly taskId: TId; readonly name: string }
  | { readonly type: 'started'; readonly taskId: TId; readonly timestamp: number }
  | { readonly type: 'stdout'; readonly taskId: TId; readonly chunk: string }
  | { readonly type: 'stderr'; readonly taskId: TId; readonly chunk: string }
  | {
      readonly type: 'completed'
      readonly taskId: TId
      readonly timestamp: number
      readonly exit: Exit.Exit<unknown, unknown>
    }

// =============================================================================
// Task State (Aggregate)
// =============================================================================

/** Status of a task */
export const TaskStatus = Schema.Literal('pending', 'running', 'success', 'failed')
export type TaskStatus = typeof TaskStatus.Type

/**
 * State of an individual task.
 * Built up by reducing TaskEvents over time.
 */
export class TaskState extends Schema.Class<TaskState>('TaskState')({
  /** Task identifier */
  id: Schema.String,
  /** Human-readable name */
  name: Schema.String,
  /** Current status */
  status: TaskStatus,
  /** Captured stdout lines */
  stdout: Schema.Array(Schema.String),
  /** Captured stderr lines */
  stderr: Schema.Array(Schema.String),
  /** Start timestamp (ms since epoch) */
  startedAt: Schema.OptionFromNullOr(Schema.Number),
  /** End timestamp (ms since epoch) */
  completedAt: Schema.OptionFromNullOr(Schema.Number),
  /** Error message if failed */
  error: Schema.OptionFromNullOr(Schema.String),
}) {}

/**
 * Complete state of all tasks in the system.
 * Updated by reducing TaskEvents.
 */
export class TaskSystemState extends Schema.Class<TaskSystemState>('TaskSystemState')({
  /** All tasks by ID */
  tasks: Schema.Record({ key: Schema.String, value: TaskState }),
}) {}

// =============================================================================
// Renderer Interface
// =============================================================================

/**
 * Interface for task renderers.
 * Renderers consume TaskSystemState and produce output.
 */
export interface TaskRenderer {
  /**
   * Render the current state.
   * Called on each state update (typically debounced).
   */
  render(state: TaskSystemState): import('effect').Effect.Effect<void>

  /**
   * Render final summary after all tasks complete.
   */
  renderFinal(state: TaskSystemState): import('effect').Effect.Effect<void>
}

// =============================================================================
// Result Types
// =============================================================================

/**
 * Result of executing a task graph.
 */
export interface TaskGraphResult {
  /** Final state of all tasks */
  state: TaskSystemState
  /** Number of successful tasks */
  successCount: number
  /** Number of failed tasks */
  failureCount: number
  /** IDs of failed tasks */
  failedTaskIds: string[]
}

/**
 * Error indicating one or more tasks failed.
 */
export class TaskExecutionError extends Schema.TaggedError<TaskExecutionError>()(
  'TaskExecutionError',
  {
    failedTaskIds: Schema.Array(Schema.String),
    message: Schema.String,
  },
) {}
