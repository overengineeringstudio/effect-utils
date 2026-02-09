/**
 * MetricsLs state schema
 *
 * Defines the state machine for the `otel metrics ls` command.
 * State transitions: Loading → Success | Error
 */

import { Schema } from 'effect'

// =============================================================================
// Types
// =============================================================================

/** A collector metric summary row. */
export const MetricSummary = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  value: Schema.Number,
  labels: Schema.Record({ key: Schema.String, value: Schema.String }),
  help: Schema.optional(Schema.String),
})

/** Type for a metric summary. */
export type MetricSummary = typeof MetricSummary.Type

// =============================================================================
// State
// =============================================================================

/** Loading state. */
export const LsLoadingState = Schema.TaggedStruct('Loading', {
  message: Schema.String,
})

/** Success state — metrics listed. */
export const LsSuccessState = Schema.TaggedStruct('Success', {
  metrics: Schema.Array(MetricSummary),
  metricNames: Schema.Array(Schema.String),
  filter: Schema.optional(Schema.String),
  source: Schema.Literal('collector', 'tempo'),
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

/** Set the metrics listing. */
export const SetMetricsAction = Schema.TaggedStruct('SetMetrics', {
  metrics: Schema.Array(MetricSummary),
  metricNames: Schema.Array(Schema.String),
  filter: Schema.optional(Schema.String),
  source: Schema.Literal('collector', 'tempo'),
})

/** Set an error. */
export const SetErrorAction = Schema.TaggedStruct('SetError', {
  error: Schema.String,
  message: Schema.String,
})

/** Discriminated union of all actions. */
export const LsAction = Schema.Union(SetMetricsAction, SetErrorAction)

/** Type for the ls action. */
export type LsAction = typeof LsAction.Type

// =============================================================================
// Reducer
// =============================================================================

/** Pure reducer for ls state transitions. */
export const lsReducer = (_input: { state: LsState; action: LsAction }): LsState => {
  const { action } = _input
  switch (action._tag) {
    case 'SetMetrics':
      return {
        _tag: 'Success',
        metrics: action.metrics,
        metricNames: action.metricNames,
        filter: action.filter,
        source: action.source,
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
  message: 'Fetching metrics...',
})
