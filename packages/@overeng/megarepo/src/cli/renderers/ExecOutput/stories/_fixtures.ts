/**
 * Shared fixtures for ExecOutput stories.
 *
 * @internal
 */

import type { ExecStateType } from '../mod.ts'

// =============================================================================
// Error States
// =============================================================================

export const errorState: ExecStateType = {
  _tag: 'Error',
  error: 'not_found',
  message: 'No megarepo.json found',
}

export const memberNotFoundState: ExecStateType = {
  _tag: 'Error',
  error: 'not_found',
  message: 'Member not found',
}

// =============================================================================
// Running States
// =============================================================================

export const runningVerboseParallelState: ExecStateType = {
  _tag: 'Running',
  command: 'npm version',
  mode: 'parallel',
  verbose: true,
  members: [
    { name: 'effect', status: 'running' },
    { name: 'effect-utils', status: 'pending' },
    { name: 'livestore', status: 'pending' },
  ],
}

export const runningVerboseSequentialState: ExecStateType = {
  _tag: 'Running',
  command: 'git status',
  mode: 'sequential',
  verbose: true,
  members: [
    { name: 'effect', status: 'success', exitCode: 0, stdout: 'On branch main' },
    { name: 'effect-utils', status: 'running' },
  ],
}

// =============================================================================
// Complete States
// =============================================================================

export const completeSuccessState: ExecStateType = {
  _tag: 'Complete',
  command: 'npm version',
  mode: 'parallel',
  verbose: false,
  hasErrors: false,
  members: [
    { name: 'effect', status: 'success', exitCode: 0, stdout: 'v3.0.0' },
    { name: 'effect-utils', status: 'success', exitCode: 0, stdout: 'v1.2.3' },
    { name: 'livestore', status: 'success', exitCode: 0, stdout: 'v0.5.0' },
  ],
}

export const completeMixedState: ExecStateType = {
  _tag: 'Complete',
  command: 'npm version',
  mode: 'parallel',
  verbose: false,
  hasErrors: true,
  members: [
    { name: 'effect', status: 'success', exitCode: 0, stdout: 'v3.0.0' },
    { name: 'effect-utils', status: 'success', exitCode: 0, stdout: 'v1.2.3' },
    { name: 'livestore', status: 'error', exitCode: 1, stderr: 'Command failed: npm version' },
  ],
}

export const completeWithSkippedState: ExecStateType = {
  _tag: 'Complete',
  command: 'npm install',
  mode: 'parallel',
  verbose: false,
  hasErrors: false,
  members: [
    { name: 'effect', status: 'success', exitCode: 0, stdout: 'added 125 packages in 2.3s' },
    { name: 'effect-utils', status: 'skipped', stderr: 'Member not synced' },
    { name: 'livestore', status: 'success', exitCode: 0, stdout: 'added 45 packages in 1.1s' },
  ],
}

export const completeAllErrorsState: ExecStateType = {
  _tag: 'Complete',
  command: 'foo',
  mode: 'parallel',
  verbose: false,
  hasErrors: true,
  members: [
    { name: 'effect', status: 'error', exitCode: 1, stderr: 'Command not found: foo' },
    { name: 'effect-utils', status: 'error', exitCode: 1, stderr: 'Permission denied' },
    { name: 'livestore', status: 'error', exitCode: 127, stderr: 'sh: command not found' },
  ],
}

export const completeVerboseState: ExecStateType = {
  _tag: 'Complete',
  command: 'npm version',
  mode: 'parallel',
  verbose: true,
  hasErrors: false,
  members: [
    { name: 'effect', status: 'success', exitCode: 0, stdout: 'v3.0.0' },
    { name: 'effect-utils', status: 'success', exitCode: 0, stdout: 'v1.2.3' },
  ],
}

// =============================================================================
// State Factories
// =============================================================================

export const createRunningState = (overrides?: {
  verbose?: boolean
  mode?: 'parallel' | 'sequential'
}): ExecStateType => {
  const verbose = overrides?.verbose ?? true
  const mode = overrides?.mode ?? 'parallel'

  if (mode === 'sequential') {
    return {
      ...runningVerboseSequentialState,
      verbose,
      mode,
    }
  }

  return {
    ...runningVerboseParallelState,
    verbose,
    mode,
  }
}

export const createCompleteState = (overrides?: { verbose?: boolean }): ExecStateType => ({
  ...completeSuccessState,
  verbose: overrides?.verbose ?? false,
})
