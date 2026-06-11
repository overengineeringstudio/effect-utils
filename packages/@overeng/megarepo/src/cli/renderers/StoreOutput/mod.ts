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
  StoreWorktreeNewState,
  StoreFixState,
  StoreFixResult,
  StoreErrorState,
  StoreRepo,
  StoreFetchResult,
  StoreGcResult,
  StoreGcResultStatus,
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
  isStoreWorktreeNew,
  isStoreFix,
} from './schema.ts'
export type {
  StoreState as StoreStateType,
  StoreAction as StoreActionType,
  StoreRepo as StoreRepoType,
  StoreFetchResult as StoreFetchResultType,
  StoreGcResult as StoreGcResultType,
  StoreGcResultStatus as StoreGcResultStatusType,
  StoreWorktreeIssue as StoreWorktreeIssueType,
  StoreWorktreeStatus as StoreWorktreeStatusType,
  StoreGcWarning as StoreGcWarningType,
  StoreFixResult as StoreFixResultType,
} from './schema.ts'

// App
export { StoreApp, createInitialStoreState } from './app.ts'

// Views
export { StoreView, type StoreViewProps } from './view.tsx'
