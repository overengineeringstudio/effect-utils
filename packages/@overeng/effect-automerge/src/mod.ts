/**
 * Effect bindings for automerge-repo.
 *
 * - `AutomergeRepo`: the repo as a service (scoped layer, typed `find`, retrying lookups,
 *   scoped network adapters, typed durable save acknowledgements).
 * - `DocHandles`: a ready `DocHandle` as a `Stream` of documents or a `SubscriptionRef`.
 *   These views replay observable state, including changes not yet saved to storage.
 * - `SafeStorageAdapter`: storage that degrades to memory-only instead of failing.
 */
export {
  AutomergeRepo,
  findRetrySchedule,
  make,
  type AutomergeRepoService,
  type RepoOptions,
  type ShareConfig,
} from './AutomergeRepo.ts'
export * as DocHandles from './DocHandles.ts'
export {
  DocDeleted,
  DocUnavailable,
  InvalidDocumentId,
  RepoPersistenceError,
  type FindError,
} from './errors.ts'
export { SafeStorageAdapter } from './SafeStorageAdapter.ts'
