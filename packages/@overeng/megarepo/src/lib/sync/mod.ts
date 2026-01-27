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
  flattenSyncResults,
  type MegarepoSyncResult,
  type MemberSyncResult,
  type MemberSyncStatus,
  type SyncOptions,
} from './types.ts'
