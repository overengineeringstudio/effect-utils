/**
 * RootOutput Schema
 *
 * Effect Schema definitions for the root command output.
 * Supports both success and error states.
 */

import { Schema } from 'effect'

// =============================================================================
// Root State (Union of success and error)
// =============================================================================

/**
 * Success state - JSON output:
 * { "root": "/path/to/megarepo", "name": "my-workspace", "source": "search" }
 */
export const RootSuccessState = Schema.Struct({
  root: Schema.String,
  name: Schema.String,
  source: Schema.Literal('search'),
})

/**
 * Error state - JSON output: { "error": "...", "message": "..." }
 */
export const RootErrorState = Schema.Struct({
  error: Schema.String,
  message: Schema.String,
})

/**
 * State for root command - discriminated by property presence.
 */
export const RootState = Schema.Union(RootSuccessState, RootErrorState)

export type RootState = Schema.Schema.Type<typeof RootState>

// =============================================================================
// Type Guards
// =============================================================================

export const isRootError = (state: RootState): state is typeof RootErrorState.Type =>
  'error' in state

export const isRootSuccess = (state: RootState): state is typeof RootSuccessState.Type =>
  'root' in state

// =============================================================================
// Root Actions
// =============================================================================

export const RootAction = Schema.Union(
  Schema.TaggedStruct('SetSuccess', {
    root: Schema.String,
    name: Schema.String,
  }),
  Schema.TaggedStruct('SetError', { error: Schema.String, message: Schema.String }),
)

export type RootAction = Schema.Schema.Type<typeof RootAction>

// =============================================================================
// Reducer
// =============================================================================

export const rootReducer = ({
  state: _state,
  action,
}: {
  state: RootState
  action: RootAction
}): RootState => {
  switch (action._tag) {
    case 'SetSuccess':
      return { root: action.root, name: action.name, source: 'search' }
    case 'SetError':
      return { error: action.error, message: action.message }
  }
}
