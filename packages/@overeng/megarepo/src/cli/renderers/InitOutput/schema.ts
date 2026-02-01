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
 * { "status": "initialized", "path": "/path/to/megarepo.json" }
 */
export const InitSuccessState = Schema.Struct({
  status: Schema.Literal('initialized'),
  path: Schema.String,
})

/**
 * Already initialized state - JSON output:
 * { "status": "already_initialized", "path": "/path/to/megarepo.json" }
 */
export const InitAlreadyState = Schema.Struct({
  status: Schema.Literal('already_initialized'),
  path: Schema.String,
})

/**
 * Error state - JSON output: { "error": "...", "message": "..." }
 */
export const InitErrorState = Schema.Struct({
  error: Schema.String,
  message: Schema.String,
})

/**
 * State for init command.
 */
export const InitState = Schema.Union(InitSuccessState, InitAlreadyState, InitErrorState)

export type InitState = Schema.Schema.Type<typeof InitState>

// =============================================================================
// Type Guards
// =============================================================================

export const isInitError = (state: InitState): state is typeof InitErrorState.Type =>
  'error' in state

export const isInitSuccess = (state: InitState): state is typeof InitSuccessState.Type =>
  'status' in state && state.status === 'initialized'

export const isInitAlready = (state: InitState): state is typeof InitAlreadyState.Type =>
  'status' in state && state.status === 'already_initialized'

// =============================================================================
// Init Actions
// =============================================================================

export const InitAction = Schema.Union(
  Schema.TaggedStruct('SetInitialized', { path: Schema.String }),
  Schema.TaggedStruct('SetAlreadyInitialized', { path: Schema.String }),
  Schema.TaggedStruct('SetError', { error: Schema.String, message: Schema.String }),
)

export type InitAction = Schema.Schema.Type<typeof InitAction>

// =============================================================================
// Reducer
// =============================================================================

export const initReducer = ({
  state: _state,
  action,
}: {
  state: InitState
  action: InitAction
}): InitState => {
  switch (action._tag) {
    case 'SetInitialized':
      return { status: 'initialized', path: action.path }
    case 'SetAlreadyInitialized':
      return { status: 'already_initialized', path: action.path }
    case 'SetError':
      return { error: action.error, message: action.message }
  }
}
