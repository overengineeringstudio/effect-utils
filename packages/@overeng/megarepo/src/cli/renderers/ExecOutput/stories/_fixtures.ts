/**
 * Shared fixtures for ExecOutput stories.
 *
 * @internal
 */

import type { ExecActionType, ExecStateType } from '../mod.ts'

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

export const createCompleteState = (overrides?: {
  verbose?: boolean
  mode?: 'parallel' | 'sequential'
}): ExecStateType => ({
  ...completeSuccessState,
  verbose: overrides?.verbose ?? false,
  mode: overrides?.mode ?? 'parallel',
})

// =============================================================================
// Timeline Factory for Animated Stories
// =============================================================================

/**
 * Creates a timeline that animates through executing each member and ends with the provided configuration.
 * This ensures interactive mode shows the same end result as static mode.
 */
export const createTimeline = (config: {
  command: string
  mode: 'parallel' | 'sequential'
  verbose: boolean
  members: Array<{
    name: string
    status: 'success' | 'error' | 'skipped'
    exitCode?: number
    stdout?: string
    stderr?: string
  }>
}): Array<{ at: number; action: ExecActionType }> => {
  const { command, mode, verbose, members } = config

  if (members.length === 0) {
    // No members - just show complete state immediately
    return [
      {
        at: 0,
        action: {
          _tag: 'Start',
          command,
          mode,
          verbose,
          members: [],
        },
      },
      {
        at: 100,
        action: { _tag: 'Complete' },
      },
    ]
  }

  const timeline: Array<{ at: number; action: ExecActionType }> = []
  const stepDuration = 800
  const memberNames = members.map((m) => m.name)

  // Start with all members pending
  timeline.push({
    at: 0,
    action: {
      _tag: 'Start',
      command,
      mode,
      verbose,
      members: memberNames,
    },
  })

  // Process members based on mode
  if (mode === 'parallel') {
    // In parallel mode, all start running at once, then complete one by one
    for (let i = 0; i < members.length; i++) {
      timeline.push({
        at: stepDuration * 0.5 + i * 50,
        action: {
          _tag: 'UpdateMember',
          name: members[i]!.name,
          status: 'running',
        },
      })
    }

    // Complete each member
    for (let i = 0; i < members.length; i++) {
      const member = members[i]!
      timeline.push({
        at: stepDuration * (i + 1),
        action: {
          _tag: 'UpdateMember',
          name: member.name,
          status: member.status,
          exitCode: member.exitCode,
          stdout: member.stdout,
          stderr: member.stderr,
        },
      })
    }
  } else {
    // In sequential mode, members run one at a time
    for (let i = 0; i < members.length; i++) {
      const member = members[i]!
      const baseTime = stepDuration * i

      // Start running
      timeline.push({
        at: baseTime + stepDuration * 0.3,
        action: {
          _tag: 'UpdateMember',
          name: member.name,
          status: 'running',
        },
      })

      // Complete
      timeline.push({
        at: baseTime + stepDuration,
        action: {
          _tag: 'UpdateMember',
          name: member.name,
          status: member.status,
          exitCode: member.exitCode,
          stdout: member.stdout,
          stderr: member.stderr,
        },
      })
    }
  }

  // Mark as complete
  timeline.push({
    at: stepDuration * (members.length + 1),
    action: { _tag: 'Complete' },
  })

  return timeline
}
