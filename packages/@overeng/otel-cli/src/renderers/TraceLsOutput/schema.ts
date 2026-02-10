/**
 * TraceLs state schema
 *
 * Defines the state machine for the `otel trace ls` command.
 * State transitions: Loading → Success | Error
 */

import { Schema } from 'effect'

// =============================================================================
// Types
// =============================================================================

/** A trace summary row in the listing. */
export const TraceSummary = Schema.Struct({
  traceId: Schema.String,
  serviceName: Schema.String,
  spanName: Schema.String,
  durationMs: Schema.Number,
  startTime: Schema.DateTimeUtcFromSelf,
})

/** Type for a trace summary. */
export type TraceSummary = typeof TraceSummary.Type

// =============================================================================
// State
// =============================================================================

/** Loading state. */
export const LsLoadingState = Schema.TaggedStruct('Loading', {
  message: Schema.String,
})

/** Success state — traces listed. */
export const LsSuccessState = Schema.TaggedStruct('Success', {
  traces: Schema.Array(TraceSummary),
  query: Schema.optional(Schema.String),
  limit: Schema.Number,
  grafanaUrl: Schema.String,
})

/** Error state. */
export const LsErrorState = Schema.TaggedStruct('Error', {
  error: Schema.String,
  message: Schema.String,
})

/** Discriminated union of all possible states. */
export const LsState = Schema.Union(LsLoadingState, LsSuccessState, LsErrorState)

/** Type for the ls state. */
export type LsState = typeof LsState.Type

// =============================================================================
// Actions
// =============================================================================

/** Set the trace listing. */
export const SetTracesAction = Schema.TaggedStruct('SetTraces', {
  traces: Schema.Array(TraceSummary),
  query: Schema.optional(Schema.String),
  limit: Schema.Number,
  grafanaUrl: Schema.String,
})

/** Set an error. */
export const SetErrorAction = Schema.TaggedStruct('SetError', {
  error: Schema.String,
  message: Schema.String,
})

/** Discriminated union of all actions. */
export const LsAction = Schema.Union(SetTracesAction, SetErrorAction)

/** Type for the ls action. */
export type LsAction = typeof LsAction.Type

// =============================================================================
// Reducer
// =============================================================================

/** Pure reducer for ls state transitions. */
export const lsReducer = (_input: { state: LsState; action: LsAction }): LsState => {
  const { action } = _input
  switch (action._tag) {
    case 'SetTraces':
      return {
        _tag: 'Success',
        traces: action.traces,
        query: action.query,
        limit: action.limit,
        grafanaUrl: action.grafanaUrl,
      }
    case 'SetError':
      return {
        _tag: 'Error',
        error: action.error,
        message: action.message,
      }
  }
}

// =============================================================================
// Initial State
// =============================================================================

/** Create the initial loading state. */
export const createInitialLsState = (): LsState => ({
  _tag: 'Loading',
  message: 'Searching traces...',
})
