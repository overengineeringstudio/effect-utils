/**
 * CLI output renderers
 *
 * React components and utilities for CLI output.
 */

export { outputLines, formatMemberState, formatSyncResult, formatActionLine } from './common.ts'
export type { MemberState, SyncStatus } from './common.ts'

// React components
export { SyncOutput } from './SyncOutput.tsx'
export type { SyncOutputProps, MemberSyncResult } from './SyncOutput.tsx'

export { StatusOutput } from './StatusOutput.tsx'
export type { StatusOutputProps, MemberStatus, GitStatus, LockStaleness } from './StatusOutput.tsx'

// PinOutput TuiApp (new pattern)
export {
  PinApp,
  PinView,
  PinState,
  PinAction,
  pinReducer,
  isPinError,
  isPinSuccess,
  isPinAlready,
  isPinDryRun,
  isPinWarning,
  createInitialPinState,
} from './PinOutput/mod.ts'
export type { PinViewProps, PinStateType, PinActionType } from './PinOutput/mod.ts'

// AddOutput TuiApp (new pattern)
export {
  AddApp,
  AddView,
  AddState,
  AddAction,
  addReducer,
  isAddError,
  isAddSuccess,
  isAddIdle,
  isAddAdding,
  createInitialAddState,
} from './AddOutput/mod.ts'
export type { AddViewProps, AddStateType, AddActionType } from './AddOutput/mod.ts'

// Legacy Store components (for stories)
export {
  StoreListOutput,
  StoreFetchOutput,
  StoreGcOutput,
  StoreHeader,
  StoreAddError,
  StoreAddProgress,
  StoreAddSuccess,
} from './StoreOutput.tsx'
export type {
  StoreListOutputProps,
  StoreFetchOutputProps,
  StoreGcOutputProps,
  StoreGcWarningType,
  StoreHeaderProps,
  StoreRepo,
  StoreFetchResult,
  StoreGcResult,
  StoreAddErrorType,
  StoreAddErrorProps,
  StoreAddProgressProps,
  StoreAddSuccessProps,
} from './StoreOutput.tsx'

// StoreOutput TuiApp (new pattern)
export {
  StoreApp,
  StoreView,
  StoreState,
  StoreAction,
  StoreLsState,
  StoreStatusState,
  StoreFetchState,
  StoreGcState,
  StoreAddState,
  StoreErrorState,
  StoreRepo as StoreRepoSchema,
  StoreFetchResult as StoreFetchResultSchema,
  StoreGcResult as StoreGcResultSchema,
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
  createInitialStoreState,
} from './StoreOutput/mod.ts'
export type {
  StoreViewProps,
  StoreStateType,
  StoreActionType,
  StoreRepoType,
  StoreFetchResultType,
  StoreGcResultType,
  StoreWorktreeIssueType,
  StoreWorktreeStatusType,
  StoreGcWarningType as StoreGcWarningSchemaType,
} from './StoreOutput/mod.ts'

// ExecOutput TuiApp (new pattern)
export {
  ExecApp,
  ExecView,
  ExecState,
  ExecAction,
  ExecRunningState,
  ExecCompleteState,
  ExecErrorState,
  MemberExecStatus,
  execReducer,
  isExecError,
  isExecComplete,
  isExecRunning,
  createInitialExecState,
} from './ExecOutput/mod.ts'
export type {
  ExecViewProps,
  ExecStateType,
  ExecActionType,
  MemberExecStatusType,
} from './ExecOutput/mod.ts'
