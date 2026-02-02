/**
 * PinOutput Schema
 *
 * Effect Schema definitions for the pin/unpin command output.
 * Supports idle, checking, success, and error states.
 */

import { Schema } from 'effect'

// =============================================================================
// Pin State (Union of states for pin/unpin commands)
// =============================================================================

/**
 * Idle state - initial state before any action
 */
export const PinIdleState = Schema.TaggedStruct('Idle', {})

/**
 * Checking state - verifying member before pin/unpin
 */
export const PinCheckingState = Schema.TaggedStruct('Checking', {
  member: Schema.String,
})

/**
 * Success state - JSON output:
 * { "_tag": "Success", "member": "...", "action": "pin"|"unpin", ... }
 */
export const PinSuccessState = Schema.TaggedStruct('Success', {
  member: Schema.String,
  action: Schema.Literal('pin', 'unpin'),
  ref: Schema.optional(Schema.String),
  commit: Schema.optional(Schema.String),
})

/**
 * Already pinned/unpinned state
 */
export const PinAlreadyState = Schema.TaggedStruct('Already', {
  member: Schema.String,
  action: Schema.Literal('pin', 'unpin'),
  commit: Schema.optional(Schema.String),
})

/**
 * Dry run state - shows what would happen without making changes
 */
export const PinDryRunState = Schema.TaggedStruct('DryRun', {
  member: Schema.String,
  action: Schema.Literal('pin', 'unpin'),
  ref: Schema.optional(Schema.String),
  commit: Schema.optional(Schema.String),
  currentSource: Schema.optional(Schema.String),
  newSource: Schema.optional(Schema.String),
  currentSymlink: Schema.optional(Schema.String),
  newSymlink: Schema.optional(Schema.String),
  lockChanges: Schema.optional(Schema.Array(Schema.String)),
  wouldClone: Schema.optional(Schema.Boolean),
  wouldCreateWorktree: Schema.optional(Schema.Boolean),
  worktreeNotAvailable: Schema.optional(Schema.Boolean),
})

/**
 * Warning state - for non-fatal issues
 */
export const PinWarningState = Schema.TaggedStruct('Warning', {
  warning: Schema.Literal('worktree_not_available', 'member_removed_from_config'),
  member: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
})

/**
 * Error state - JSON output: { "_tag": "Error", "error": "...", "message": "..." }
 */
export const PinErrorState = Schema.TaggedStruct('Error', {
  error: Schema.String,
  message: Schema.String,
})

/**
 * State for pin/unpin commands.
 */
export const PinState = Schema.Union(
  PinIdleState,
  PinCheckingState,
  PinSuccessState,
  PinAlreadyState,
  PinDryRunState,
  PinWarningState,
  PinErrorState,
)

/** Inferred type for the pin/unpin command state. */
export type PinState = Schema.Schema.Type<typeof PinState>

// =============================================================================
// Type Guards
// =============================================================================

/** Type guard that checks if the pin state is an error. */
export const isPinError = (state: PinState): state is typeof PinErrorState.Type =>
  state._tag === 'Error'

/** Type guard that checks if the pin state completed successfully. */
export const isPinSuccess = (state: PinState): state is typeof PinSuccessState.Type =>
  state._tag === 'Success'

/** Type guard that checks if the member is already in the desired pin/unpin state. */
export const isPinAlready = (state: PinState): state is typeof PinAlreadyState.Type =>
  state._tag === 'Already'

/** Type guard that checks if the pin state is a dry-run preview. */
export const isPinDryRun = (state: PinState): state is typeof PinDryRunState.Type =>
  state._tag === 'DryRun'

/** Type guard that checks if the pin state contains a non-fatal warning. */
export const isPinWarning = (state: PinState): state is typeof PinWarningState.Type =>
  state._tag === 'Warning'

// =============================================================================
// Pin Actions
// =============================================================================

/** Tagged union of actions for the pin/unpin commands. */
export const PinAction = Schema.Union(
  Schema.TaggedStruct('SetChecking', { member: Schema.String }),
  Schema.TaggedStruct('SetSuccess', {
    member: Schema.String,
    action: Schema.Literal('pin', 'unpin'),
    ref: Schema.optional(Schema.String),
    commit: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct('SetAlready', {
    member: Schema.String,
    action: Schema.Literal('pin', 'unpin'),
    commit: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct('SetDryRun', {
    member: Schema.String,
    action: Schema.Literal('pin', 'unpin'),
    ref: Schema.optional(Schema.String),
    commit: Schema.optional(Schema.String),
    currentSource: Schema.optional(Schema.String),
    newSource: Schema.optional(Schema.String),
    currentSymlink: Schema.optional(Schema.String),
    newSymlink: Schema.optional(Schema.String),
    lockChanges: Schema.optional(Schema.Array(Schema.String)),
    wouldClone: Schema.optional(Schema.Boolean),
    wouldCreateWorktree: Schema.optional(Schema.Boolean),
    worktreeNotAvailable: Schema.optional(Schema.Boolean),
  }),
  Schema.TaggedStruct('SetWarning', {
    warning: Schema.Literal('worktree_not_available', 'member_removed_from_config'),
    member: Schema.optional(Schema.String),
    message: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct('SetError', { error: Schema.String, message: Schema.String }),
)

/** Inferred type for pin/unpin actions. */
export type PinAction = Schema.Schema.Type<typeof PinAction>

// =============================================================================
// Reducer
// =============================================================================

/** Reduces pin actions into state, handling checking, success, already, dry-run, warning, and error. */
export const pinReducer = ({
  state: _state,
  action,
}: {
  state: PinState
  action: PinAction
}): PinState => {
  switch (action._tag) {
    case 'SetChecking':
      return { _tag: 'Checking', member: action.member }
    case 'SetSuccess':
      return {
        _tag: 'Success',
        member: action.member,
        action: action.action,
        ref: action.ref,
        commit: action.commit,
      }
    case 'SetAlready':
      return {
        _tag: 'Already',
        member: action.member,
        action: action.action,
        commit: action.commit,
      }
    case 'SetDryRun':
      return {
        _tag: 'DryRun',
        member: action.member,
        action: action.action,
        ref: action.ref,
        commit: action.commit,
        currentSource: action.currentSource,
        newSource: action.newSource,
        currentSymlink: action.currentSymlink,
        newSymlink: action.newSymlink,
        lockChanges: action.lockChanges,
        wouldClone: action.wouldClone,
        wouldCreateWorktree: action.wouldCreateWorktree,
        worktreeNotAvailable: action.worktreeNotAvailable,
      }
    case 'SetWarning':
      return {
        _tag: 'Warning',
        warning: action.warning,
        member: action.member,
        message: action.message,
      }
    case 'SetError':
      return { _tag: 'Error', error: action.error, message: action.message }
  }
}
