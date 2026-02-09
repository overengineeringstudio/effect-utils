/**
 * Sync Library
 *
 * Core sync functionality for megarepo.
 */

export {
  getCloneUrl,
  getCloneUrlHttps,
  getRepoSemaphore,
  type GitProtocol,
  makeRepoSemaphoreMap,
  type MissingRefAction,
  type MissingRefInfo,
  resolveCloneUrl,
  syncMember,
  type RepoSemaphoreMap,
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
  type SyncOptions,
} from './types.ts'
