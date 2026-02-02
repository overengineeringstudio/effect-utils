/**
 * StatusOutput Schema
 *
 * Effect Schema definitions for the status command output.
 * Designed for static output - no progressive updates needed.
 */

import { Schema } from 'effect'

// =============================================================================
// Git Status
// =============================================================================

/** Schema for a member's git working tree status (dirty, unpushed, branch info). */
export const GitStatus = Schema.Struct({
  isDirty: Schema.Boolean,
  changesCount: Schema.Number,
  hasUnpushed: Schema.Boolean,
  branch: Schema.optional(Schema.String),
  shortRev: Schema.optional(Schema.String),
})

/** Inferred type for git working tree status. */
export type GitStatus = Schema.Schema.Type<typeof GitStatus>

// =============================================================================
// Symlink Drift
// =============================================================================

/** Schema for detecting when a symlink points to a different ref than expected by the lock file. */
export const SymlinkDrift = Schema.Struct({
  /** The ref the symlink path corresponds to (e.g., 'dev' from refs/heads/dev) */
  symlinkRef: Schema.String,
  /** The ref we expected based on config/lock (e.g., 'refactor/genie-igor-ci') */
  expectedRef: Schema.String,
  /** The actual git branch inside the worktree (may differ from both) */
  actualGitBranch: Schema.optional(Schema.String),
})

/** Inferred type for symlink drift information. */
export type SymlinkDrift = Schema.Schema.Type<typeof SymlinkDrift>

// =============================================================================
// Commit Drift
// =============================================================================

/** Schema for detecting when a local worktree commit differs from the locked commit. */
export const CommitDrift = Schema.Struct({
  /** The commit SHA in the local worktree */
  localCommit: Schema.String,
  /** The commit SHA recorded in the lock file */
  lockedCommit: Schema.String,
})

/** Inferred type for commit drift information. */
export type CommitDrift = Schema.Schema.Type<typeof CommitDrift>

// =============================================================================
// Lock Info
// =============================================================================

/** Schema for lock file entry info (ref, commit, and whether pinned). */
export const LockInfo = Schema.Struct({
  ref: Schema.String,
  commit: Schema.String,
  pinned: Schema.Boolean,
})

/** Inferred type for lock file entry info. */
export type LockInfo = Schema.Schema.Type<typeof LockInfo>

// =============================================================================
// Member Status (recursive)
// =============================================================================

/** Recursive interface representing a member's full status including git, symlink, and nested members. */
export interface MemberStatus {
  name: string
  /** Whether the worktree exists in ~/.megarepo (for remote members) */
  exists: boolean
  /** Whether the symlink exists in repos/<name> */
  symlinkExists: boolean
  source: string
  isLocal: boolean
  lockInfo?: LockInfo | undefined
  isMegarepo: boolean
  nestedMembers?: readonly MemberStatus[] | undefined
  gitStatus?: GitStatus | undefined
  symlinkDrift?: SymlinkDrift | undefined
  /** Present when local worktree commit differs from locked commit */
  commitDrift?: CommitDrift | undefined
}

/** Recursive schema for member status, using `Schema.suspend` to support nested megarepo trees. */
export const MemberStatus: Schema.Schema<MemberStatus> = Schema.suspend(() =>
  Schema.Struct({
    name: Schema.String,
    /** Whether the worktree exists in ~/.megarepo (for remote members) */
    exists: Schema.Boolean,
    /** Whether the symlink exists in repos/<name> */
    symlinkExists: Schema.Boolean,
    source: Schema.String,
    isLocal: Schema.Boolean,
    lockInfo: Schema.optional(LockInfo),
    isMegarepo: Schema.Boolean,
    nestedMembers: Schema.optional(Schema.Array(MemberStatus)),
    gitStatus: Schema.optional(GitStatus),
    symlinkDrift: Schema.optional(SymlinkDrift),
    /** Present when local worktree commit differs from locked commit */
    commitDrift: Schema.optional(CommitDrift),
  }),
)

// =============================================================================
// Lock Staleness
// =============================================================================

/** Schema for lock file staleness info (missing or extra entries compared to config). */
export const LockStaleness = Schema.Struct({
  exists: Schema.Boolean,
  missingFromLock: Schema.Array(Schema.String),
  extraInLock: Schema.Array(Schema.String),
})

/** Inferred type for lock file staleness info. */
export type LockStaleness = Schema.Schema.Type<typeof LockStaleness>

// =============================================================================
// Status State
// =============================================================================

/**
 * State for status command.
 *
 * This is static output - all data is computed upfront.
 *
 * JSON output structure:
 * ```json
 * {
 *   "name": "my-workspace",
 *   "root": "/path/to/workspace",
 *   "syncNeeded": true,
 *   "syncReasons": ["Member 'foo' symlink missing", "Lock file stale"],
 *   "members": [...],
 *   "all": false,
 *   "lastSyncTime": "2024-01-30T12:00:00Z",
 *   "lockStaleness": { ... },
 *   "currentMemberPath": ["member1", "nested-member"]
 * }
 * ```
 */
export const StatusState = Schema.Struct({
  /** Workspace name */
  name: Schema.String,

  /** Workspace root path */
  root: Schema.String,

  /** Quick boolean: does the workspace need a sync? */
  syncNeeded: Schema.Boolean,

  /** Human-readable reasons why sync is needed (empty if syncNeeded=false) */
  syncReasons: Schema.Array(Schema.String),

  /** All member statuses (recursive tree when --all is used) */
  members: Schema.Array(MemberStatus),

  /** Whether --all was used (shows nested megarepos recursively) */
  all: Schema.Boolean,

  /** Last sync timestamp (ISO string for JSON compat) */
  lastSyncTime: Schema.optional(Schema.String),

  /** Lock file staleness info */
  lockStaleness: Schema.optional(LockStaleness),

  /** Path to current member (for highlighting) */
  currentMemberPath: Schema.optional(Schema.Array(Schema.String)),
})

/** Inferred type for the full status command state. */
export type StatusState = Schema.Schema.Type<typeof StatusState>

// =============================================================================
// Status Actions
// =============================================================================

/**
 * Actions for status output.
 *
 * Status is static output, so we only need SetState to populate the final result.
 */
export const StatusAction = Schema.Union(
  /** Replace entire state */
  Schema.TaggedStruct('SetState', { state: StatusState }),
)

/** Inferred type for status actions. */
export type StatusAction = Schema.Schema.Type<typeof StatusAction>

// =============================================================================
// Reducer
// =============================================================================

/** Reduces status actions into state by replacing with the provided state snapshot. */
export const statusReducer = ({
  state: _state,
  action,
}: {
  state: StatusState
  action: StatusAction
}): StatusState => {
  switch (action._tag) {
    case 'SetState':
      return action.state
  }
}
