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

export { PinOutput, PinErrorOutput, PinWarningOutput } from './PinOutput.tsx'
export type { PinOutputProps, PinErrorOutputProps, PinWarningOutputProps } from './PinOutput.tsx'

export { AddOutput, AddErrorOutput } from './AddOutput.tsx'
export type { AddOutputProps, AddErrorOutputProps } from './AddOutput.tsx'

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

export {
  ExecErrorOutput,
  ExecVerboseHeader,
  ExecMemberSkipped,
  ExecMemberPath,
  ExecMemberHeader,
  ExecStderr,
  ExecResultsOutput,
} from './ExecOutput.tsx'
export type {
  ExecErrorType,
  ExecErrorOutputProps,
  ExecVerboseHeaderProps,
  ExecMemberSkippedProps,
  ExecMemberPathProps,
  ExecMemberHeaderProps,
  ExecStderrProps,
  ExecResultsOutputProps,
  ExecMemberResult,
} from './ExecOutput.tsx'
