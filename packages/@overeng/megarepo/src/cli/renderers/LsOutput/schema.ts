/**
 * LsOutput Schema
 *
 * Effect Schema definitions for the ls command output.
 * Supports both success and error states with clean JSON output.
 */

import { Schema } from 'effect'

// =============================================================================
// Member Owner (tagged union)
// =============================================================================

/** Member belongs to the root megarepo */
export const MemberOwnerRoot = Schema.TaggedStruct('Root', {})

/** Member belongs to a nested megarepo */
export const MemberOwnerNested = Schema.TaggedStruct('Nested', {
  /** Path to the owning megarepo (non-empty) */
  path: Schema.NonEmptyArray(Schema.String),
})

/** Discriminated union for member ownership */
export const MemberOwner = Schema.Union(MemberOwnerRoot, MemberOwnerNested)

export type MemberOwner = Schema.Schema.Type<typeof MemberOwner>

// =============================================================================
// Member Info
// =============================================================================

export const MemberInfo = Schema.Struct({
  /** Member name */
  name: Schema.String,
  /** Source string (e.g., "github:org/repo" or "../path") */
  source: Schema.String,
  /** Which megarepo owns this member */
  owner: MemberOwner,
  /** Is this member itself a megarepo? */
  isMegarepo: Schema.Boolean,
})

export type MemberInfo = Schema.Schema.Type<typeof MemberInfo>

// =============================================================================
// Ls State (Union of success and error)
// =============================================================================

/**
 * Success state - JSON output: { "_tag": "Success", "members": [...], "all": false }
 */
export const LsSuccessState = Schema.TaggedStruct('Success', {
  members: Schema.Array(MemberInfo),
  /** Whether --all was used (for context in output) */
  all: Schema.Boolean,
  /** Name of the root megarepo */
  megarepoName: Schema.String,
})

/**
 * Error state - JSON output: { "_tag": "Error", "error": "...", "message": "..." }
 */
export const LsErrorState = Schema.TaggedStruct('Error', {
  error: Schema.String,
  message: Schema.String,
})

/**
 * State for ls command - discriminated by _tag property.
 *
 * Success JSON: { "_tag": "Success", "members": [...] }
 * Error JSON: { "_tag": "Error", "error": "...", "message": "..." }
 */
export const LsState = Schema.Union(LsSuccessState, LsErrorState)

export type LsState = typeof LsState.Type

// =============================================================================
// Type Guards
// =============================================================================

export const isLsError = (state: LsState): state is typeof LsErrorState.Type =>
  state._tag === 'Error'

export const isLsSuccess = (state: LsState): state is typeof LsSuccessState.Type =>
  state._tag === 'Success'

// =============================================================================
// Ls Actions
// =============================================================================

/**
 * Actions for ls output.
 */
export const LsAction = Schema.Union(
  Schema.TaggedStruct('SetMembers', {
    members: Schema.Array(MemberInfo),
    all: Schema.Boolean,
    megarepoName: Schema.String,
  }),
  Schema.TaggedStruct('SetError', { error: Schema.String, message: Schema.String }),
)

export type LsAction = Schema.Schema.Type<typeof LsAction>

// =============================================================================
// Reducer
// =============================================================================

export const lsReducer = ({
  state: _state,
  action,
}: {
  state: LsState
  action: LsAction
}): LsState => {
  switch (action._tag) {
    case 'SetMembers':
      return {
        _tag: 'Success',
        members: action.members,
        all: action.all,
        megarepoName: action.megarepoName,
      }
    case 'SetError':
      return { _tag: 'Error', error: action.error, message: action.message }
  }
}
