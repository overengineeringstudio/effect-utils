/**
 * GenerateOutput Schema
 *
 * Effect Schema definitions for the generate command output.
 * Supports idle, running, success, and error states.
 */

import { Schema } from 'effect'

// =============================================================================
// Generate State (Union of idle, running, success, and error)
// =============================================================================

/**
 * Idle state - initial state before generation starts
 */
export const GenerateIdleState = Schema.TaggedStruct('Idle', {})

/**
 * Running state - generation in progress
 */
export const GenerateRunningState = Schema.TaggedStruct('Running', {
  generator: Schema.String,
  progress: Schema.optional(Schema.String),
})

/**
 * Result item for a generated file
 */
export const GenerateResultItem = Schema.Struct({
  generator: Schema.String,
  status: Schema.String,
})

export type GenerateResultItem = Schema.Schema.Type<typeof GenerateResultItem>

/**
 * Success state - JSON output:
 * { "_tag": "Success", "results": [...] }
 */
export const GenerateSuccessState = Schema.TaggedStruct('Success', {
  results: Schema.Array(GenerateResultItem),
})

/**
 * Error state - JSON output: { "_tag": "Error", "error": "...", "message": "..." }
 */
export const GenerateErrorState = Schema.TaggedStruct('Error', {
  error: Schema.String,
  message: Schema.String,
})

/**
 * State for generate command.
 */
export const GenerateState = Schema.Union(
  GenerateIdleState,
  GenerateRunningState,
  GenerateSuccessState,
  GenerateErrorState,
)

export type GenerateState = Schema.Schema.Type<typeof GenerateState>

// =============================================================================
// Type Guards
// =============================================================================

export const isGenerateError = (state: GenerateState): state is typeof GenerateErrorState.Type =>
  state._tag === 'Error'

export const isGenerateSuccess = (
  state: GenerateState,
): state is typeof GenerateSuccessState.Type => state._tag === 'Success'

export const isGenerateRunning = (
  state: GenerateState,
): state is typeof GenerateRunningState.Type => state._tag === 'Running'

export const isGenerateIdle = (state: GenerateState): state is typeof GenerateIdleState.Type =>
  state._tag === 'Idle'

// =============================================================================
// Generate Actions
// =============================================================================

export const GenerateAction = Schema.Union(
  Schema.TaggedStruct('Start', { generator: Schema.String }),
  Schema.TaggedStruct('SetProgress', { generator: Schema.String, progress: Schema.String }),
  Schema.TaggedStruct('SetSuccess', { results: Schema.Array(GenerateResultItem) }),
  Schema.TaggedStruct('SetError', { error: Schema.String, message: Schema.String }),
)

export type GenerateAction = Schema.Schema.Type<typeof GenerateAction>

// =============================================================================
// Reducer
// =============================================================================

export const generateReducer = ({
  state: _state,
  action,
}: {
  state: GenerateState
  action: GenerateAction
}): GenerateState => {
  switch (action._tag) {
    case 'Start':
      return { _tag: 'Running', generator: action.generator }
    case 'SetProgress':
      return { _tag: 'Running', generator: action.generator, progress: action.progress }
    case 'SetSuccess':
      return { _tag: 'Success', results: action.results }
    case 'SetError':
      return { _tag: 'Error', error: action.error, message: action.message }
  }
}
