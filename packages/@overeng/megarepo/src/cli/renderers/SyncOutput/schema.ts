/**
 * SyncOutput Schema
 *
 * Effect Schema definitions for the sync command output.
 * Unified schema for both progress tracking (TTY) and final output (all modes).
 */

import { Schema } from 'effect'

import {
  MemberSyncResult,
  SyncErrorItem,
  SyncOptions,
  MegarepoSyncTree,
} from '../../../lib/sync/schema.ts'

// =============================================================================
// Pre-flight Hygiene Issue (for display)
// =============================================================================

/** Schema for a store hygiene issue shown in pre-flight failure output */
export const PreflightIssue = Schema.Struct({
  severity: Schema.Literal('error', 'warning', 'info'),
  type: Schema.String,
  memberName: Schema.String,
  message: Schema.String,
  fix: Schema.optional(Schema.String),
})
export type PreflightIssue = Schema.Schema.Type<typeof PreflightIssue>

// =============================================================================
// Lock Sync Result (for TUI display)
// =============================================================================

/** Rev (commit) update — mechanical propagation of resolved commit SHAs */
export const LockRevUpdate = Schema.Struct({
  _tag: Schema.Literal('RevUpdate'),
  inputName: Schema.String,
  memberName: Schema.String,
  oldRev: Schema.String,
  newRev: Schema.String,
})
/** Inferred type for a rev update */
export type LockRevUpdate = Schema.Schema.Type<typeof LockRevUpdate>

/** Ref (branch) update — intentional branch/input URL change */
export const LockRefUpdate = Schema.Struct({
  _tag: Schema.Literal('RefUpdate'),
  inputName: Schema.String,
  memberName: Schema.String,
  oldRef: Schema.String,
  newRef: Schema.String,
})
/** Inferred type for a ref update */
export type LockRefUpdate = Schema.Schema.Type<typeof LockRefUpdate>

/** Shared lock source update — e.g. devenv version propagated from source member */
export const LockSharedSourceUpdate = Schema.Struct({
  _tag: Schema.Literal('SharedSourceUpdate'),
  sourceName: Schema.String,
  sourceMemberName: Schema.String,
  targetCount: Schema.Number,
})
/** Inferred type for a shared source update */
export type LockSharedSourceUpdate = Schema.Schema.Type<typeof LockSharedSourceUpdate>

/** Union of rev and ref update types (used in lock file sync results) */
export const LockFileUpdate = Schema.Union(LockRevUpdate, LockRefUpdate)
/** Inferred type for a lock file update (rev or ref) */
export type LockFileUpdate = Schema.Schema.Type<typeof LockFileUpdate>

/** Union of all lock sync update types */
export const LockSyncUpdate = Schema.Union(LockRevUpdate, LockRefUpdate, LockSharedSourceUpdate)
/** Inferred type for any lock sync update (rev, ref, or shared source) */
export type LockSyncUpdate = Schema.Schema.Type<typeof LockSyncUpdate>

/** Schema for lock file sync result */
export const LockFileSyncResult = Schema.Struct({
  type: Schema.Literal('flake.lock', 'devenv.lock', 'megarepo.lock', 'flake.nix', 'devenv.yaml'),
  updatedInputs: Schema.Array(LockFileUpdate),
})
/** Inferred type for a lock file sync result. */
export type LockFileSyncResult = Schema.Schema.Type<typeof LockFileSyncResult>

/** Schema for member lock sync result */
export const MemberLockSyncResult = Schema.Struct({
  /** Name of the megarepo member */
  memberName: Schema.String,
  /** Lock files synced in this member */
  files: Schema.Array(LockFileSyncResult),
})
/** Inferred type for a member's lock sync result. */
export type MemberLockSyncResult = Schema.Schema.Type<typeof MemberLockSyncResult>

// =============================================================================
// Sync Outcome
// =============================================================================

/** Schema for the sync command outcome/progress state. */
export const SyncOutcome = Schema.Literal(
  'Syncing',
  'Success',
  'Error',
  'Interrupted',
  'PreflightFailed',
)
/** Inferred type for sync outcome literals. */
export type SyncOutcome = Schema.Schema.Type<typeof SyncOutcome>

// =============================================================================
// Log Entry (for TTY progress display)
// =============================================================================

/** Schema for a log entry displayed during TTY progress output. */
export const SyncLogEntry = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal('info', 'warn', 'error'),
  message: Schema.String,
})
/** Inferred type for a sync log entry. */
export type SyncLogEntry = Schema.Schema.Type<typeof SyncLogEntry>

// =============================================================================
// Sync State
// =============================================================================

/**
 * Unified state for sync command.
 *
 * Supports both:
 * - TTY progress mode: shows spinners, live updates via `phase`, `members`, `activeMembers`
 * - Final output mode: shows results summary via `results`
 *
 * JSON output structure:
 * ```json
 * {
 *   "workspace": { "name": "...", "root": "..." },
 *   "options": { "dryRun": false, ... },
 *   "phase": "complete",
 *   "results": [...],
 *   "nestedMegarepos": [...],
 *   "generatedFiles": [...]
 * }
 * ```
 */
