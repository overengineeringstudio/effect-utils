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
 * { "_tag": "Success", "root": "/path/to/megarepo", "name": "my-workspace", "source": "search" }
 */
export const RootSuccessState = Schema.TaggedStruct('Success', {
  root: Schema.String,
  name: Schema.String,
  source: Schema.Literal('search'),
})

/**
 * Error state - JSON output: { "_tag": "Error", "error": "...", "message": "..." }
 */
export const RootErrorState = Schema.TaggedStruct('Error', {
  error: Schema.String,
  message: Schema.String,
})

/**
 * State for root command - discriminated by _tag.
 */
export const RootState = Schema.Union(RootSuccessState, RootErrorState)

/** Inferred type for root command state (success with path or error). */
export type RootState = Schema.Schema.Type<typeof RootState>

// =============================================================================
// Type Guards
// =============================================================================

/** Type guard that checks if the root state is an error. */
export const isRootError = (state: RootState): state is typeof RootErrorState.Type =>
  state._tag === 'Error'

/** Type guard that checks if the root state is a successful result. */
export const isRootSuccess = (state: RootState): state is typeof RootSuccessState.Type =>
  state._tag === 'Success'

// =============================================================================
// Root Actions
// =============================================================================

/** Tagged union of actions for the root command (set success or error). */
export const RootAction = Schema.Union(
  Schema.TaggedStruct('SetSuccess', {
    root: Schema.String,
    name: Schema.String,
  }),
  Schema.TaggedStruct('SetError', { error: Schema.String, message: Schema.String }),
)

/** Inferred type for root actions. */
export type RootAction = Schema.Schema.Type<typeof RootAction>

// =============================================================================
// Reducer
// =============================================================================

/** Reduces root actions into state, replacing the state with success or error. */
export const rootReducer = ({
  state: _state,
  action,
}: {
  state: RootState
  action: RootAction
}): RootState => {
  switch (action._tag) {
    case 'SetSuccess':
      return { _tag: 'Success', root: action.root, name: action.name, source: 'search' }
    case 'SetError':
      return { _tag: 'Error', error: action.error, message: action.message }
  }
}
