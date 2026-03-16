/**
 * Shared fixtures for PushRefsOutput stories.
 *
 * @internal
 */

import type { PushRefsAction, PushRefsState } from '../mod.ts'
import type { PushRefsState as PushRefsStateType } from '../mod.ts'

// =============================================================================
// State Factories - Aligned (no changes needed)
// =============================================================================

export const createAligned = (): typeof PushRefsState.Type => ({
  _tag: 'Aligned',
})

// =============================================================================
// State Factories - Results
// =============================================================================

/** Single nested megarepo with one ref update */
export const createSingleUpdate = (): typeof PushRefsState.Type => ({
  _tag: 'Result',
  dryRun: false,
  totalUpdates: 1,
  results: [
    {
      name: 'my-app',
      hasGenie: false,
      updates: [
        {
          nestedMember: 'my-app',
          sharedMemberName: 'shared-lib',
          oldSource: 'acme/shared-lib#feature-branch',
          newSource: 'acme/shared-lib',
        },
      ],
    },
  ],
})

/** Multiple nested megarepos with several ref updates */
export const createMultipleUpdates = (): typeof PushRefsState.Type => ({
  _tag: 'Result',
  dryRun: false,
  totalUpdates: 3,
  results: [
    {
      name: 'frontend-app',
      hasGenie: false,
      updates: [
        {
          nestedMember: 'frontend-app',
          sharedMemberName: 'shared-lib',
          oldSource: 'acme/shared-lib#v2.0.0',
          newSource: 'acme/shared-lib#v3.0.0',
        },
        {
          nestedMember: 'frontend-app',
          sharedMemberName: 'utils',
          oldSource: 'acme/utils#old-branch',
          newSource: 'acme/utils',
        },
      ],
    },
    {
      name: 'backend-api',
      hasGenie: false,
      updates: [
        {
          nestedMember: 'backend-api',
          sharedMemberName: 'shared-lib',
          oldSource: 'acme/shared-lib#v2.0.0',
          newSource: 'acme/shared-lib#v3.0.0',
        },
      ],
    },
  ],
})

/** Dry run with single update */
export const createDryRunSingle = (): typeof PushRefsState.Type => ({
  _tag: 'Result',
  dryRun: true,
  totalUpdates: 1,
  results: [
    {
      name: 'my-app',
      hasGenie: false,
      updates: [
        {
          nestedMember: 'my-app',
          sharedMemberName: 'shared-lib',
          oldSource: 'acme/shared-lib#feature-branch',
          newSource: 'acme/shared-lib',
        },
      ],
    },
  ],
})

/** Dry run with multiple updates */
export const createDryRunMultiple = (): typeof PushRefsState.Type => ({
  _tag: 'Result',
  dryRun: true,
  totalUpdates: 3,
  results: [
    {
      name: 'frontend-app',
      hasGenie: false,
      updates: [
        {
          nestedMember: 'frontend-app',
          sharedMemberName: 'shared-lib',
          oldSource: 'acme/shared-lib#v2.0.0',
          newSource: 'acme/shared-lib#v3.0.0',
        },
        {
          nestedMember: 'frontend-app',
          sharedMemberName: 'utils',
          oldSource: 'acme/utils#old-branch',
          newSource: 'acme/utils',
        },
      ],
    },
    {
      name: 'backend-api',
      hasGenie: false,
      updates: [
        {
          nestedMember: 'backend-api',
          sharedMemberName: 'shared-lib',
          oldSource: 'acme/shared-lib#v2.0.0',
          newSource: 'acme/shared-lib#v3.0.0',
        },
      ],
    },
  ],
})

// =============================================================================
// State Factories - Genie Warning
// =============================================================================

/** Update with genie file warning */
export const createWithGenieWarning = (): typeof PushRefsState.Type => ({
  _tag: 'Result',
  dryRun: false,
  totalUpdates: 1,
  results: [
    {
      name: 'my-app',
      hasGenie: true,
      updates: [
        {
          nestedMember: 'my-app',
          sharedMemberName: 'shared-lib',
          oldSource: 'acme/shared-lib#feature-branch',
          newSource: 'acme/shared-lib',
        },
      ],
    },
  ],
})

// =============================================================================
// State Factories - Errors
// =============================================================================

export const createErrorNotInMegarepo = (): typeof PushRefsState.Type => ({
  _tag: 'Error',
  error: 'not_in_megarepo',
  message: 'Not in a megarepo',
})

// =============================================================================
// Timeline Factory for Animated Stories
// =============================================================================

export const createTimeline = (
  finalState: PushRefsStateType,
): Array<{ at: number; action: typeof PushRefsAction.Type }> => {
  const timeline: Array<{ at: number; action: typeof PushRefsAction.Type }> = []

  timeline.push({
    at: 0,
    action: { _tag: 'SetScanning' },
  })

  timeline.push({
    at: 600,
    action: mapStateToAction(finalState),
  })

  return timeline
}

const mapStateToAction = (state: PushRefsStateType): typeof PushRefsAction.Type => {
  switch (state._tag) {
    case 'Idle':
    case 'Scanning':
      return { _tag: 'SetScanning' }
    case 'Aligned':
      return { _tag: 'SetAligned' }
    case 'Result':
      return {
        _tag: 'SetResult',
        results: state.results,
        totalUpdates: state.totalUpdates,
        dryRun: state.dryRun,
      }
    case 'Error':
      return { _tag: 'SetError', error: state.error, message: state.message }
  }
}
