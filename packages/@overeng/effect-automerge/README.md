# @overeng/effect-automerge

Effect 4 bindings for [`@automerge/automerge-repo`](https://automerge.org/docs/repositories/): scoped repository ownership, typed document lookup and persistence errors, document streams, and storage degradation. Works with browser and Node repository adapters; transport, storage backend, authorization, and application schemas remain caller-owned.

## Owner

`agent/effect-utils/effect-utils-manager`

## Usage

```ts
import { Effect } from 'effect'
import { AutomergeRepo, DocHandles } from '@overeng/effect-automerge'

const program = Effect.gen(function* () {
  const repo = yield* AutomergeRepo
  const handle = yield* repo.create({ count: 0 })
  yield* DocHandles.change(handle, (doc) => {
    doc.count++
  })
  return yield* DocHandles.current(handle)
}).pipe(Effect.provide(AutomergeRepo.layer({ network: [] })))
```

This example is memory-only. Supply a `StorageAdapterInterface` as `storage` when constructing the layer, and await `repo.save(handle)` before acknowledging durable changes. Calling `save` or `flush` without tracked persistent storage fails with `RepoPersistenceError` rather than reporting durability.

## Repository API

- `AutomergeRepo.layer(options)` accepts `RepoOptions` or an Effect producing them. It acquires the repository in the layer's scope and always attempts shutdown when that scope closes, including after flush failure. Finalizer failures are logged as typed `RepoPersistenceError` values.
- `shareConfig` accepts the repository's share configuration or a function of the newly created repository. `RepoOptions` otherwise follows the upstream repository configuration, excluding the obsolete `sharePolicy` option.
- `find<T>(documentId)` waits for a ready handle. Invalid IDs, unavailable documents, and deleted documents produce `InvalidDocumentId`, `DocUnavailable`, and `DocDeleted` respectively (`FindError`). Interrupting the Effect aborts the lookup.
- `findWithRetry<T>(documentId, schedule?)` retries only unavailable documents. Exported `findRetrySchedule` backs off from 500 ms in 500 ms increments, capped at three seconds, indefinitely. Pass a bounded schedule when indefinite waiting is inappropriate.
- `create(initialValue)` exposes an immediately observable in-memory document.
- `attachNetwork(adapter)` attaches a caller-supplied network adapter for the lifetime of the calling scope.
- `save(handle)` persists the current document state; concurrent later edits require another save. `flush` saves loaded documents. Both fail when storage is absent or degraded.
- `interop.repo` is the explicit boundary to the underlying `Repo`.

`make(repo, storage?)` wraps an existing repository without taking ownership of its lifetime. `AutomergeRepo.fromRepo(repo, storage?)` exposes that wrapper as a layer; it does not shut the repository down. Pass the actual storage adapter used by the repository so durability checks track it.

## Document views and ephemeral messages

`DocHandles` functions expect a ready handle:

- `changes(handle)` emits the current document and subsequent local or remote changes. Slow consumers receive coalesced latest state, not a change log; the event listener is removed when the stream closes.
- `subscriptionRef(handle)` mirrors document state for the caller's scope. Writing to that ref does not mutate the document.
- `current(handle)` reads the current document; `change(handle, fn)` applies a local mutation. Neither operation acknowledges persistence.
- `ephemeral(handle)` returns an `EphemeralChannel` with `send(message)` and an `incoming` stream of `EphemeralMessage` values (`senderId`, `message`). These messages reach peers currently syncing the document and are never persisted. Validate received payloads and bind them to their sender before application use.

Observable document views can include changes not yet saved to storage.

## Storage degradation

`SafeStorageAdapter(make, onDisable?)` wraps a storage backend. Construction or operation failure disables that backend, retains the original error in `failure`, calls `onDisable`, and allows the repository to continue in memory. `persistent` is false after failure or when no backend was supplied. Disabled reads return no stored content and writes do not persist; this is availability, not durable storage. The repository wrapper checks this state before and after saves so a swallowed backend failure cannot become a durable acknowledgement.

## Dependencies and checks

The binding uses `@automerge/automerge-repo` 2.5.6 and Effect 4.1.0. Existing lifecycle and storage-adapter tests are colocated under `src/`. The package participates in the repository's Buck TypeScript admission and generated `test:effect-automerge` task. Run the repository's declared Buck, lint, test, and Genie checks from the standalone repository root.
