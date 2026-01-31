/**
 * React-based Sync Progress UI
 *
 * Uses createTuiApp pattern for schema-validated state management.
 * Provides typed dispatch for all sync progress actions.
 */

import type { Scope } from 'effect'
import { Effect, Layer } from 'effect'
import React from 'react'

import { isTTY } from '@overeng/cli-ui'
import { OutputModeTag, tty } from '@overeng/tui-react'

import type { MemberSyncResult } from '../renderers/SyncOutput.tsx'
import {
  createSyncApp,
  createInitialState,
  createConnectedView,
  type SyncProgressAction,
} from './sync-app.tsx'

// =============================================================================
// Types
// =============================================================================

/** Handle for managing the sync progress UI lifecycle */
export type SyncProgressUIHandle = {
  /** Dispatch an action to update state */
  dispatch: (action: SyncProgressAction) => void
  /** Cleanup function - call when sync is complete */
  cleanup: () => Effect.Effect<void>
}

// =============================================================================
// Result Mapping
// =============================================================================

/**
 * Map a MemberSyncResult to a SetItemStatus action.
 */
export const mapSyncResultToAction = (result: MemberSyncResult): SyncProgressAction => {
  const baseData = {
    ref: 'ref' in result ? result.ref : undefined,
    commit: 'commit' in result ? result.commit : undefined,
  }

  switch (result.status) {
    case 'cloned':
      return {
        _tag: 'SetItemStatus',
        id: result.name,
        status: 'success',
        message: result.ref ? `cloned (${result.ref})` : 'cloned',
        data: baseData,
      }
    case 'synced':
      return {
        _tag: 'SetItemStatus',
        id: result.name,
        status: 'success',
        message: result.ref ? `synced (${result.ref})` : 'synced',
        data: baseData,
      }
    case 'updated':
      return {
        _tag: 'SetItemStatus',
        id: result.name,
        status: 'success',
        message: result.commit ? `updated → ${result.commit.slice(0, 7)}` : 'updated',
        data: baseData,
      }
    case 'locked':
      return {
        _tag: 'SetItemStatus',
        id: result.name,
        status: 'success',
        message: 'lock updated',
        data: baseData,
      }
    case 'already_synced':
      return {
        _tag: 'SetItemStatus',
        id: result.name,
        status: 'success',
        data: baseData,
      }
    case 'skipped':
      return {
        _tag: 'SetItemStatus',
        id: result.name,
        status: 'skipped',
        message: result.message,
      }
    case 'error':
      return {
        _tag: 'SetItemStatus',
        id: result.name,
        status: 'error',
        message: result.message,
      }
    case 'removed':
      return {
        _tag: 'SetItemStatus',
        id: result.name,
        status: 'success',
        message: 'removed',
      }
  }
}

// =============================================================================
// API
// =============================================================================

/**
 * Start the React-based sync progress UI using createTuiApp.
 *
 * Returns a handle with dispatch() for updating state and cleanup() for teardown.
 */
export const startSyncProgressUI = (options: {
  workspaceName: string
  workspaceRoot: string
  memberNames: readonly string[]
  dryRun?: boolean
  frozen?: boolean
  pull?: boolean
  deep?: boolean
}): Effect.Effect<SyncProgressUIHandle, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { workspaceName, workspaceRoot, memberNames, dryRun, frozen, pull, deep } = options

    // Build mode indicators
    const modes: string[] = []
    if (dryRun) modes.push('dry run')
    if (frozen) modes.push('frozen')
    if (pull) modes.push('pull')
    if (deep) modes.push('deep')

    // If not TTY, return a no-op handle
    if (!isTTY()) {
      return {
        dispatch: () => {},
        cleanup: () => Effect.void,
      } satisfies SyncProgressUIHandle
    }

    // Create initial state with member items
    const initialState = createInitialState({
      title: workspaceName,
      subtitle: workspaceRoot,
      ...(modes.length > 0 ? { modes } : {}),
    })

    // Initialize with member items
    const stateWithItems = {
      ...initialState,
      items: memberNames.map((name) => ({
        id: name,
        label: name,
        status: 'pending' as const,
      })),
    }

    // Create the app instance
    const app = createSyncApp(stateWithItems)

    // Create connected view
    const ConnectedView = createConnectedView(app)

    // Run the app with the view
    const tui = yield* app.run(<ConnectedView />).pipe(Effect.provide(Layer.succeed(OutputModeTag, tty)))

    return {
      dispatch: tui.dispatch,
      cleanup: () => tui.unmount({ mode: 'persist' }),
    } satisfies SyncProgressUIHandle
  })

/**
 * Finish the React-based sync progress UI.
 * Cleans up the TUI renderer.
 */
export const finishSyncProgressUI = (handle: SyncProgressUIHandle) => handle.cleanup()

export { isTTY }

// =============================================================================
// Convenience Functions (for sync-adapter.ts compatibility)
// =============================================================================

/**
 * Initialize sync progress - dispatches Init action.
 */
export const createInitAction = (params: {
  memberNames: readonly string[]
  metadata?: Record<string, unknown>
}): SyncProgressAction => ({
  _tag: 'Init',
  items: params.memberNames.map((name) => ({ id: name, label: name })),
  metadata: params.metadata,
})

/**
 * Mark a member as syncing - dispatches SetItemStatus action.
 */
export const createSyncingAction = (params: {
  memberName: string
  message?: string
}): SyncProgressAction => ({
  _tag: 'SetItemStatus',
  id: params.memberName,
  status: 'active',
  message: params.message ?? 'syncing...',
})

/**
 * Mark sync as complete - dispatches SetComplete action.
 */
export const createCompleteAction = (): SyncProgressAction => ({
  _tag: 'SetComplete',
})

/**
 * Add a log entry - dispatches AddLog action.
 */
export const createLogAction = (params: {
  type: 'info' | 'warn' | 'error'
  message: string
}): SyncProgressAction => ({
  _tag: 'AddLog',
  type: params.type,
  message: params.message,
})
