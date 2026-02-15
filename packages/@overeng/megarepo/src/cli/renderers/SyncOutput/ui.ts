/**
 * SyncOutput UI Handle
 *
 * Provides a handle for managing the sync UI lifecycle.
 * Compatible API with the old startSyncProgressUI pattern.
 */

import type { Scope } from 'effect'
import { Effect } from 'effect'
import React from 'react'

import { isTTY } from '@overeng/tui-react'
import { tty, layer as outputModeLayer } from '@overeng/tui-react'

import type { MemberSyncResult } from '../../../lib/sync/schema.ts'
import { SyncApp } from './app.ts'
import type { SyncState } from './schema.ts'
import { SyncView } from './view.tsx'

// Re-export SyncAction for consumers
export type { SyncAction } from './schema.ts'
import type { SyncAction } from './schema.ts'

// =============================================================================
// Types
// =============================================================================

/** Handle for managing the sync UI lifecycle */
export type SyncUIHandle = {
  /** Dispatch an action to update state */
  dispatch: (action: SyncAction) => void
  /** Cleanup function - call when sync is complete */
  cleanup: () => Effect.Effect<void>
}

// =============================================================================
// Action Helpers
// =============================================================================

/**
 * Map a MemberSyncResult to an AddResult action.
 */
export const mapResultToAction = (result: MemberSyncResult): SyncAction => ({
  _tag: 'AddResult',
  result,
})

/**
 * Create a StartSync action.
 */
export const createStartSyncAction = (members: readonly string[]): SyncAction => ({
  _tag: 'StartSync',
  members: [...members],
})

/**
 * Create a SetActiveMember action (for spinner display).
 */
export const createSetActiveMemberAction = (name: string): SyncAction => ({
  _tag: 'SetActiveMember',
  name,
})

/**
 * Create a Complete action.
 */
export const createCompleteAction = (params: {
  nestedMegarepos?: readonly string[]
  generatedFiles?: readonly string[]
}): SyncAction => ({
  _tag: 'Complete',
  nestedMegarepos: [...(params.nestedMegarepos ?? [])],
  generatedFiles: [...(params.generatedFiles ?? [])],
})

/**
 * Create an AddLog action.
 */
export const createLogAction = (params: {
  type: 'info' | 'warn' | 'error'
  message: string
}): SyncAction => ({
  _tag: 'AddLog',
  type: params.type,
  message: params.message,
})

/**
 * Create a SetState action.
 */
export const createSetStateAction = (state: SyncState): SyncAction => ({
  _tag: 'SetState',
  state,
})

// =============================================================================
// API
// =============================================================================

/**
 * Start the sync UI.
 *
 * Returns a handle with dispatch() for updating state and cleanup() for teardown.
 *
 * In non-TTY mode, returns a no-op handle.
 */
export const startSyncUI = (options: {
  workspaceName: string
  workspaceRoot: string
  memberNames: readonly string[]
  dryRun?: boolean
  frozen?: boolean
  pull?: boolean
  all?: boolean
  force?: boolean
  verbose?: boolean
  skippedMembers?: readonly string[]
}): Effect.Effect<SyncUIHandle, never, Scope.Scope> =>
  Effect.gen(function* () {
    const {
      workspaceName,
      workspaceRoot,
      memberNames,
      dryRun,
      frozen,
      pull,
      all,
      force,
      verbose,
      skippedMembers,
    } = options

    // If not TTY, return a no-op handle
    if (isTTY() === false) {
      return {
        dispatch: () => {},
        cleanup: () => Effect.void,
      } satisfies SyncUIHandle
    }

    // Run the app with the view using atom-first pattern
    const tui = yield* SyncApp.run(
      React.createElement(SyncView, { stateAtom: SyncApp.stateAtom }),
    ).pipe(Effect.provide(outputModeLayer(tty)))

    // Initialize with start action
    tui.dispatch({
      _tag: 'SetState',
      state: {
        _tag: 'Syncing',
        workspace: { name: workspaceName, root: workspaceRoot },
        options: {
          dryRun: dryRun ?? false,
          frozen: frozen ?? false,
          pull: pull ?? false,
          all: all ?? false,
          force: force || undefined,
          verbose: verbose || undefined,
          skippedMembers:
            skippedMembers !== undefined && skippedMembers.length > 0
              ? [...skippedMembers]
              : undefined,
        },
        members: [...memberNames],
        activeMember: null,
        results: [],
        logs: [],
        startedAt: Date.now(),
        nestedMegarepos: [],
        generatedFiles: [],
        lockSyncResults: [],
        syncTree: {
          root: workspaceRoot,
          results: [],
          nestedMegarepos: [],
          nestedResults: [],
        },
        syncErrors: [],
        syncErrorCount: 0,
      },
    })

    return {
      dispatch: tui.dispatch,
      cleanup: () => tui.unmount({ mode: 'persist' }),
    } satisfies SyncUIHandle
  })

/**
 * Finish the sync UI.
 * Cleans up the TUI renderer.
 */
export const finishSyncUI = (handle: SyncUIHandle) => handle.cleanup()

// Re-export for convenience
export { isTTY }
