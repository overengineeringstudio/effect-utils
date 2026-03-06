/**
 * AlignmentOutput TuiApp
 *
 * createTuiApp instance for the alignment coordinator commands.
 * Handles all output modes: TTY, CI, JSON, NDJSON.
 */

import { createTuiApp } from '@overeng/tui-react'

import { AlignmentState, AlignmentAction, alignmentReducer } from './schema.ts'

export const AlignmentApp = createTuiApp({
  stateSchema: AlignmentState,
  actionSchema: AlignmentAction,
  initial: { phase: 'loading', members: [] } satisfies typeof AlignmentState.Type,
  reducer: alignmentReducer,
  exitCode: (state) => {
    const hasFailedChecks = state.members.some((m) => m.pollStatus === 'checks_failed')
    const hasWarnings = state.members.some((m) => m.taskStatus === 'warning')
    if (hasFailedChecks) return 1
    if (hasWarnings) return 0 // warnings are informational, don't fail
    return 0
  },
})
