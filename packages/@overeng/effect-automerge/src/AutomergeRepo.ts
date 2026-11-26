import {
  Repo,
  isValidAutomergeUrl,
  isValidDocumentId,
  parseAutomergeUrl,
  type DocHandle,
  type NetworkAdapterInterface,
  type RepoConfig,
  type StorageAdapterInterface,
} from '@automerge/automerge-repo'
import { Context, Duration, Effect, Layer, Schedule, type Scope } from 'effect'

import {
  DocDeleted,
  DocUnavailable,
  InvalidDocumentId,
  RepoPersistenceError,
  type FindError,
} from './errors.ts'
import { SafeStorageAdapter } from './SafeStorageAdapter.ts'

/** Share policy of the repo; may close over the repo itself (e.g. to inspect a doc). */
export type ShareConfig = NonNullable<RepoConfig['shareConfig']>

/** Repository configuration with an optional repository-aware share policy factory. */
export interface RepoOptions extends Omit<RepoConfig, 'shareConfig' | 'sharePolicy'> {
  readonly shareConfig?: ShareConfig | ((repo: Repo) => ShareConfig)
}

/** Effect operations and explicit interop for an Automerge repository. */
export interface AutomergeRepoService {
  /** Explicit boundary for third-party interop and debugging. */
  readonly interop: { readonly repo: Repo }
  /** Finds a document and waits until it is ready. Interrupting aborts the lookup. */
  readonly find: <T>(documentId: string) => Effect.Effect<DocHandle<T>, FindError>
  /**
   * Like `find`, but keeps retrying while the document is unavailable (e.g. while the peer
   * that has it is still connecting). Default: 500ms, 1s, 1.5s … capped at 3s, forever.
   */
  readonly findWithRetry: <T>(options: {
    readonly documentId: string
    readonly schedule?: Schedule.Schedule<unknown, FindError>
  }) => Effect.Effect<DocHandle<T>, InvalidDocumentId | DocDeleted | DocUnavailable>
  /** Immediately observable in memory; call save before acknowledging durability. */
  readonly create: <T>(initialValue: T) => Effect.Effect<DocHandle<T>>
  /** Adds a network adapter for the lifetime of the scope. */
  readonly attachNetwork: (
    adapter: NetworkAdapterInterface,
  ) => Effect.Effect<void, never, Scope.Scope>
  /** Saves loaded documents; fails if persistence is absent or degraded. */
  readonly flush: Effect.Effect<void, RepoPersistenceError>
  /** Saves the current state; later concurrent edits require another save. */
  readonly save: <T>(handle: DocHandle<T>) => Effect.Effect<void, RepoPersistenceError>
}

/** Linear backoff for document lookups: 500ms, 1s, 1.5s … capped at 3s. */
export const findRetrySchedule: Schedule.Schedule<number> = Schedule.forever.pipe(
  Schedule.modifyDelay(({ attempt }) =>
    Effect.succeed(Duration.millis(Math.min(500 * attempt, 3000))),
  ),
)

