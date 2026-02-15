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

/**
 * Creates a success state from a config object.
 * This ensures interactive and static modes use the same state configuration.
 */
export const createSuccessState = (config: {
  member: string
  source: string
  synced: boolean
  syncStatus?: 'cloned' | 'synced' | 'error'
}): AddStateType => ({
  _tag: 'Success',
  member: config.member,
  source: config.source,
  synced: config.synced,
  ...(config.synced !== undefined && config.syncStatus !== undefined
    ? { syncStatus: config.syncStatus }
    : {}),
})

export const createErrorNotInMegarepoState = (): AddStateType => ({
  _tag: 'Error',
  error: 'not_in_megarepo',
  message: 'No megarepo.json found',
})

export const createErrorInvalidRepoState = (repo: string): AddStateType => ({
  _tag: 'Error',
  error: 'invalid_repo',
  message: `Invalid repo reference: ${repo}`,
})

export const createErrorAlreadyExistsState = (member: string): AddStateType => ({
  _tag: 'Error',
  error: 'already_exists',
  message: `Member '${member}' already exists`,
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
    at: config.synced === true ? 1200 : 600,
    action: {
      _tag: 'SetSuccess',
      member: config.member,
      source: config.source,
      synced: config.synced,
      ...(config.synced !== undefined && config.syncStatus !== undefined
        ? { syncStatus: config.syncStatus }
        : {}),
    },
  })

  return timeline
}
