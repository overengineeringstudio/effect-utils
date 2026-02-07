/**
 * MetricsQuery state schema
 *
 * Defines the state machine for the `otel metrics query` command.
 * State transitions: Loading → Success | Error
 */

import { Schema } from 'effect'

// =============================================================================
// Types
// =============================================================================

/** A single data point in a time series. */
export const DataPoint = Schema.Struct({
  timestampMs: Schema.Number,
  value: Schema.Number,
})

/** Type for a data point. */
export type DataPoint = typeof DataPoint.Type

/** A metric series with labels and samples. */
export const MetricSeries = Schema.Struct({
  name: Schema.String,
  labels: Schema.Record({ key: Schema.String, value: Schema.String }),
  samples: Schema.Array(DataPoint),
  exemplarCount: Schema.Number,
})

/** Type for a metric series. */
export type MetricSeries = typeof MetricSeries.Type

// =============================================================================
// State
// =============================================================================

/** Loading state. */
export const QueryLoadingState = Schema.TaggedStruct('Loading', {
  message: Schema.String,
})

/** Success state — query results. */
export const QuerySuccessState = Schema.TaggedStruct('Success', {
  series: Schema.Array(MetricSeries),
  query: Schema.String,
  startTime: Schema.Number,
  endTime: Schema.Number,
  step: Schema.Number,
})

/** Error state. */
export const QueryErrorState = Schema.TaggedStruct('Error', {
  error: Schema.String,
  message: Schema.String,
})

/** Discriminated union of all possible states. */
export const QueryState = Schema.Union(QueryLoadingState, QuerySuccessState, QueryErrorState)

/** Type for the query state. */
export type QueryState = typeof QueryState.Type

// =============================================================================
// Actions
// =============================================================================

/** Set the query results. */
export const SetResultsAction = Schema.TaggedStruct('SetResults', {
  series: Schema.Array(MetricSeries),
  query: Schema.String,
  startTime: Schema.Number,
  endTime: Schema.Number,
  step: Schema.Number,
})

/** Set an error. */
export const SetErrorAction = Schema.TaggedStruct('SetError', {
  error: Schema.String,
  message: Schema.String,
})

/** Discriminated union of all actions. */
export const QueryAction = Schema.Union(SetResultsAction, SetErrorAction)

/** Type for the query action. */
export type QueryAction = typeof QueryAction.Type

// =============================================================================
// Reducer
// =============================================================================

/** Pure reducer for query state transitions. */
export const queryReducer = (_input: { state: QueryState; action: QueryAction }): QueryState => {
  const { action } = _input
  switch (action._tag) {
    case 'SetResults':
      return {
        _tag: 'Success',
        series: action.series,
        query: action.query,
        startTime: action.startTime,
        endTime: action.endTime,
        step: action.step,
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
export const createInitialQueryState = (): QueryState => ({
  _tag: 'Loading',
  message: 'Querying metrics...',
})
