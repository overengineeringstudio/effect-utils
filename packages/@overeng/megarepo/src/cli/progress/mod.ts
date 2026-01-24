/**
 * Generic Progress Module
 *
 * Provides a reusable SubscriptionRef-based progress tracking pattern
 * that separates operation logic from UI rendering.
 */

// Service factory
export {
  createProgressService,
  // State helpers
  emptyState,
  createState,
  updateItem,
  addItem,
  removeItem,
  markComplete,
  // Query helpers
  isAllDone,
  getStatusCounts,
  getElapsed,
  getItemsByStatus,
  // Types
  type ProgressItemStatus,
  type ProgressItem,
  type ProgressState,
  type ProgressItemInput,
} from './service.ts'

// UI factory
export {
  createProgressUI,
  type ProgressUIOptions,
  type ProgressUIHeader,
  type ProgressUIHandle,
} from './ui.ts'

// Sync-specific adapter
export {
  SyncProgress,
  SyncProgressLayer,
  SyncProgressEmpty,
  createSyncProgressLayer,
  initSyncProgress,
  setMemberSyncing,
  applySyncResult,
  completeSyncProgress,
  getSyncProgress,
  syncProgressChanges,
  type SyncItemData,
  type SyncProgressService,
} from './sync-adapter.ts'

// Sync-specific UI
export {
  startSyncProgressUI,
  finishSyncProgressUI,
  type SyncProgressUIHandle,
} from './sync-ui.ts'
