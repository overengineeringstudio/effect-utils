/**
 * Sync Progress Adapter
 *
 * Maps sync-specific types (MemberSyncResult) to the generic progress service.
 * Provides a clean API for the sync command to update progress without
 * knowing about the underlying generic progress implementation.
 */

import { Context, Effect, Layer, SubscriptionRef } from 'effect'

import type { MemberSyncResult } from '../renderers/sync-renderer.ts'
import { createProgressService, createState, type ProgressItemInput } from './service.ts'

// =============================================================================
// Sync-specific Data Type
// =============================================================================

/** Data attached to each sync progress item */
export type SyncItemData = {
  /** The ref that was synced to */
  readonly ref?: string | undefined
  /** The commit hash */
  readonly commit?: string | undefined
}

// =============================================================================
// Progress Service Instance
// =============================================================================

/** Create the sync progress service */
const syncProgressService = createProgressService<SyncItemData>('sync')
const { Progress: SyncProgress, ops, layer, layerWith } = syncProgressService

/** Type for the SyncProgress service requirement */
export type SyncProgressService = typeof syncProgressService.Progress

export { SyncProgress, layer as SyncProgressLayer }

// =============================================================================
// Sync-specific Operations
// =============================================================================

/**
 * Initialize sync progress with member names.
 */
export const initSyncProgress = (params: {
  megarepoRoot: string
  workspaceName: string
  memberNames: readonly string[]
}) => {
  const items: ProgressItemInput<SyncItemData>[] = params.memberNames.map((name) => ({
    id: name,
    label: name,
  }))
  return ops.init({
    items,
    metadata: {
      megarepoRoot: params.megarepoRoot,
      workspaceName: params.workspaceName,
    },
  })
}

/**
 * Mark a member as syncing (active).
 */
export const setMemberSyncing = ({
  memberName,
  message,
}: {
  memberName: string
  message?: string
}) => ops.markActive({ id: memberName, message: message ?? 'syncing...' })

/**
 * Apply a sync result to the progress.
 * Maps MemberSyncResult status to generic progress status.
 */
export const applySyncResult = (result: MemberSyncResult) => {
  const mapped = mapSyncResultToProgress(result)

  return ops.update({
    id: result.name,
    update: {
      status: mapped.status,
      message: mapped.message,
      data: {
        ref: result.ref,
        commit: result.commit,
      },
    },
  })
}

/**
 * Mark the sync as complete.
 */
export const completeSyncProgress = () => ops.complete()

/**
 * Get the current sync progress state.
 */
export const getSyncProgress = () => ops.get()

/**
 * Get the stream of sync progress changes.
 */
export const syncProgressChanges = () => ops.changes()

// =============================================================================
// Result Mapping
// =============================================================================

type MappedResult = {
  status: 'success' | 'error' | 'skipped'
  message: string | undefined
}

/**
 * Map a MemberSyncResult to generic progress status and message.
 */
const mapSyncResultToProgress = (result: MemberSyncResult): MappedResult => {
  switch (result.status) {
    case 'cloned':
      return {
        status: 'success',
        message: result.ref ? `cloned (${result.ref})` : 'cloned',
      }
    case 'synced':
      return {
        status: 'success',
        message: result.ref ? `synced (${result.ref})` : 'synced',
      }
    case 'updated':
      return {
        status: 'success',
        message: result.commit ? `updated → ${result.commit.slice(0, 7)}` : 'updated',
      }
    case 'locked':
      return {
        status: 'success',
        message: 'lock updated',
      }
    case 'already_synced':
      return {
        status: 'success',
        message: undefined,
      }
    case 'skipped':
      return {
        status: 'skipped',
        message: result.message,
      }
    case 'error':
      return {
        status: 'error',
        message: result.message,
      }
    case 'removed':
      return {
        status: 'success',
        message: 'removed',
      }
  }
}

// =============================================================================
// Layer Factory
// =============================================================================

/**
 * Create a layer with initial empty state.
 * Use this when you'll call initSyncProgress to set up the state.
 */
export const SyncProgressEmpty = layer

/**
 * Create a layer with pre-configured initial state.
 */
export const createSyncProgressLayer = (params: {
  megarepoRoot: string
  workspaceName: string
  memberNames: readonly string[]
}) => {
  const items: ProgressItemInput<SyncItemData>[] = params.memberNames.map((name) => ({
    id: name,
    label: name,
  }))
  const state = createState({
    items,
    metadata: {
      megarepoRoot: params.megarepoRoot,
      workspaceName: params.workspaceName,
    },
  })
  return layerWith(state)
}

// =============================================================================
// Sync Logs Service
// =============================================================================

/** Log entry type for sync operations */
export interface SyncLogEntry {
  readonly id: string
  readonly type: 'info' | 'warn' | 'error'
  readonly message: string
}

/** SubscriptionRef holding sync log entries */
export type SyncLogsRef = SubscriptionRef.SubscriptionRef<readonly SyncLogEntry[]>

/** Service tag for sync logs */
export class SyncLogs extends Context.Tag('SyncLogs')<SyncLogs, SyncLogsRef>() {}

let logIdCounter = 0

/**
 * Append a log entry to the sync logs.
 */
export const appendSyncLog = (entry: Omit<SyncLogEntry, 'id'>) =>
  Effect.gen(function* () {
    const ref = yield* SyncLogs
    const id = `log-${++logIdCounter}`
    yield* SubscriptionRef.update(ref, (logs) => [...logs, { ...entry, id }])
    return id
  })

/**
 * Get the current sync logs.
 */
export const getSyncLogs = () =>
  Effect.gen(function* () {
    const ref = yield* SyncLogs
    return yield* SubscriptionRef.get(ref)
  })

/**
 * Clear all sync logs.
 */
export const clearSyncLogs = () =>
  Effect.gen(function* () {
    const ref = yield* SyncLogs
    yield* SubscriptionRef.set(ref, [])
  })

/**
 * Layer providing an empty SyncLogs service.
 */
export const SyncLogsEmpty: Layer.Layer<SyncLogs> = Layer.effect(
  SyncLogs,
  SubscriptionRef.make<readonly SyncLogEntry[]>([]),
)
