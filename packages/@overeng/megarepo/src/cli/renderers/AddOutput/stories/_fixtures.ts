/**
 * Shared fixtures for AddOutput stories.
 *
 * @internal
 */

import type { AddStateType } from '../mod.ts'
import type { AddAction } from '../schema.ts'

// =============================================================================
// State Factories
// =============================================================================

export const createIdleState = (): AddStateType => ({
  _tag: 'Idle',
})

export const createSuccessState = (): AddStateType => ({
  _tag: 'Success',
  member: 'effect',
  source: 'effect-ts/effect',
  synced: false,
})

export const createSuccessSyncedState = (): AddStateType => ({
  _tag: 'Success',
  member: 'effect',
  source: 'effect-ts/effect',
  synced: true,
  syncStatus: 'cloned',
})

export const createSuccessSyncedExistingState = (): AddStateType => ({
  _tag: 'Success',
  member: 'effect',
  source: 'effect-ts/effect',
  synced: true,
  syncStatus: 'synced',
})

export const createSuccessSyncErrorState = (): AddStateType => ({
  _tag: 'Success',
  member: 'private-repo',
  source: 'org/private-repo',
  synced: true,
  syncStatus: 'error',
})

export const createErrorNotInMegarepoState = (): AddStateType => ({
  _tag: 'Error',
  error: 'not_in_megarepo',
  message: 'No megarepo.json found',
})

export const createErrorInvalidRepoState = (): AddStateType => ({
  _tag: 'Error',
  error: 'invalid_repo',
  message: 'Invalid repo reference: not-a-valid-repo',
})

export const createErrorAlreadyExistsState = (): AddStateType => ({
  _tag: 'Error',
  error: 'already_exists',
  message: "Member 'effect' already exists",
})

// =============================================================================
// Timeline Factory for Animated Stories
// =============================================================================

/**
 * Creates a timeline that animates through adding a member and ends with the provided state.
 * This ensures interactive mode shows the same end result as static mode.
 */
export const createTimeline = (config: {
  member: string
  source: string
  synced: boolean
  syncStatus?: 'cloned' | 'synced' | 'error'
}): Array<{ at: number; action: typeof AddAction.Type }> => {
  const timeline: Array<{ at: number; action: typeof AddAction.Type }> = []

  // Start: idle -> adding
  timeline.push({
    at: 0,
    action: { _tag: 'SetAdding', member: config.member, source: config.source },
  })

  // Complete: adding -> success
  timeline.push({
    at: config.synced ? 1200 : 600,
    action: {
      _tag: 'SetSuccess',
      member: config.member,
      source: config.source,
      synced: config.synced,
      ...(config.synced && config.syncStatus ? { syncStatus: config.syncStatus } : {}),
    },
  })

  return timeline
}
