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
  // Sync logs
  SyncLogs,
  SyncLogsEmpty,
  appendSyncLog,
  getSyncLogs,
  clearSyncLogs,
  type SyncItemData,
  type SyncProgressService,
  type SyncLogEntry,
  type SyncLogsRef,
} from './sync-adapter.ts'

// Sync-specific UI (ANSI-based)
export { startSyncProgressUI, finishSyncProgressUI, type SyncProgressUIHandle } from './sync-ui.ts'

// Sync-specific UI (React-based)
export {
  startSyncProgressUI as startSyncProgressUIReact,
  finishSyncProgressUI as finishSyncProgressUIReact,
  SyncProgressReactLayer,
  type SyncProgressUIHandle as SyncProgressUIHandleReact,
} from './sync-ui-react.tsx'
