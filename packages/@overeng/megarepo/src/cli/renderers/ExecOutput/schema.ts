/**
 * ExecOutput Schema
 *
 * Effect Schema definitions for the exec command output.
 * Supports running state with multiple members and completion with results.
 */

import { Schema } from 'effect'

// =============================================================================
// Member Exec Status
// =============================================================================

export const MemberExecStatus = Schema.Struct({
  /** Member name */
  name: Schema.String,
  /** Current execution status */
  status: Schema.Literal('pending', 'running', 'success', 'error', 'skipped'),
  /** Exit code (0 = success, non-zero = error) */
  exitCode: Schema.optional(Schema.Number),
  /** Combined stdout output */
  stdout: Schema.optional(Schema.String),
  /** Combined stderr output */
  stderr: Schema.optional(Schema.String),
})

export type MemberExecStatus = Schema.Schema.Type<typeof MemberExecStatus>

// =============================================================================
// Exec State (Union of Running, Complete, Error)
// =============================================================================

/**
 * Running state - exec is in progress.
 * JSON output: { "_tag": "Running", "command": "...", "members": [...], ... }
 */
export const ExecRunningState = Schema.TaggedStruct('Running', {
  /** Command being executed */
  command: Schema.String,
  /** Execution mode */
  mode: Schema.Literal('parallel', 'sequential'),
  /** Verbose mode enabled */
  verbose: Schema.Boolean,
  /** All member statuses */
  members: Schema.Array(MemberExecStatus),
})

/**
 * Complete state - exec finished (success or with errors).
 * JSON output: { "_tag": "Complete", "command": "...", "members": [...], "hasErrors": ... }
 */
export const ExecCompleteState = Schema.TaggedStruct('Complete', {
  /** Command that was executed */
  command: Schema.String,
  /** Execution mode used */
  mode: Schema.Literal('parallel', 'sequential'),
  /** Verbose mode enabled */
  verbose: Schema.Boolean,
  /** All member results */
  members: Schema.Array(MemberExecStatus),
  /** Whether any errors occurred */
  hasErrors: Schema.Boolean,
})

/**
 * Error state - exec failed to start.
 * JSON output: { "_tag": "Error", "error": "...", "message": "..." }
 */
export const ExecErrorState = Schema.TaggedStruct('Error', {
  error: Schema.String,
  message: Schema.String,
})

/**
 * State for exec command - discriminated by _tag property.
 */
export const ExecState = Schema.Union(ExecRunningState, ExecCompleteState, ExecErrorState)

export type ExecState = typeof ExecState.Type

// =============================================================================
// Type Guards
// =============================================================================

export const isExecError = (state: ExecState): state is typeof ExecErrorState.Type =>
  state._tag === 'Error'

export const isExecComplete = (state: ExecState): state is typeof ExecCompleteState.Type =>
  state._tag === 'Complete'

export const isExecRunning = (state: ExecState): state is typeof ExecRunningState.Type =>
  state._tag === 'Running'

// =============================================================================
// Exec Actions
// =============================================================================

export const ExecAction = Schema.Union(
  /** Initialize exec with members */
  Schema.TaggedStruct('Start', {
    command: Schema.String,
    mode: Schema.Literal('parallel', 'sequential'),
    verbose: Schema.Boolean,
    members: Schema.Array(Schema.String),
  }),

  /** Update a member's status */
  Schema.TaggedStruct('UpdateMember', {
    name: Schema.String,
    status: Schema.Literal('pending', 'running', 'success', 'error', 'skipped'),
    exitCode: Schema.optional(Schema.Number),
    stdout: Schema.optional(Schema.String),
    stderr: Schema.optional(Schema.String),
  }),

  /** Mark exec as complete */
  Schema.TaggedStruct('Complete', {}),

  /** Set error state */
  Schema.TaggedStruct('SetError', {
    error: Schema.String,
    message: Schema.String,
  }),
)

export type ExecAction = Schema.Schema.Type<typeof ExecAction>

// =============================================================================
// Reducer
// =============================================================================

export const execReducer = ({
  state,
  action,
}: {
  state: ExecState
  action: ExecAction
}): ExecState => {
  switch (action._tag) {
    case 'Start':
      return {
        _tag: 'Running',
        command: action.command,
        mode: action.mode,
        verbose: action.verbose,
        members: action.members.map((name) => ({
          name,
          status: 'pending' as const,
        })),
      }

    case 'UpdateMember': {
      if (state._tag === 'Error') return state

      const members = state.members.map((m) =>
        m.name === action.name
          ? {
              ...m,
              status: action.status,
              exitCode: action.exitCode,
              stdout: action.stdout,
              stderr: action.stderr,
            }
          : m,
      )

      return {
        ...state,
        members,
      }
    }

    case 'Complete': {
      if (state._tag === 'Error') return state

      const hasErrors = state.members.some(
        (m) => m.status === 'error' || (m.exitCode !== undefined && m.exitCode !== 0),
      )

      return {
        _tag: 'Complete',
        command: state.command,
        mode: state.mode,
        verbose: state.verbose,
        members: state.members,
        hasErrors,
      }
    }

    case 'SetError':
      return {
        _tag: 'Error',
        error: action.error,
        message: action.message,
      }
  }
}
