/**
 * Sync Library
 *
 * Core sync functionality for megarepo.
 */

export {
  getCloneUrl,
  getCloneUrlHttps,
  type GitProtocol,
  type MissingRefAction,
  type MissingRefInfo,
  resolveCloneUrl,
  syncMember,
} from './member.ts'
export {
  countSyncResults,
  collectAllMemberResults,
  collectSyncErrors,
  flattenSyncResults,
  type MegarepoSyncResult,
  type MemberSyncResult,
  type MemberSyncStatus,
  type SyncMemberError,
  type SyncMode,
  type SyncOptions,
} from './types.ts'