/** Wraps a repository with typed lookup and tracked persistence operations. */
export const make = ({
  repo,
  storage,
}: {
  readonly repo: Repo
  readonly storage?: StorageAdapterInterface
}): AutomergeRepoService => {
  const requireStorage = () => {
    if (
      storage === undefined ||
      (storage instanceof SafeStorageAdapter && storage.persistent === false)
    )
      throw new RepoPersistenceError({
        operation: 'save',
        cause:
          storage instanceof SafeStorageAdapter ? storage.failure : 'No tracked persistent storage',
      })
  }
  const persist = (documents?: Parameters<Repo['flush']>[0]) =>
    Effect.tryPromise({
      try: async () => {
        requireStorage()
        await repo.flush(documents)
        // SafeStorageAdapter lets Repo continue in memory after a failed save; Repo may
        // update its saved heads anyway. That must never become a durable acknowledgement.
        requireStorage()
      },
      catch: (cause) =>
        cause instanceof RepoPersistenceError
          ? cause
          : new RepoPersistenceError({ operation: 'save', cause }),
    })
  const find = <T>(documentId: string): Effect.Effect<DocHandle<T>, FindError> =>
    Effect.suspend(() => {
      if (isValidDocumentId(documentId) === false && isValidAutomergeUrl(documentId) === false)
        return Effect.fail(new InvalidDocumentId(documentId))
      const id =
        isValidAutomergeUrl(documentId) === true
          ? parseAutomergeUrl(documentId).documentId
          : documentId
      return Effect.tryPromise({
        try: (signal) => repo.find<T>(documentId, { signal }),
        catch: (cause) => classify({ documentId, handle: repo.handles[id], cause }),
      })
    })
  return {
    interop: { repo },
    find,
    findWithRetry: <T>({
      documentId,
      schedule = findRetrySchedule,
    }: {
      readonly documentId: string
      readonly schedule?: Schedule.Schedule<unknown, FindError>
    }) =>
      find<T>(documentId).pipe(
        Effect.retry({ schedule, while: (e) => e._tag === 'DocUnavailable' }),
      ),
    create: (initialValue) => Effect.sync(() => repo.create(initialValue)),
    attachNetwork: (adapter) =>
      Effect.acquireRelease(
        Effect.sync(() => repo.networkSubsystem.addNetworkAdapter(adapter)),
        () => Effect.sync(() => repo.networkSubsystem.removeNetworkAdapter(adapter)),
      ),
    flush: persist(),
    save: (handle) => persist([handle.documentId]),
  }
}

/** An automerge-repo `Repo` as an Effect service. */
export class AutomergeRepo extends Context.Service<AutomergeRepo, AutomergeRepoService>()(
  '@overeng/effect-automerge/AutomergeRepo',
) {
  /**
   * Closing always attempts shutdown, including after a failed flush. Failures are logged
   * with typed RepoPersistenceError values. Repo.shutdown disconnects then flushes again.
   */
  static readonly layer = <E = never, R = never>(
    options: RepoOptions | Effect.Effect<RepoOptions, E, R>,
  ): Layer.Layer<AutomergeRepo, E, Exclude<R, Scope.Scope>> =>
    Layer.effect(
      AutomergeRepo,
      Effect.gen(function* () {
        const { shareConfig, ...config } =
          Effect.isEffect(options) === true ? yield* options : options
        const repo = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const createdRepo = new Repo(config)
            if (shareConfig !== undefined)
              createdRepo.shareConfig =
                typeof shareConfig === 'function' ? shareConfig(createdRepo) : shareConfig
            return createdRepo
          }),
          (acquiredRepo) =>
            Effect.tryPromise({
              try: async () => {
                await acquiredRepo.flush()
                if (
                  config.storage instanceof SafeStorageAdapter &&
                  config.storage.persistent === false
                )
                  throw new RepoPersistenceError({
                    operation: 'flush',
                    cause: config.storage.failure,
                  })
              },
              catch: (cause) => new RepoPersistenceError({ operation: 'flush', cause }),
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logError('Automerge Repo finalizer flush failed', cause),
              ),
              Effect.ensuring(
                Effect.tryPromise({
                  try: () => acquiredRepo.shutdown(),
                  catch: (cause) => new RepoPersistenceError({ operation: 'shutdown', cause }),
                }).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logError('Automerge Repo shutdown failed', cause),
                  ),
                ),
              ),
            ),
        )
        return make({ repo, ...(config.storage === undefined ? {} : { storage: config.storage }) })
      }),
    )

  /** Wraps an existing repo (not shut down by the layer). */
  static readonly fromRepo = (options: {
    readonly repo: Repo
    readonly storage?: StorageAdapterInterface
  }): Layer.Layer<AutomergeRepo> => Layer.succeed(AutomergeRepo, make(options))
}

const classify = ({
  documentId,
  handle,
  cause,
}: {
  readonly documentId: string
  readonly handle: DocHandle<unknown> | undefined
  readonly cause: unknown
}): FindError => {
  if (
    handle?.isDeleted() === true ||
    (cause instanceof Error && /was deleted/.test(cause.message) === true)
  )
    return new DocDeleted(documentId)
  return new DocUnavailable(documentId)
}
