/**
 * DepsOutput Schema
 *
 * Effect Schema definitions for the deps command output.
 * Supports success, empty, and error states.
 */

import { Schema } from 'effect'

// =============================================================================
// Downstream Reference
// =============================================================================

/** A downstream member that depends on an upstream member, with the files that reference it. */
export const DownstreamRef = Schema.Struct({
  name: Schema.String,
  files: Schema.Array(Schema.String),
})

/** Inferred type for a downstream member reference with its source files */
export type DownstreamRef = Schema.Schema.Type<typeof DownstreamRef>

// =============================================================================
// Deps Member (upstream with its downstream dependents)
// =============================================================================

/** An upstream member and the downstream members that depend on it. */
export const DepsMember = Schema.Struct({
  name: Schema.String,
  downstreamMembers: Schema.Array(DownstreamRef),
})

/** Inferred type for an upstream member and its downstream dependents */
export type DepsMember = Schema.Schema.Type<typeof DepsMember>

// =============================================================================
// Deps State (Union of success, empty, and error)
// =============================================================================

/** State when dependency graph was successfully computed */
export const DepsSuccessState = Schema.TaggedStruct('Success', {
  members: Schema.Array(DepsMember),
})

/** State when no inter-member dependencies exist */
export const DepsEmptyState = Schema.TaggedStruct('Empty', {})

/** State when dependency graph computation failed */
export const DepsErrorState = Schema.TaggedStruct('Error', {
  message: Schema.String,
})

export const DepsState = Schema.Union(DepsSuccessState, DepsEmptyState, DepsErrorState)

export type DepsState = typeof DepsState.Type

// =============================================================================
// Type Guards
// =============================================================================

export const isDepsSuccess = (state: DepsState): state is typeof DepsSuccessState.Type =>
  state._tag === 'Success'

export const isDepsEmpty = (state: DepsState): state is typeof DepsEmptyState.Type =>
  state._tag === 'Empty'

export const isDepsError = (state: DepsState): state is typeof DepsErrorState.Type =>
  state._tag === 'Error'

// =============================================================================
// Deps Actions
// =============================================================================

export const DepsAction = Schema.Union(
  Schema.TaggedStruct('SetDeps', {
    members: Schema.Array(DepsMember),
  }),
  Schema.TaggedStruct('SetEmpty', {}),
  Schema.TaggedStruct('SetError', { message: Schema.String }),
)

export type DepsAction = Schema.Schema.Type<typeof DepsAction>

// =============================================================================
// Reducer
// =============================================================================

export const depsReducer = ({
  state: _state,
  action,
}: {
  state: DepsState
  action: DepsAction
}): DepsState => {
  switch (action._tag) {
    case 'SetDeps':
      return { _tag: 'Success', members: action.members }
    case 'SetEmpty':
      return { _tag: 'Empty' }
    case 'SetError':
      return { _tag: 'Error', message: action.message }
  }
}
