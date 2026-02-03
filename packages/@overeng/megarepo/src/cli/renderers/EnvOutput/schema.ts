/**
 * EnvOutput Schema
 *
 * Effect Schema definitions for the env command output.
 * Supports success and error states.
 */

import { Schema } from 'effect'

// =============================================================================
// Env State (Union of success and error)
// =============================================================================

/**
 * Success state - JSON output:
 * {
 *   "_tag": "Success",
 *   "MEGAREPO_STORE": "~/.megarepo"
 * }
 */
export const EnvSuccessState = Schema.TaggedStruct('Success', {
  /** Global store location */
  MEGAREPO_STORE: Schema.String,
  /** Shell type for output formatting (only used in TTY mode) */
  shell: Schema.optional(Schema.Literal('bash', 'zsh', 'fish')),
})

/**
 * Error state - JSON output: { "_tag": "Error", "error": "...", "message": "..." }
 */
export const EnvErrorState = Schema.TaggedStruct('Error', {
  error: Schema.String,
  message: Schema.String,
})

/**
 * State for env command.
 */
export const EnvState = Schema.Union(EnvSuccessState, EnvErrorState)

/** Inferred type for the env command state (success with env vars or error). */
export type EnvState = Schema.Schema.Type<typeof EnvState>

// =============================================================================
// Type Guards
// =============================================================================

/** Type guard that checks if the env state is an error. */
export const isEnvError = (state: EnvState): state is typeof EnvErrorState.Type =>
  state._tag === 'Error'

/** Type guard that checks if the env state is a successful result with environment variables. */
export const isEnvSuccess = (state: EnvState): state is typeof EnvSuccessState.Type =>
  state._tag === 'Success'

// =============================================================================
// Env Actions
// =============================================================================

/**
 * Actions for env output.
 */
export const EnvAction = Schema.Union(
  /** Set success state */
  Schema.TaggedStruct('SetEnv', {
    MEGAREPO_STORE: Schema.String,
    shell: Schema.optional(Schema.Literal('bash', 'zsh', 'fish')),
  }),
  /** Set error state */
  Schema.TaggedStruct('SetError', { error: Schema.String, message: Schema.String }),
)

/** Inferred type for env actions. */
export type EnvAction = Schema.Schema.Type<typeof EnvAction>

// =============================================================================
// Reducer
// =============================================================================

/** Reduces env actions into state, setting environment variables or error. */
export const envReducer = ({
  state: _state,
  action,
}: {
  state: EnvState
  action: EnvAction
}): EnvState => {
  switch (action._tag) {
    case 'SetEnv':
      return {
        _tag: 'Success',
        MEGAREPO_STORE: action.MEGAREPO_STORE,
        shell: action.shell,
      }
    case 'SetError':
      return { _tag: 'Error', error: action.error, message: action.message }
  }
}
