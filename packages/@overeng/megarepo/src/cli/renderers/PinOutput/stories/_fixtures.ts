/**
 * Shared fixtures for PinOutput stories.
 *
 * @internal
 */

import type { PinState } from '../mod.ts'

// =============================================================================
// State Factories - Success
// =============================================================================

export const createPinSuccessWithRef = (): typeof PinState.Type => ({
  _tag: 'Success',
  member: 'effect',
  action: 'pin',
  ref: 'v3.0.0',
  commit: 'abc1234def5678',
})

export const createPinSuccessWithCommit = (): typeof PinState.Type => ({
  _tag: 'Success',
  member: 'effect',
  action: 'pin',
  commit: 'abc1234def5678',
})

export const createUnpinSuccess = (): typeof PinState.Type => ({
  _tag: 'Success',
  member: 'effect',
  action: 'unpin',
})

// =============================================================================
// State Factories - Already
// =============================================================================

export const createAlreadyPinned = (): typeof PinState.Type => ({
  _tag: 'Already',
  member: 'effect',
  action: 'pin',
  commit: 'abc1234def5678',
})

export const createAlreadyUnpinned = (): typeof PinState.Type => ({
  _tag: 'Already',
  member: 'effect',
  action: 'unpin',
})

// =============================================================================
// State Factories - DryRun
// =============================================================================

export const createDryRunFull = (): typeof PinState.Type => ({
  _tag: 'DryRun',
  member: 'effect',
  action: 'pin',
  ref: 'v3.0.0',
  currentSource: 'effect-ts/effect',
  newSource: 'effect-ts/effect#v3.0.0',
  currentSymlink: '~/.megarepo/.../refs/heads/main',
  newSymlink: '~/.megarepo/.../refs/tags/v3.0.0',
  lockChanges: ['ref: main → v3.0.0', 'pinned: true'],
  wouldCreateWorktree: true,
})

export const createDryRunSimple = (): typeof PinState.Type => ({
  _tag: 'DryRun',
  member: 'effect',
  action: 'pin',
  commit: 'abc1234def5678',
  lockChanges: ['pinned: false → true'],
})

// =============================================================================
// State Factories - Errors
// =============================================================================

export const createErrorNotInMegarepo = (): typeof PinState.Type => ({
  _tag: 'Error',
  error: 'not_in_megarepo',
  message: 'Not in a megarepo',
})

export const createErrorMemberNotFound = (): typeof PinState.Type => ({
  _tag: 'Error',
  error: 'member_not_found',
  message: "Member 'unknown-repo' not found",
})

export const createErrorNotSynced = (): typeof PinState.Type => ({
  _tag: 'Error',
  error: 'not_synced',
  message: "Member 'effect' not synced yet",
})

export const createErrorLocalPath = (): typeof PinState.Type => ({
  _tag: 'Error',
  error: 'local_path',
  message: 'Cannot pin local path members',
})

export const createErrorNotInLock = (): typeof PinState.Type => ({
  _tag: 'Error',
  error: 'not_in_lock',
  message: "Member 'effect' not in lock file",
})

// =============================================================================
// State Factories - Warnings
// =============================================================================

export const createWarningWorktreeNotAvailable = (): typeof PinState.Type => ({
  _tag: 'Warning',
  warning: 'worktree_not_available',
})

export const createWarningMemberRemovedFromConfig = (): typeof PinState.Type => ({
  _tag: 'Warning',
  warning: 'member_removed_from_config',
  member: 'old-member',
})
