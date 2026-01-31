/**
 * Sync Progress Module
 *
 * Provides createTuiApp-based progress tracking for sync operations
 * with Effect Schema validated state and dispatch-based updates.
 */

// Sync app (createTuiApp-based)
export {
  // App factory
  createSyncApp,
  createInitialState,
  createConnectedView,
  // Reducer
  syncProgressReducer,
  // View
  SyncProgressView,
  // Schemas
  SyncProgressState,
  SyncProgressAction,
  SyncItem,
  SyncItemStatus,
  SyncLogEntry,
  // Types
  type SyncApp,
} from './sync-app.tsx'

// Sync UI (createTuiApp-based, React)
export {
  startSyncProgressUI,
  finishSyncProgressUI,
  // Action helpers
  mapSyncResultToAction,
  createSyncingAction,
  createCompleteAction,
  createLogAction,
  createInitAction,
  // Types
  type SyncProgressUIHandle,
} from './sync-ui-react.tsx'
