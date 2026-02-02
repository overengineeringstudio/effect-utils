/**
 * SyncOutput Schema
 *
 * Effect Schema definitions for the sync command output.
 * Unified schema for both progress tracking (TTY) and final output (all modes).
 */

import { Schema } from 'effect'

import { MemberSyncResult, SyncOptions } from '../../../lib/sync/schema.ts'

// =============================================================================
// Sync Phase
// =============================================================================

/** Schema for the current phase of a sync operation. */
export const SyncPhase = Schema.Literal('idle', 'syncing', 'complete', 'interrupted')
/** Inferred type for sync phase literals. */
export type SyncPhase = Schema.Schema.Type<typeof SyncPhase>

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
 * - TTY progress mode: shows spinners, live updates via `phase`, `members`, `activeMember`
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
  /** Workspace info */
  workspace: Schema.Struct({
    name: Schema.String,
    root: Schema.String,
  }),

  /** Sync options/flags */
  options: SyncOptions,

  /** Current sync phase */
  phase: SyncPhase,

  /** All member names being synced (populated at start for progress tracking) */
  members: Schema.Array(Schema.String),

  /** Currently syncing member (for spinner display) */
  activeMember: Schema.optional(Schema.String),

  /** Sync results for each member (populated progressively) */
  results: Schema.Array(MemberSyncResult),

  /** Log entries (for TTY progress display) */
  logs: Schema.Array(SyncLogEntry),

  /** Timestamp when sync started */
  startedAt: Schema.optional(Schema.Number),

  /** Members that are themselves megarepos (for --all hint) */
  nestedMegarepos: Schema.Array(Schema.String),

  /** List of generated file paths */
  generatedFiles: Schema.Array(Schema.String),
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
    name: Schema.optional(Schema.String),
  }),

  /** Add a completed member result */
  Schema.TaggedStruct('AddResult', { result: MemberSyncResult }),

  /** Add a log entry */
  Schema.TaggedStruct('AddLog', {
    type: Schema.Literal('info', 'warn', 'error'),
    message: Schema.String,
  }),

  /** Mark sync as complete */
  Schema.TaggedStruct('Complete', {
    nestedMegarepos: Schema.Array(Schema.String),
    generatedFiles: Schema.Array(Schema.String),
  }),

  /** Handle interruption (Ctrl+C) */
  Schema.TaggedStruct('Interrupted', {}),
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
        phase: 'syncing',
        members: action.members,
        results: [],
        logs: [],
        startedAt: Date.now(),
      }

    case 'SetActiveMember':
      return {
        ...state,
        activeMember: action.name,
      }

    case 'AddResult':
      return {
        ...state,
        results: [...state.results, action.result],
        // Clear active member if this was the active one
        activeMember: state.activeMember === action.result.name ? undefined : state.activeMember,
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

    case 'Complete':
      return {
        ...state,
        phase: 'complete',
        activeMember: undefined,
        nestedMegarepos: action.nestedMegarepos,
        generatedFiles: action.generatedFiles,
      }

    case 'Interrupted':
      return {
        ...state,
        phase: 'interrupted',
        activeMember: undefined,
      }
  }
}
