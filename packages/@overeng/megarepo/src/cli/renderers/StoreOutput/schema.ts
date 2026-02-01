/**
 * StoreOutput Schema
 *
 * Effect Schema definitions for all store command outputs.
 * Uses tagged union for different subcommand states.
 */

import { Schema } from 'effect'

// =============================================================================
// Common Types
// =============================================================================

export const StoreRepo = Schema.Struct({
  relativePath: Schema.String,
})

export type StoreRepo = Schema.Schema.Type<typeof StoreRepo>

export const StoreFetchResult = Schema.Struct({
  path: Schema.String,
  status: Schema.Literal('fetched', 'error'),
  message: Schema.optional(Schema.String),
})

export type StoreFetchResult = Schema.Schema.Type<typeof StoreFetchResult>

export const StoreGcResult = Schema.Struct({
  repo: Schema.String,
  ref: Schema.String,
  path: Schema.String,
  status: Schema.Literal('removed', 'skipped_dirty', 'skipped_in_use', 'error'),
  message: Schema.optional(Schema.String),
})

export type StoreGcResult = Schema.Schema.Type<typeof StoreGcResult>

export const StoreWorktreeIssue = Schema.Struct({
  type: Schema.Literal('dirty', 'unpushed', 'ref_mismatch', 'missing_bare', 'broken_worktree', 'orphaned'),
  severity: Schema.Literal('error', 'warning', 'info'),
  message: Schema.String,
})

export type StoreWorktreeIssue = Schema.Schema.Type<typeof StoreWorktreeIssue>

export const StoreWorktreeStatus = Schema.Struct({
  repo: Schema.String,
  ref: Schema.String,
  refType: Schema.Literal('heads', 'tags', 'commits'),
  path: Schema.String,
  issues: Schema.Array(StoreWorktreeIssue),
})

export type StoreWorktreeStatus = Schema.Schema.Type<typeof StoreWorktreeStatus>

export const StoreGcWarning = Schema.Struct({
  type: Schema.Literal('not_in_megarepo', 'only_current_megarepo', 'custom'),
  message: Schema.optional(Schema.String),
})

export type StoreGcWarning = Schema.Schema.Type<typeof StoreGcWarning>

// =============================================================================
// Store State (Union of all subcommand states)
// =============================================================================

/**
 * Ls state - list repos in store
 */
export const StoreLsState = Schema.TaggedStruct('Ls', {
  basePath: Schema.String,
  repos: Schema.Array(StoreRepo),
})

/**
 * Status state - show worktree status
 */
export const StoreStatusState = Schema.TaggedStruct('Status', {
  basePath: Schema.String,
  repoCount: Schema.Number,
  worktreeCount: Schema.Number,
  diskUsage: Schema.optional(Schema.String),
  worktrees: Schema.Array(StoreWorktreeStatus),
})

/**
 * Fetch state - fetch updates
 */
export const StoreFetchState = Schema.TaggedStruct('Fetch', {
  basePath: Schema.String,
  results: Schema.Array(StoreFetchResult),
  elapsedMs: Schema.Number,
})

/**
 * GC state - garbage collection
 */
export const StoreGcState = Schema.TaggedStruct('Gc', {
  basePath: Schema.String,
  results: Schema.Array(StoreGcResult),
  dryRun: Schema.Boolean,
  warning: Schema.optional(StoreGcWarning),
  showForceHint: Schema.Boolean,
})

/**
 * Add state - add to store
 */
export const StoreAddState = Schema.TaggedStruct('Add', {
  status: Schema.Literal('added', 'already_exists'),
  source: Schema.String,
  ref: Schema.String,
  commit: Schema.optional(Schema.String),
  path: Schema.String,
})

/**
 * Error state - any store command error
 */
export const StoreErrorState = Schema.TaggedStruct('Error', {
  error: Schema.String,
  message: Schema.String,
  source: Schema.optional(Schema.String),
})