export const SyncState = Schema.Struct({
  /** Sync outcome/progress state. */
  _tag: SyncOutcome,

  /** Workspace info */
  workspace: Schema.Struct({
    name: Schema.String,
    root: Schema.String,
  }),

  /** Sync options/flags */
  options: SyncOptions,

  /** All member names being synced (populated at start for progress tracking) */
  members: Schema.Array(Schema.String),

  /** Currently syncing members (for spinner display, supports parallel sync) */
  activeMembers: Schema.Array(Schema.String),

  /** Sync results for each member (populated progressively) */
  results: Schema.Array(MemberSyncResult),

  /** Log entries (for TTY progress display) */
  logs: Schema.Array(SyncLogEntry),

  /** Timestamp when sync started */
  startedAt: Schema.NullOr(Schema.Number),

  /** Members that are themselves megarepos (for --all hint) */
  nestedMegarepos: Schema.Array(Schema.String),

  /** List of generated file paths */
  generatedFiles: Schema.Array(Schema.String),

  /** Lock sync results (flake.lock/devenv.lock updates) */
  lockSyncResults: Schema.Array(MemberLockSyncResult),

  /** Shared lock source updates (e.g. devenv version propagation) */
  sharedSourceUpdates: Schema.Array(LockSharedSourceUpdate),

  /** Full nested sync tree (includes nested megarepos when --all is used). */
  syncTree: MegarepoSyncTree,

  /** Flattened list of all sync errors (root + nested). */
  syncErrors: Schema.Array(SyncErrorItem),

  /** Total number of sync errors (root + nested). */
  syncErrorCount: Schema.Number,

  /** Pre-flight hygiene issues (populated when _tag === 'PreflightFailed') */
  preflightIssues: Schema.Array(PreflightIssue),
})

/** Inferred type for sync command state including workspace, options, phase, and results. */
export type SyncState = Schema.Schema.Type<typeof SyncState>

// =============================================================================
// Sync Actions
// =============================================================================

let logIdCounter = 0

/** Tagged union of actions for progressing through a sync operation. */
export const SyncAction = Schema.Union(
  /** Replace entire state */
  Schema.TaggedStruct('SetState', { state: SyncState }),

  /** Start syncing - initialize members list */
  Schema.TaggedStruct('StartSync', {
    members: Schema.Array(Schema.String),
  }),

  /** Set the currently active member (for spinner) */
  Schema.TaggedStruct('SetActiveMember', {
    name: Schema.String,
  }),

  /** Add a completed member result */
  Schema.TaggedStruct('AddResult', { result: MemberSyncResult }),

  /** Add a log entry */
  Schema.TaggedStruct('AddLog', {
    type: Schema.Literal('info', 'warn', 'error'),
    message: Schema.String,
  }),

  /** Set lock sync results */
  Schema.TaggedStruct('SetLockSyncResults', {
    results: Schema.Array(MemberLockSyncResult),
  }),

  /** Set shared lock source updates */
  Schema.TaggedStruct('SetSharedSourceUpdates', {
    updates: Schema.Array(LockSharedSourceUpdate),
  }),

  /** Mark sync as complete */
  Schema.TaggedStruct('Complete', {
    nestedMegarepos: Schema.Array(Schema.String),
    generatedFiles: Schema.Array(Schema.String),
  }),

  /** Handle interruption (Ctrl+C) */
  Schema.TaggedStruct('Interrupted', {}),

  /** Set pre-flight failure state */
  Schema.TaggedStruct('PreflightFailed', {
    issues: Schema.Array(PreflightIssue),
  }),
)

/** Inferred type for sync actions. */
export type SyncAction = Schema.Schema.Type<typeof SyncAction>

// =============================================================================
// Reducer
// =============================================================================

/** Reduces sync actions into state, managing phases, results, logs, and active member. */
export const syncReducer = ({
  state,
  action,
}: {
  state: SyncState
  action: SyncAction
}): SyncState => {
  switch (action._tag) {
    case 'SetState':
      return action.state

    case 'StartSync':
      return {
        ...state,
        _tag: 'Syncing',
        members: action.members,
        activeMembers: [],
        results: [],
        logs: [],
        startedAt: Date.now(),
        syncTree: {
          root: state.workspace.root,
          results: [],
          nestedMegarepos: [],
          nestedResults: [],
        },
        syncErrors: [],
        syncErrorCount: 0,
      }

    case 'SetActiveMember':
      return {
        ...state,
        activeMembers:
          state.activeMembers.includes(action.name) === true
            ? state.activeMembers
            : [...state.activeMembers, action.name],
      }

    case 'AddResult':
      return {
        ...state,
        results: [...state.results, action.result],
        activeMembers: state.activeMembers.filter((m) => m !== action.result.name),
        syncErrors:
          action.result.status === 'error'
            ? [
                ...state.syncErrors,
                {
                  megarepoRoot: state.workspace.root,
                  memberName: action.result.name,
                  message: action.result.message ?? null,
                },
              ]
            : state.syncErrors,
        syncErrorCount:
          action.result.status === 'error' ? state.syncErrorCount + 1 : state.syncErrorCount,
      }

    case 'AddLog':
      return {
        ...state,
        logs: [
          ...state.logs,
          {
            id: `log-${++logIdCounter}`,
            type: action.type,
            message: action.message,
          },
        ],
      }

    case 'SetLockSyncResults':
      return {
        ...state,
        lockSyncResults: action.results,
      }

    case 'SetSharedSourceUpdates':
      return {
        ...state,
        sharedSourceUpdates: action.updates,
      }

    case 'Complete':
      return {
        ...state,
        _tag: state.syncErrorCount > 0 ? 'Error' : 'Success',
        activeMembers: [],
        nestedMegarepos: action.nestedMegarepos,
        generatedFiles: action.generatedFiles,
      }

    case 'Interrupted':
      return {
        ...state,
        _tag: 'Interrupted',
        activeMembers: [],
      }

    case 'PreflightFailed':
      return {
        ...state,
        _tag: 'PreflightFailed',
        activeMembers: [],
        preflightIssues: action.issues,
      }
  }
}
