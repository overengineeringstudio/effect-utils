/**
 * Genie CLI Schema
 *
 * Effect Schema definitions for the genie command output.
 * Supports progress tracking (TTY) and final output (all modes).
 */

import { Schema } from 'effect'

// =============================================================================
// File Status
// =============================================================================

/** Schema for file processing status values */
export const GenieFileStatus = Schema.Literal(
  'pending',
  'active',
  'created',
  'updated',
  'unchanged',
  'skipped',
  'error',
)
/** File processing status */
export type GenieFileStatus = Schema.Schema.Type<typeof GenieFileStatus>

// =============================================================================
// File Entry
// =============================================================================

/** Schema for a genie file entry */
export const GenieFile = Schema.Struct({
  /** Full path to the target file */
  path: Schema.String,
  /** Path relative to cwd for display */
  relativePath: Schema.String,
  /** Current status */
  status: GenieFileStatus,
  /** Optional message (error message or diff summary like "+2 lines") */
  message: Schema.optional(Schema.String),
})
/** File entry with path and status */
export type GenieFile = Schema.Schema.Type<typeof GenieFile>

// =============================================================================
// Summary
// =============================================================================

/** Schema for genie operation summary counts */
export const GenieSummary = Schema.Struct({
  created: Schema.Number,
  updated: Schema.Number,
  unchanged: Schema.Number,
  skipped: Schema.Number,
  failed: Schema.Number,
})
/** Summary counts for genie operation */
export type GenieSummary = Schema.Schema.Type<typeof GenieSummary>

// =============================================================================
// Phase
// =============================================================================

/** Schema for genie operation phases */
export const GeniePhase = Schema.Literal('discovering', 'generating', 'complete', 'error')
/** Genie operation phase */
export type GeniePhase = Schema.Schema.Type<typeof GeniePhase>

// =============================================================================
// Mode
// =============================================================================

/** Schema for genie operation modes */
export const GenieMode = Schema.Literal('generate', 'check', 'dry-run')
/** Genie operation mode */
export type GenieMode = Schema.Schema.Type<typeof GenieMode>

// =============================================================================
// State
// =============================================================================

/**
 * Unified state for genie command.
 *
 * Supports both:
 * - TTY progress mode: shows spinners, live updates via `phase`, `files`
 * - Final output mode: shows results summary via `summary`
 */
export const GenieState = Schema.Struct({
  /** Current phase */
  phase: GeniePhase,

  /** Operation mode */
  mode: GenieMode,

  /** Working directory */
  cwd: Schema.String,

  /** Watch cycle number (for watch mode) */
  watchCycle: Schema.optional(Schema.Number),

  /** All files being processed */
  files: Schema.Array(GenieFile),

  /** Summary counts (populated at completion) */
  summary: Schema.optional(GenieSummary),

  /** Global error message */
  error: Schema.optional(Schema.String),
})
/** Genie state type */
export type GenieState = Schema.Schema.Type<typeof GenieState>

// =============================================================================
// Actions
// =============================================================================

/** Schema for genie state actions */
export const GenieAction = Schema.Union(
  /** Replace entire state */
  Schema.TaggedStruct('SetState', { state: GenieState }),

  /** Files discovered - initialize file list */
  Schema.TaggedStruct('FilesDiscovered', {
    files: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        relativePath: Schema.String,
      }),
    ),
  }),

  /** File processing started */
  Schema.TaggedStruct('FileStarted', { path: Schema.String }),

  /** File processing completed */
  Schema.TaggedStruct('FileCompleted', {
    path: Schema.String,
    status: GenieFileStatus,
    message: Schema.optional(Schema.String),
  }),

  /** All files processed successfully */
  Schema.TaggedStruct('Complete', { summary: GenieSummary }),

  /** Global error occurred */
  Schema.TaggedStruct('Error', { message: Schema.String }),

  /** Watch mode - reset for new cycle */
  Schema.TaggedStruct('WatchReset', {}),
)
/** Genie state action type */
export type GenieAction = Schema.Schema.Type<typeof GenieAction>

// =============================================================================
// Reducer
// =============================================================================

/** Reducer function for genie state */
export const genieReducer = ({
  state,
  action,
}: {
  state: GenieState
  action: GenieAction
}): GenieState => {
  switch (action._tag) {
    case 'SetState':
      return action.state

    case 'FilesDiscovered':
      return {
        ...state,
        phase: 'generating',
        files: action.files.map((f) => ({
          path: f.path,
          relativePath: f.relativePath,
          status: 'pending' as const,
        })),
      }

    case 'FileStarted':
      return {
        ...state,
        files: state.files.map((f) =>
          f.path === action.path ? { ...f, status: 'active' as const } : f,
        ),
      }

    case 'FileCompleted':
      return {
        ...state,
        files: state.files.map((f) =>
          f.path === action.path ? { ...f, status: action.status, message: action.message } : f,
        ),
      }

    case 'Complete':
      return {
        ...state,
        phase: 'complete',
        summary: action.summary,
      }

    case 'Error':
      return {
        ...state,
        phase: 'error',
        error: action.message,
      }

    case 'WatchReset':
      return {
        ...state,
        phase: 'discovering',
        files: [],
        summary: undefined,
        error: undefined,
        watchCycle: (state.watchCycle ?? 0) + 1,
      }
  }
}

// =============================================================================
// Initial State Factory
// =============================================================================

/** Creates initial genie state with given cwd and mode */
export const createInitialGenieState = (params: { cwd: string; mode: GenieMode }): GenieState => ({
  phase: 'discovering',
  mode: params.mode,
  cwd: params.cwd,
  files: [],
})
