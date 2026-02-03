/**
 * Shared fixtures for PinOutput stories.
 *
 * @internal
 */

import type { PinAction, PinState } from '../mod.ts'
import type { PinState as PinStateType } from '../mod.ts'

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

// =============================================================================
// Timeline Factory for Animated Stories
// =============================================================================

/**
 * Creates a timeline that animates through checking and ends with the provided final state.
 * This ensures interactive mode shows the same end result as static mode.
 */
export const createTimeline = (
  finalState: PinStateType,
): Array<{ at: number; action: typeof PinAction.Type }> => {
  const timeline: Array<{ at: number; action: typeof PinAction.Type }> = []

  // Extract member from final state if available
  const member = getMemberFromState(finalState) ?? 'effect'

  // Start: checking phase
  timeline.push({
    at: 0,
    action: { _tag: 'SetChecking', member },
  })

  // End: final state (map to appropriate action based on _tag)
  timeline.push({
    at: 800,
    action: mapStateToAction(finalState),
  })

  return timeline
}

/**
 * Extract member name from a PinState if available.
 */
const getMemberFromState = (state: PinStateType): string | undefined => {
  switch (state._tag) {
    case 'Checking':
    case 'Success':
    case 'Already':
    case 'DryRun':
      return state.member
    case 'Warning':
      return state.member
    case 'Idle':
    case 'Error':
      return undefined
  }
}

/**
 * Map a PinState to the corresponding PinAction.
 */
const mapStateToAction = (state: PinStateType): typeof PinAction.Type => {
  switch (state._tag) {
    case 'Idle':
      // For idle, we just return a checking action (shouldn't happen in practice)
      return { _tag: 'SetChecking', member: 'effect' }
    case 'Checking':
      return { _tag: 'SetChecking', member: state.member }
    case 'Success':
      return {
        _tag: 'SetSuccess',
        member: state.member,
        action: state.action,
        ref: state.ref,
        commit: state.commit,
      }
    case 'Already':
      return {
        _tag: 'SetAlready',
        member: state.member,
        action: state.action,
        commit: state.commit,
      }
    case 'DryRun':
      return {
        _tag: 'SetDryRun',
        member: state.member,
        action: state.action,
        ref: state.ref,
        commit: state.commit,
        currentSource: state.currentSource,
        newSource: state.newSource,
        currentSymlink: state.currentSymlink,
        newSymlink: state.newSymlink,
        lockChanges: state.lockChanges,
        wouldClone: state.wouldClone,
        wouldCreateWorktree: state.wouldCreateWorktree,
        worktreeNotAvailable: state.worktreeNotAvailable,
      }
    case 'Warning':
      return {
        _tag: 'SetWarning',
        warning: state.warning,
        member: state.member,
        message: state.message,
      }
    case 'Error':
      return {
        _tag: 'SetError',
        error: state.error,
        message: state.message,
      }
  }
}
