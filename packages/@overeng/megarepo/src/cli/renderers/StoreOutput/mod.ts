/**
 * StoreOutput Module
 *
 * Re-exports for all store command outputs.
 */

// Schema
export {
  StoreState,
  StoreAction,
  StoreLsState,
  StoreStatusState,
  StoreFetchState,
  StoreGcState,
  StoreAddState,
  StoreErrorState,
  StoreRepo,
  StoreFetchResult,
  StoreGcResult,
  StoreWorktreeIssue,
  StoreWorktreeStatus,
  StoreGcWarning,
  storeReducer,
  isStoreError,
  isStoreLs,
  isStoreStatus,
  isStoreFetch,
  isStoreGc,
  isStoreAdd,
} from './schema.ts'
export type {
  StoreState as StoreStateType,
  StoreAction as StoreActionType,
  StoreRepo as StoreRepoType,
  StoreFetchResult as StoreFetchResultType,
  StoreGcResult as StoreGcResultType,
  StoreWorktreeIssue as StoreWorktreeIssueType,
  StoreWorktreeStatus as StoreWorktreeStatusType,
  StoreGcWarning as StoreGcWarningType,
} from './schema.ts'

// App
export { StoreApp, createInitialStoreState } from './app.ts'

// Views
export { StoreView, type StoreViewProps } from './view.tsx'
