/**
 * CLI output renderers
 *
 * Pure functions that render data to string arrays for CLI output.
 */

export { outputLines, formatMemberState, formatSyncResult, formatActionLine } from './common.ts'
export type { MemberState, SyncStatus } from './common.ts'

export { renderStatus } from './status-renderer.ts'
export type {
  MemberStatus,
  StatusRenderInput,
  GitStatus,
  LockStaleness,
} from './status-renderer.ts'

export { renderSync } from './sync-renderer.ts'
export type { MemberSyncResult, SyncRenderInput } from './sync-renderer.ts'
