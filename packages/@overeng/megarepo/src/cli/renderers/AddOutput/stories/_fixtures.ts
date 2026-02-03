/**
 * Shared fixtures for AddOutput stories.
 *
 * @internal
 */

import type { AddStateType } from '../mod.ts'

// =============================================================================
// State Factories
// =============================================================================

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
