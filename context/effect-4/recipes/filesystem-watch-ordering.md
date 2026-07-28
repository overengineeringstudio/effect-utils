# Pattern: filesystem-watch-ordering

**Area:** Platform / FileSystem watch  **Kind:** semantic / real breakage  **Our usage:**
`megarepo` and `genie` watch modes depend on event membership and non-recursive boundaries.

## v3

```ts
import { FileSystem } from "@effect/platform"

const fs = yield* FileSystem.FileSystem
const directChildren = fs.watch(root, { recursive: false })
const wholeTree = fs.watch(root, { recursive: true })
```

## v4

```ts
import { FileSystem } from "effect"

const fs = yield* FileSystem.FileSystem
const wholeTree = fs.watch(root)
```

There is no beta.102 equivalent for `recursive: false`.

## Equivalence

```sh
bun run run filesystem-watch-ordering
```

Result: **ALLOWLISTED, 1 exact path, 0 unexpected**. The invariant trace gates create /
modify / delete-action path membership, rapid-write coalescing, recursive membership, rename and
delete-recreate convergence. All stable invariants match except
the non-recursive boundary: v4 additionally reports `nested/child.txt`.

The first raw ordered probe was intentionally repeated before classification. Five identical runs
produced four unique v3 trace hashes and three unique v4 trace hashes. Create/update order and the
number of coalesced rapid-write events varied within a major. Exact event order is therefore
**NOT GATED**. The final probe waits for and compares stable membership/convergence invariants, as
described in the harness README.

## Intended differences (alignment register entries)

- `filesystem-watch-recursive-option-removed`: **real breakage, not accepted**. Restore the option
  upstream or preserve non-recursive behavior with a migration shim before porting affected watch
  loops. Silently widening a watch can trigger spurious rebuilds or watch loops.

## Precise beta.102 characterization

- Type level: core `FileSystem.watch` changed from
  `(path, options?: WatchOptions)` to `(path)`; `WatchOptions` is gone.
- Backend abstraction: `WatchBackend.register` also receives no recursive selection, so a custom
  backend cannot recover the call-site option through the standard interface.
- Node runtime: `@effect/platform-node-shared` calls `node:fs.watch(path, { recursive: true })`
  unconditionally.
- Bun runtime: `@effect/platform-bun` delegates its FileSystem layer to the same shared Node
  implementation, so it has the same forced-recursive behavior.
- The installed target contains no other runtime FileSystem adapter to characterize. The core
  option removal still applies to every implementation of the beta.102 service interface.

Upstream duplicate check found no issue describing this beta.102 regression. The closest issues
are Effect-TS/effect#2986, the closed request that originally added the option, and #5913, an open
v3 issue about accidentally falling back to *non-recursive* watching through layer order. Neither
covers removal plus forced recursion.

### Draft upstream report (do not file without orchestrator review)

**Title:** Effect 4 beta.102 removes `FileSystem.watch` recursive control and forces recursive Node watches

**Body:**

> In Effect 3.21.4, `FileSystem.watch(path, { recursive: false })` observes only direct children
> and `{ recursive: true }` observes nested paths. In Effect 4.0.0-beta.102, the `WatchOptions`
> parameter is removed from `FileSystem.watch` and `WatchBackend.register`, while
> `@effect/platform-node-shared/NodeFileSystem` calls `node:fs.watch` with
> `{ recursive: true }` unconditionally. `@effect/platform-bun` delegates to that layer.
>
> Reproduction: create `root/nested`, watch `root`, then create `nested/child.txt` followed by
> `root/direct.txt`. v3 with `{ recursive: false }` reports only `direct.txt`; beta.102 reports
> both paths, and there is no typed way to request the v3 behavior.
>
> This silently widens watch scope and can cause spurious rebuilds or watch loops. Please restore
> a recursive option through the core interface, `WatchBackend`, and Node implementation, with
> `false` preserving the v3 non-recursive behavior.

## Repository tag-dependency audit

Four production `FileSystem.watch` consumers were checked:

- `genie` watch mode and both `notion-md` watchers filter by path and re-read state; they do not
  branch on `Create` / `Update` / `Remove`.
- `megarepo` StoreLock explicitly removes `onPermitsReleased` from the filesystem semaphore
  backing and uses polling, specifically to avoid `fs.watch` edge cases.
- `utils/src/node/file-system-backing.ts` does filter semaphore wakeups to `Update | Remove` and
  ignores `Create`. Genie target locks use this backing. This is a pre-existing fragile
  optimization because tag classification is unreliable.

The distributed semaphore always races the push stream against a 100 ms polling acquisition loop.
A missed or misclassified push event therefore adds polling latency but does not lose correctness
or liveness. Hardening the filter to treat any event for the watched lock directory as a wakeup is
separate pre-existing work, not part of this migration slice.

## Gotchas

- OS watch event order, coalescing, and even delete `Remove` classification are non-deterministic
  within one Effect major. Gate path membership and final convergence, not exact tags, order, or
  event count.
- Rename may be surfaced as platform `rename` events that Effect classifies after an asynchronous
  stat; do not assume a portable create/remove pair ordering.
- A passing recursive watcher does not prove non-recursive behavior remains available.

## Codemod rule

No codemod. Any v3 call passing `recursive: false`, or relying on the default non-recursive
behavior, requires semantic mitigation. Calls explicitly using `recursive: true` may drop the
option only after their invariant replay passes.
