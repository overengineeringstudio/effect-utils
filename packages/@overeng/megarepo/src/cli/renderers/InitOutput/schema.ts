/**
 * InitOutput Schema
 *
 * Effect Schema definitions for the init command output.
 * Supports success, already_initialized, and error states.
 */

import { Schema } from 'effect'

// =============================================================================
// Init State (Union of success, already_initialized, and error)
// =============================================================================

/**
 * Success state - JSON output:
 * { "_tag": "Success", "path": "/path/to/megarepo.json" }
 */
export const InitSuccessState = Schema.TaggedStruct('Success', {
  path: Schema.String,
})

/**
 * Already initialized state - JSON output:
 * { "_tag": "AlreadyInitialized", "path": "/path/to/megarepo.json" }
 */
export const InitAlreadyState = Schema.TaggedStruct('AlreadyInitialized', {
  path: Schema.String,
})

/**
 * Error state - JSON output: { "_tag": "Error", "error": "...", "message": "..." }
 */
export const InitErrorState = Schema.TaggedStruct('Error', {
  error: Schema.String,
  message: Schema.String,
})

/**
 * State for init command.
 */
export const InitState = Schema.Union(InitSuccessState, InitAlreadyState, InitErrorState)

/** Inferred type for the init command state (success, already initialized, or error). */
export type InitState = Schema.Schema.Type<typeof InitState>

// =============================================================================
// Type Guards
// =============================================================================

/** Type guard that checks if the init state is an error. */
export const isInitError = (state: InitState): state is typeof InitErrorState.Type =>
  state._tag === 'Error'

/** Type guard that checks if the init state is a successful initialization. */
export const isInitSuccess = (state: InitState): state is typeof InitSuccessState.Type =>
  state._tag === 'Success'

/** Type guard that checks if the megarepo was already initialized. */
export const isInitAlready = (state: InitState): state is typeof InitAlreadyState.Type =>
  state._tag === 'AlreadyInitialized'

// =============================================================================
// Init Actions
// =============================================================================

/** Tagged union of actions for the init command. */
export const InitAction = Schema.Union(
  Schema.TaggedStruct('SetInitialized', { path: Schema.String }),
  Schema.TaggedStruct('SetAlreadyInitialized', { path: Schema.String }),
  Schema.TaggedStruct('SetError', { error: Schema.String, message: Schema.String }),
)

/** Inferred type for init actions. */
export type InitAction = Schema.Schema.Type<typeof InitAction>

// =============================================================================
// Reducer
// =============================================================================

/** Reduces init actions into state, setting initialized, already-initialized, or error. */
export const initReducer = ({
  state: _state,
  action,
}: {
  state: InitState
  action: InitAction
}): InitState => {
  switch (action._tag) {
    case 'SetInitialized':
      return { _tag: 'Success', path: action.path }
    case 'SetAlreadyInitialized':
      return { _tag: 'AlreadyInitialized', path: action.path }
    case 'SetError':
      return { _tag: 'Error', error: action.error, message: action.message }
  }
}
