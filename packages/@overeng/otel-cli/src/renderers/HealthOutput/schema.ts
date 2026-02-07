/**
 * Health state schema
 *
 * Defines the state machine for the `otel health` command.
 * State transitions: Loading → Success | Error
 */

import { Schema } from 'effect'

// =============================================================================
// Types
// =============================================================================

/** Health status of a single component. */
export const ComponentHealth = Schema.Struct({
  name: Schema.String,
  healthy: Schema.Boolean,
  message: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
})

/** Type for a component health check result. */
export type ComponentHealth = typeof ComponentHealth.Type

// =============================================================================
// State
// =============================================================================

/** Loading state. */
export const HealthLoadingState = Schema.TaggedStruct('Loading', {
  message: Schema.String,
})

/** Success state — all health checks completed. */
export const HealthSuccessState = Schema.TaggedStruct('Success', {
  components: Schema.Array(ComponentHealth),
  allHealthy: Schema.Boolean,
})

/** Error state. */
export const HealthErrorState = Schema.TaggedStruct('Error', {
  error: Schema.String,
  message: Schema.String,
})

/** Discriminated union of all possible states. */
export const HealthState = Schema.Union(HealthLoadingState, HealthSuccessState, HealthErrorState)

/** Type for the health state. */
export type HealthState = typeof HealthState.Type

// =============================================================================
// Actions
// =============================================================================

/** Set health check results. */
export const SetHealthAction = Schema.TaggedStruct('SetHealth', {
  components: Schema.Array(ComponentHealth),
  allHealthy: Schema.Boolean,
})

/** Set an error. */
export const SetErrorAction = Schema.TaggedStruct('SetError', {
  error: Schema.String,
  message: Schema.String,
})

/** Discriminated union of all actions. */
export const HealthAction = Schema.Union(SetHealthAction, SetErrorAction)

/** Type for the health action. */
export type HealthAction = typeof HealthAction.Type

// =============================================================================
// Reducer
// =============================================================================

/** Pure reducer for health state transitions. */
export const healthReducer = (_input: {
  state: HealthState
  action: HealthAction
}): HealthState => {
  const { action } = _input
  switch (action._tag) {
    case 'SetHealth':
      return {
        _tag: 'Success',
        components: action.components,
        allHealthy: action.allHealthy,
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
export const createInitialHealthState = (): HealthState => ({
  _tag: 'Loading',
  message: 'Checking OTEL stack health...',
})