/**
 * State for all store commands - discriminated by _tag property.
 */
export const StoreState = Schema.Union(
  StoreLsState,
  StoreStatusState,
  StoreFetchState,
  StoreGcState,
  StoreAddState,
  StoreErrorState,
)

export type StoreState = typeof StoreState.Type

// =============================================================================
// Type Guards
// =============================================================================

export const isStoreError = (state: StoreState): state is typeof StoreErrorState.Type =>
  state._tag === 'Error'

export const isStoreLs = (state: StoreState): state is typeof StoreLsState.Type =>
  state._tag === 'Ls'

export const isStoreStatus = (state: StoreState): state is typeof StoreStatusState.Type =>
  state._tag === 'Status'

export const isStoreFetch = (state: StoreState): state is typeof StoreFetchState.Type =>
  state._tag === 'Fetch'

export const isStoreGc = (state: StoreState): state is typeof StoreGcState.Type =>
  state._tag === 'Gc'

export const isStoreAdd = (state: StoreState): state is typeof StoreAddState.Type =>
  state._tag === 'Add'

// =============================================================================
// Store Actions
// =============================================================================

/**
 * Actions for store output.
 */
export const StoreAction = Schema.Union(
  Schema.TaggedStruct('SetLs', {
    basePath: Schema.String,
    repos: Schema.Array(StoreRepo),
  }),
  Schema.TaggedStruct('SetStatus', {
    basePath: Schema.String,
    repoCount: Schema.Number,
    worktreeCount: Schema.Number,
    diskUsage: Schema.optional(Schema.String),
    worktrees: Schema.Array(StoreWorktreeStatus),
  }),
  Schema.TaggedStruct('SetFetch', {
    basePath: Schema.String,
    results: Schema.Array(StoreFetchResult),
    elapsedMs: Schema.Number,
  }),
  Schema.TaggedStruct('SetGc', {
    basePath: Schema.String,
    results: Schema.Array(StoreGcResult),
    dryRun: Schema.Boolean,
    warning: Schema.optional(StoreGcWarning),
    showForceHint: Schema.Boolean,
  }),
  Schema.TaggedStruct('SetAdd', {
    status: Schema.Literal('added', 'already_exists'),
    source: Schema.String,
    ref: Schema.String,
    commit: Schema.optional(Schema.String),
    path: Schema.String,
  }),
  Schema.TaggedStruct('SetError', {
    error: Schema.String,
    message: Schema.String,
    source: Schema.optional(Schema.String),
  }),
)

export type StoreAction = Schema.Schema.Type<typeof StoreAction>

// =============================================================================
// Reducer
// =============================================================================

export const storeReducer = ({
  state: _state,
  action,
}: {
  state: StoreState
  action: StoreAction
}): StoreState => {
  switch (action._tag) {
    case 'SetLs':
      return { _tag: 'Ls', basePath: action.basePath, repos: action.repos }
    case 'SetStatus':
      return {
        _tag: 'Status',
        basePath: action.basePath,
        repoCount: action.repoCount,
        worktreeCount: action.worktreeCount,
        diskUsage: action.diskUsage,
        worktrees: action.worktrees,
      }
    case 'SetFetch':
      return {
        _tag: 'Fetch',
        basePath: action.basePath,
        results: action.results,
        elapsedMs: action.elapsedMs,
      }
    case 'SetGc':
      return {
        _tag: 'Gc',
        basePath: action.basePath,
        results: action.results,
        dryRun: action.dryRun,
        warning: action.warning,
        showForceHint: action.showForceHint,
      }
    case 'SetAdd':
      return {
        _tag: 'Add',
        status: action.status,
        source: action.source,
        ref: action.ref,
        commit: action.commit,
        path: action.path,
      }
    case 'SetError':
      return {
        _tag: 'Error',
        error: action.error,
        message: action.message,
        source: action.source,
      }
  }
}
