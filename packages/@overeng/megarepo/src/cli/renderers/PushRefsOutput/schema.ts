/**
 * PushRefsOutput Schema
 *
 * Effect Schema definitions for the `mr config push-refs` command output.
 * Tracks ref propagation from parent to nested megarepo configs.
 */

import { Schema } from 'effect'

// =============================================================================
// Nested types
// =============================================================================

/** Schema for a single ref source change on a nested member */
export const RefUpdateSchema = Schema.Struct({
  nestedMember: Schema.String,
  sharedMemberName: Schema.String,
  oldSource: Schema.String,
  newSource: Schema.String,
})

/** Schema for aggregated ref updates within a single nested megarepo */
export const NestedResultSchema = Schema.Struct({
  name: Schema.String,
  updates: Schema.Array(RefUpdateSchema),
  hasGenie: Schema.Boolean,
})

// =============================================================================
// States
// =============================================================================

/** Initial state before any scanning has started */
export const PushRefsIdleState = Schema.TaggedStruct('Idle', {})

/** State while scanning nested megarepo configs */
export const PushRefsScanningState = Schema.TaggedStruct('Scanning', {})

/** All nested megarepo refs already match the parent */
export const PushRefsAlignedState = Schema.TaggedStruct('Aligned', {})

/** Refs were propagated (or would be in dry-run) */
export const PushRefsResultState = Schema.TaggedStruct('Result', {
  results: Schema.Array(NestedResultSchema),
  totalUpdates: Schema.Number,
  dryRun: Schema.Boolean,
})

/** Terminal error state with error details */
export const PushRefsErrorState = Schema.TaggedStruct('Error', {
  error: Schema.String,
  message: Schema.String,
})

/** Union of all possible push-refs TUI states */
export const PushRefsState = Schema.Union(
  PushRefsIdleState,
  PushRefsScanningState,
  PushRefsAlignedState,
  PushRefsResultState,
  PushRefsErrorState,
)

export type PushRefsState = typeof PushRefsState.Type

// =============================================================================
// Actions
// =============================================================================

/** Union of all actions dispatched to the push-refs reducer */
export const PushRefsAction = Schema.Union(
  Schema.TaggedStruct('SetScanning', {}),
  Schema.TaggedStruct('SetAligned', {}),
  Schema.TaggedStruct('SetResult', {
    results: Schema.Array(NestedResultSchema),
    totalUpdates: Schema.Number,
    dryRun: Schema.Boolean,
  }),
  Schema.TaggedStruct('SetError', {
    error: Schema.String,
    message: Schema.String,
  }),
)

export type PushRefsAction = typeof PushRefsAction.Type

// =============================================================================
// Reducer
// =============================================================================

/** Pure state transition function for push-refs actions */
export const pushRefsReducer = ({
  state: _state,
  action,
}: {
  state: PushRefsState
  action: PushRefsAction
}): PushRefsState => {
  switch (action._tag) {
    case 'SetScanning':
      return { _tag: 'Scanning' }
    case 'SetAligned':
      return { _tag: 'Aligned' }
    case 'SetResult':
      return {
        _tag: 'Result',
        results: action.results,
        totalUpdates: action.totalUpdates,
        dryRun: action.dryRun,
      }
    case 'SetError':
      return { _tag: 'Error', error: action.error, message: action.message }
  }
}
