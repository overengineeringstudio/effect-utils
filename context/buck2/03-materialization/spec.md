# Materialization Spec

This document specifies the materialization action and the editor surface. It
builds on [requirements.md](./requirements.md). Mechanisms are
prototype-validated; see [.experiments/](./.experiments/).

## Status

Draft.

## Scope

**Defines:** the per-package materialization action, normalization, the editor
view, and the staleness gate.

**Does not define:** semantic dependency declaration (01), tool provisioning
(02), or cache transport (04).

## Materialization Action

```text
translate (genie, freshness-gated)
  pnpm-lock.yaml (+ pnpm-workspace.yaml, patches)
  -> per package version: fetch target (url, sha256 from generated sidecar)
                          extract target (tarball -> package tree artifact)
  -> per importer:        node_modules assembly target
  -> platform constraints on optional/platform packages (select())

fetch     download_file, remote-cacheable, network only here (DEPS-R08)
extract   tar -> package tree, remote-cacheable
assemble  importer virtual store: .pnpm/<name>@<ver>[_peer-suffix]/node_modules/<name>
          hardlinks from extract artifacts, relative symlinks for edges,
          workspace: edges as relative links, .bin entries as symlinks
          local_only (DEPS-T01); public node_modules output
```

No package manager executes inside Buck actions. pnpm is the developer-time
resolver that writes `pnpm-lock.yaml`; the generated sha256 sidecar is derived
from the lockfile's sha512 integrity values and verified against them at
generation, so it cannot disagree with the lockfile except by staleness, which
the freshness gate rejects. The lockfile's peer-suffixed snapshot keys map
directly to virtual-store entries; peer resolution is not re-derived.

Invalidation is structural (DEPS-R07): a changed package version re-runs its
fetch and extract and the assemblies of importers whose closure contains it;
unrelated importers are untouched. A change that leaves an importer's closure
byte-identical re-runs nothing for it.

Lifecycle scripts are not executed (ratified policy: builds disallowed;
`requiresBuild` is empty in the lockfile). A package that would require a
build fails admission until a declared mechanism exists. `patchedDependencies`
apply during extraction as declared inputs. Optional platform packages are
filtered by cpu/os constraints so foreign-platform entries are neither fetched
nor linked.

The assembled tree is relocatable (no absolute paths) but hardlinks share inodes
with extract artifacts; Buck resets output modes, so read-only protection is
applied on the published editor view, not inside `buck-out`. The retired
deploy-based two-stage action and its normalizer are recorded in
[the retained experiment](./.experiments/2026-08-26-two-stage-prune-install.md)
and superseded by
[the closure prototype](./.experiments/2026-08-30-declared-closure-prototype.md).

The package-tree API projects declared workspace files into the output for
cacheable consumers; the editor-surface realization provides DEPS-R03
live-source links outside the cacheable package tree without weakening
DEPS-R02.

## Editor Surface

```text
packages/@overeng/tui-core/node_modules
  -> ../../.editor-view/tui-core/node_modules       (stable first hop)
packages/.editor-view/tui-core
  -> .store/tui-core-<editor-inputs-fingerprint>   (atomic current pointer)
packages/.editor-view/.store/tui-core-<fingerprint>/
  editor-view.json
  node_modules/                                    (hardlink snapshot)
```

The literal two-level first hop is part of the scoped contract. From
`packages/@overeng/tui-core` it resolves to `packages/.editor-view`, not the
repository-root `.editor-view`; `packages/.editor-view` is therefore the owning
state root for scoped `packages/@overeng/*` editor views.

`//packages/@overeng/tui-core:editor_inputs` exposes the canonical Stage-1
descriptor tree carried by `PnpmNodeModulesInfo.editor_inputs`. The existing
`:node_modules` default output and provider identity remain valid. The
publisher fingerprints the built `:editor_inputs` artifact rather than
reimplementing manifest discovery.

Every published snapshot contains this repository-local record:

```json
{
  "schema": "effect-utils/editor-view/v1",
  "package": "packages/@overeng/tui-core",
  "cell": "tui-core",
  "target": "//packages/@overeng/tui-core:editor_inputs",
  "editorInputsFingerprint": "<lowercase SHA-256 tree digest>",
  "snapshot": ".store/tui-core-<editorInputsFingerprint>",
  "nodeModulesTreeDigest": "<lowercase SHA-256 tree digest>"
}
```

The tree digest begins with the `effect-utils/tree-digest/v1` domain separator.
Entries are traversed by unsigned UTF-8 byte order. Each entry frames its kind
and repository-relative path with an unsigned 64-bit big-endian byte length;
regular files additionally frame size then bytes, symlinks frame their target,
and directories frame their own entry. Unsupported special files and entries that mutate while hashing fail closed.

Publication holds the exclusive `packages/.editor-view/.publish.lock`, created
atomically. Any existing lock rejects publication immediately and prints the
explicit token-gated `recover-lock` operation; there is no age heuristic,
sleep, timeout, or automatic stale-lock theft. Under the lock the publisher:

1. hashes the admitted `editor_inputs` and `node_modules` outputs;
2. creates same-filesystem `.store/.candidate-*` state;
3. invokes the immutable Nix GNU `cp -al` without a byte-copy fallback;
4. verifies every regular file shares device and inode with the admitted tree,
   verifies the complete candidate digest, and writes `editor-view.json`;
5. renames the candidate to deterministic
   `.store/tui-core-<editorInputsFingerprint>`;
6. creates a same-directory candidate symlink and renames it over `tui-core`;
7. installs the package first hop once. If root pnpm left a directory or other
   entry there, immutable Nix GNU `mv --exchange --no-copy` swaps it with the
   candidate link without an absent-path window, and the exchanged entry is
   retained under `.legacy/`.

An already-correct first hop is validated and never mutated during later
refreshes. Published snapshots are immutable and are never deleted by publish,
check, or lock recovery; snapshot garbage collection is outside this spec. A
failure before the current-pointer rename leaves the old current view intact.

The flip target is a `cp -al` snapshot of the action output, not `buck-out`
itself: Buck deletes an action's output directory before re-running it, which
would leave the stable link dangling for the whole action (measured 3.06 s
window). Hardlink snapshot publication closes that window without duplicating
file bytes.

## Staleness Gate

The scoped `buck2:tui-core:publish-editor` and
`buck2:tui-core:check-editor` tasks each build the current `:editor_inputs` and
`:node_modules` outputs with a task-private Buck daemon into ignored scratch,
then stop the daemon and remove both scratch and its private Buck output. They
call the pinned Bun publisher or checker respectively. The checker validates
record schema and identity, both symlink hops, store containment, pointer
liveness, snapshot completeness, and admitted versus recorded versus snapshot
node_modules digests. It does not call tsgo as an oracle.

Missing, malformed, escaping, dangling, incomplete, or stale state fails with
both the recorded and current editor-input fingerprints named. The scoped
publish/check tasks are intentionally not dependencies of global check, test,
or TypeScript tasks during this cutover.
`buck2:tui-core:recover-editor-lock` is the only recovery surface; it requires
the exact printed owner token through `EDITOR_VIEW_LOCK_TOKEN` and neither
builds nor mutates snapshots (DEPS-R06).

## Relationship to Exact Closure Materialization

The declared closure above is the per-package fetch-and-verify tier that the
retired package-evidence regime anticipated. It is introduced with live
consumers (the admitted packages) under the Buck admission contract; no
evidence infrastructure from the retired regime is revived.
