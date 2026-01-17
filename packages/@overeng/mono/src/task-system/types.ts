/**
 * Core types for the task execution system.
 *
 * This module provides the foundation for declarative, graph-based task execution
 * with streaming output capture and pluggable rendering.
 */

import type { Effect, Exit, Schedule, Stream } from 'effect'
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
  readonly eventStream: () => Stream.Stream<TaskEvent<TId>, E, R>
  /** The Effect to execute (optional - some tasks only emit events) */
  readonly effect?: Effect.Effect<A, E, R>
  /** Retry schedule for transient failures (e.g., cache race conditions) */
  readonly retrySchedule?: Schedule.Schedule<unknown, unknown, never>
  /** Maximum number of retries (used for progress display) */
  readonly maxRetries?: number
  /** Command info for command tasks (used to populate TaskState.commandInfo on failure) */
  readonly commandContext?: {
    readonly command: string
    readonly args: readonly string[]
    readonly cwd: string
  }
  /** Path to log file for persisting task output (stdout/stderr) after completion */
  readonly logFile?: string
}

// =============================================================================
// Task Events (Streaming)
// =============================================================================

/**
 * Events emitted during task execution.
 * These flow through a Stream for real-time processing.
 */
export type TaskEvent<TId extends string> =
  | {
      readonly type: 'registered'
      readonly taskId: TId
      readonly name: string
    }
  | { readonly type: 'started'; readonly taskId: TId; readonly timestamp: number }
  | {
      readonly type: 'retrying'
      readonly taskId: TId
      readonly attempt: number
      readonly maxAttempts: number
      readonly timestamp: number
    }
  | { readonly type: 'stdout'; readonly taskId: TId; readonly chunk: string }
  | { readonly type: 'stderr'; readonly taskId: TId; readonly chunk: string }
  | {
      readonly type: 'completed'
      readonly taskId: TId
      readonly timestamp: number
      readonly exit: Exit.Exit<unknown, unknown>
      readonly commandContext?: {
        readonly command: string
        readonly args: readonly string[]
        readonly cwd: string
      }
    }

// =============================================================================
// Task State (Aggregate)
// =============================================================================

/** Status of a task */
export const TaskStatus = Schema.Literal('pending', 'running', 'success', 'failed')
export type TaskStatus = typeof TaskStatus.Type

/**
 * Command execution context for command tasks.
 * Captured when a command task fails to provide debugging context.
 */
export class CommandInfo extends Schema.Class<CommandInfo>('CommandInfo')({
  /** Command executable */
  command: Schema.String,
  /** Command arguments */
  args: Schema.Array(Schema.String),
  /** Working directory where command was executed */
  cwd: Schema.String,
  /** Exit code from command */
  exitCode: Schema.Number,
}) {}

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
  /** Command execution context (only present for failed command tasks) */
  commandInfo: Schema.OptionFromNullOr(CommandInfo),
  /** Current retry attempt (0 = first attempt, 1+ = retries) */
  retryAttempt: Schema.Number,
  /** Maximum retry attempts (if task has retry schedule) */
  maxRetries: Schema.OptionFromNullOr(Schema.Number),
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
  render(state: TaskSystemState): Effect.Effect<void>

  /**
   * Render final summary after all tasks complete.
   */
  renderFinal(state: TaskSystemState): Effect.Effect<void>
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
