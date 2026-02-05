/**
 * TraceInspect state schema
 *
 * Defines the state machine for the `otel trace inspect` command.
 * State transitions: Loading → Success | Error
 */

import { Schema } from 'effect'

// =============================================================================
// Span Tree Types
// =============================================================================

/** A single attribute key-value pair. */
export const SpanAttributeEntry = Schema.Struct({
  key: Schema.String,
  value: Schema.String,
})

/** Recursive interface for a processed span with timing and tree info. */
export interface ProcessedSpan {
  readonly spanId: string
  readonly parentSpanId?: string | undefined
  readonly operationName: string
  readonly serviceName: string
  readonly startTimeMs: number
  readonly endTimeMs: number
  readonly durationMs: number
  readonly statusCode?: number | undefined
  readonly statusMessage?: string | undefined
  readonly attributes: ReadonlyArray<{ readonly key: string; readonly value: string }>
  readonly depth: number
  readonly children: ReadonlyArray<ProcessedSpan>
}

/** Recursive schema for a processed span using Schema.suspend. */
export const ProcessedSpanSchema: Schema.Schema<ProcessedSpan> = Schema.suspend(() =>
  Schema.Struct({
    spanId: Schema.String,
    parentSpanId: Schema.optional(Schema.String),
    operationName: Schema.String,
    serviceName: Schema.String,
    startTimeMs: Schema.Number,
    endTimeMs: Schema.Number,
    durationMs: Schema.Number,
    statusCode: Schema.optional(Schema.Number),
    statusMessage: Schema.optional(Schema.String),
    attributes: Schema.Array(SpanAttributeEntry),
    depth: Schema.Number,
    children: Schema.Array(ProcessedSpanSchema),
  }),
)

// =============================================================================
// State
// =============================================================================

/** Loading state — fetching trace data. */
export const InspectLoadingState = Schema.TaggedStruct('Loading', {
  message: Schema.String,
})

/** Success state — trace data loaded and span tree built. */
export const InspectSuccessState = Schema.TaggedStruct('Success', {
  traceId: Schema.String,
  rootSpans: Schema.Array(ProcessedSpanSchema),
  totalSpanCount: Schema.Number,
  traceStartMs: Schema.Number,
  traceEndMs: Schema.Number,
  traceDurationMs: Schema.Number,
  flat: Schema.Boolean,
})

/** Error state — something went wrong. */
export const InspectErrorState = Schema.TaggedStruct('Error', {
  error: Schema.String,
  message: Schema.String,
})

/** Discriminated union of all possible states. */
export const InspectState = Schema.Union(
  InspectLoadingState,
  InspectSuccessState,
  InspectErrorState,
)

/** Type for the inspect state. */
export type InspectState = typeof InspectState.Type

// =============================================================================
// Actions
// =============================================================================

/** Set the trace data after successful fetch. */
export const SetTraceAction = Schema.TaggedStruct('SetTrace', {
  traceId: Schema.String,
  rootSpans: Schema.Array(ProcessedSpanSchema),
  totalSpanCount: Schema.Number,
  traceStartMs: Schema.Number,
  traceEndMs: Schema.Number,
  traceDurationMs: Schema.Number,
  flat: Schema.Boolean,
})

/** Set an error. */
export const SetErrorAction = Schema.TaggedStruct('SetError', {
  error: Schema.String,
  message: Schema.String,
})

/** Discriminated union of all actions. */
export const InspectAction = Schema.Union(SetTraceAction, SetErrorAction)

/** Type for the inspect action. */
export type InspectAction = typeof InspectAction.Type

// =============================================================================
// Reducer
// =============================================================================

/** Pure reducer for inspect state transitions. */
export const inspectReducer = (_input: {
  state: InspectState
  action: InspectAction
}): InspectState => {
  const { action } = _input
  switch (action._tag) {
    case 'SetTrace':
      return {
        _tag: 'Success',
        traceId: action.traceId,
        rootSpans: action.rootSpans,
        totalSpanCount: action.totalSpanCount,
        traceStartMs: action.traceStartMs,
        traceEndMs: action.traceEndMs,
        traceDurationMs: action.traceDurationMs,
        flat: action.flat,
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
export const createInitialInspectState = (): InspectState => ({
  _tag: 'Loading',
  message: 'Fetching trace data...',
})
