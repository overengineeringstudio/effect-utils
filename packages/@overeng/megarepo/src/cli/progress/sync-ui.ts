/**
 * Sync Progress UI
 *
 * Wraps the generic progress UI with sync-specific configuration.
 */

import { Effect } from 'effect'

import { isTTY, styled, formatElapsed } from '@overeng/cli-ui'

import type { ProgressState, ProgressItem } from './service.ts'
import {
  initSyncProgress,
  syncProgressChanges,
  getSyncProgress,
  type SyncItemData,
} from './sync-adapter.ts'
import { createProgressUI, type ProgressUIHandle } from './ui.ts'

// =============================================================================
// Types
// =============================================================================

/** Handle for managing the sync progress UI lifecycle. */
export type SyncProgressUIHandle = ProgressUIHandle

// =============================================================================
// UI Configuration
// =============================================================================

/** Format a sync item for display */
const formatSyncItem = (
  item: ProgressItem<SyncItemData>,
): { label: string; message: string | undefined } => ({
  label: item.label,
  message: item.message,
})

/** Format the sync summary line */
const formatSyncSummary = ({
  state,
  elapsed,
}: {
  state: ProgressState<SyncItemData>
  elapsed: number
}): string => {
  const counts = { success: 0, error: 0, skipped: 0, pending: 0, active: 0 }
  for (const item of state.items.values()) {
    counts[item.status]++
  }

  const total = state.items.size
  const completed = counts.success + counts.error + counts.skipped

  const parts: string[] = [`${completed}/${total}`]
  if (counts.error > 0) {
    parts.push(styled.red(`${counts.error} error${counts.error > 1 ? 's' : ''}`))
  }
  parts.push(formatElapsed(elapsed))

  return styled.dim(parts.join(' · '))
}

// =============================================================================
// Create UI
// =============================================================================

/** Create sync progress UI operations */
const syncUI = createProgressUI({
  ops: {
    get: getSyncProgress,
    changes: syncProgressChanges,
  },
  options: {
    formatItem: formatSyncItem,
    formatSummary: formatSyncSummary,
    showSummary: true,
    spinnerInterval: 80,
  },
})

// =============================================================================
// Public API
// =============================================================================

/**
 * Start the sync progress UI.
 * Prints header and begins live progress rendering.
 */
export const startSyncProgressUI = (options: {
  workspaceName: string
  workspaceRoot: string
  memberNames: readonly string[]
  dryRun?: boolean
  frozen?: boolean
  pull?: boolean
  deep?: boolean
}) =>
  Effect.gen(function* () {
    const { workspaceName, workspaceRoot, memberNames, dryRun, frozen, pull, deep } = options

    // Initialize progress state
    yield* initSyncProgress({
      megarepoRoot: workspaceRoot,
      workspaceName,
      memberNames,
    })

    // Build mode indicators
    const modes: string[] = []
    if (dryRun) modes.push('dry run')
    if (frozen) modes.push('frozen')
    if (pull) modes.push('pull')
    if (deep) modes.push('deep')

    // Start the UI
    return yield* syncUI.start({
      title: workspaceName,
      subtitle: workspaceRoot,
      ...(modes.length > 0 ? { modes } : {}),
    })
  })

/**
 * Finish the sync progress UI.
 * Stops spinner, waits for updates to complete, shows final state.
 */
export const finishSyncProgressUI = (handle: SyncProgressUIHandle) => syncUI.finish(handle)

/**
 * Check if running in a TTY.
 */
export { isTTY }
