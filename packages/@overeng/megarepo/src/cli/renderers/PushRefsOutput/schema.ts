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

export const RefUpdateSchema = Schema.Struct({
  nestedMember: Schema.String,
  sharedMemberName: Schema.String,
  oldSource: Schema.String,
  newSource: Schema.String,
})

export const NestedResultSchema = Schema.Struct({
  name: Schema.String,
  updates: Schema.Array(RefUpdateSchema),
  hasGenie: Schema.Boolean,
})

// =============================================================================
// States
// =============================================================================

export const PushRefsIdleState = Schema.TaggedStruct('Idle', {})

export const PushRefsScanningState = Schema.TaggedStruct('Scanning', {})

/** All nested megarepo refs already match the parent */
export const PushRefsAlignedState = Schema.TaggedStruct('Aligned', {})

/** Refs were propagated (or would be in dry-run) */
export const PushRefsResultState = Schema.TaggedStruct('Result', {
  results: Schema.Array(NestedResultSchema),
  totalUpdates: Schema.Number,
  dryRun: Schema.Boolean,
})

export const PushRefsErrorState = Schema.TaggedStruct('Error', {
  error: Schema.String,
  message: Schema.String,
})

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
