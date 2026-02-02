/**
 * AddOutput Schema
 *
 * Effect Schema definitions for the add command output.
 * Supports idle, adding, success, and error states.
 */

import { Schema } from 'effect'

// =============================================================================
// Add State (Union of idle, adding, success, and error)
// =============================================================================

/**
 * Idle state - initial state
 * { "_tag": "Idle" }
 */
export const AddIdleState = Schema.TaggedStruct('Idle', {})

/**
 * Adding state - currently adding a member
 * { "_tag": "Adding", "member": "repo-name", "source": "owner/repo" }
 */
export const AddAddingState = Schema.TaggedStruct('Adding', {
  member: Schema.String,
  source: Schema.String,
})

/**
 * Success state - member added successfully
 * { "_tag": "Success", "member": "repo-name", "source": "owner/repo", "synced": false }
 */
export const AddSuccessState = Schema.TaggedStruct('Success', {
  member: Schema.String,
  source: Schema.String,
  synced: Schema.Boolean,
  syncStatus: Schema.optional(Schema.Literal('cloned', 'synced', 'error')),
})

/**
 * Error state - JSON output: { "_tag": "Error", "error": "...", "message": "..." }
 */
export const AddErrorState = Schema.TaggedStruct('Error', {
  error: Schema.String,
  message: Schema.String,
})

/**
 * State for add command.
 */
export const AddState = Schema.Union(AddIdleState, AddAddingState, AddSuccessState, AddErrorState)

export type AddState = Schema.Schema.Type<typeof AddState>

// =============================================================================
// Type Guards
// =============================================================================

export const isAddError = (state: AddState): state is typeof AddErrorState.Type =>
  state._tag === 'Error'

export const isAddSuccess = (state: AddState): state is typeof AddSuccessState.Type =>
  state._tag === 'Success'

export const isAddIdle = (state: AddState): state is typeof AddIdleState.Type =>
  state._tag === 'Idle'

export const isAddAdding = (state: AddState): state is typeof AddAddingState.Type =>
  state._tag === 'Adding'

// =============================================================================
// Add Actions
// =============================================================================

export const AddAction = Schema.Union(
  Schema.TaggedStruct('SetAdding', { member: Schema.String, source: Schema.String }),
  Schema.TaggedStruct('SetSuccess', {
    member: Schema.String,
    source: Schema.String,
    synced: Schema.Boolean,
    syncStatus: Schema.optional(Schema.Literal('cloned', 'synced', 'error')),
  }),
  Schema.TaggedStruct('SetError', { error: Schema.String, message: Schema.String }),
)

export type AddAction = Schema.Schema.Type<typeof AddAction>

// =============================================================================
// Reducer
// =============================================================================

export const addReducer = ({
  state: _state,
  action,
}: {
  state: AddState
  action: AddAction
}): AddState => {
  switch (action._tag) {
    case 'SetAdding':
      return { _tag: 'Adding', member: action.member, source: action.source }
    case 'SetSuccess':
      return {
        _tag: 'Success',
        member: action.member,
        source: action.source,
        synced: action.synced,
        syncStatus: action.syncStatus,
      }
    case 'SetError':
      return { _tag: 'Error', error: action.error, message: action.message }
  }
}
