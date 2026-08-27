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
Stage 1: prune descriptor
  broad manifest skeleton
    root package.json + full pnpm-lock.yaml + pnpm-workspace.yaml
    + all workspace package.json files + declared patches
  -> fixed output-derived stage
  -> pinned pnpm 11.8.0 deploy --offline --frozen-lockfile
  -> read <deploy>/node_modules/.pnpm/lock.yaml; discard deployed tree
  -> canonical lock + replay files + install-descriptor.json

Stage 2: frozen install
  Stage-1 descriptor TREE + pinned Bun/pnpm + materializer/normalizer
  -> copy descriptor TREE to a distinct fixed output-derived stage
  -> rehydrate file://<WS> to that install stage
  -> pinned pnpm 11.8.0 install --offline --frozen-lockfile
  -> existing deploy-tree normalization and symlink containment
  -> public PnpmNodeModulesInfo / node_modules output
```

Both actions remain internal to the public `pnpm_node_modules` rule. Its label,
default output, and existing provider fields remain compatible; the provider also
exposes the Stage-1 tree as `editor_inputs`. Stage 2 does
not receive the full lockfile, workspace manifest, root manifest, all workspace
package manifests, or the full patch map directly. Its only dependency-data
bridge is the content digest of Stage 1's descriptor TREE; tool/runtime inputs
and the pinned toolchain remain explicit. Therefore broad irrelevant manifest
churn can rerun only `pnpm_pruned_lock` when the descriptor bytes are unchanged
(DEPS-R07).

Stage 1 uses the pinned Bun runtime's built-in YAML parser and stringifier. The
canonicalizer recursively sorts mapping keys and fixes indentation at two
spaces. It replaces every fixed staging-root occurrence in mapping keys and
scalar values with the literal `file://<WS>`, removes only
`packages.<package-key>.peerDependencies`, and retains `snapshots`, resolved
peer suffixes, and `peerDependenciesMeta`. Malformed top-level `importers`,
`packages`, or `snapshots`, replacement key collisions, and residual stage
prefixes fail closed.

The descriptor TREE has this exact repository-owned schema:

```text
pnpm_install_descriptor/
  install-descriptor.json
  pnpm-lock.yaml
  package.json
  pnpm-workspace.yaml
  <repo-relative workspace package>/package.json  # only reachable file: records
  <repo-relative patch path>                      # only lock-required mappings
```

```json
{
  "schema": "effect-utils/pnpm-install-descriptor/v1",
  "packageName": "<target package name>",
  "files": {
    "lockfile": "pnpm-lock.yaml",
    "packageManifest": "package.json",
    "workspaceManifest": "pnpm-workspace.yaml",
    "workspacePackageManifests": ["<sorted repo-relative paths>"],
    "patches": ["<sorted repo-relative paths>"]
  },
  "installArgv": [
    "--dir",
    "<INSTALL_ROOT>",
    "--store-dir",
    "<STORE_DIR>",
    "install",
    "--prod=false",
    "--ignore-scripts",
    "--offline",
    "--frozen-lockfile"
  ]
}
```

The replay `package.json` preserves target metadata but derives dependency
sections from canonical `importers['.']` specifiers; this is necessary because
pnpm deploy can contextualize a specifier. The replay workspace contains only
`packages: []`, the lock's `autoInstallPeers` and
`excludeLinksFromLockfile` settings when present, `ignoreScripts: true`, and
patch mappings required by the pruned lock. Every `file:` reference must map to
a staged workspace manifest and every pruned patch hash must map through the
workspace policy to a declared patch path; otherwise Stage 1 fails. Source
files are never descriptor inputs.

Stage 2 invokes exactly the descriptor argv after replacing the two
placeholders. Its warm store supplies only lock-integrity-addressed bytes. An
empty store fails with `ERR_PNPM_NO_OFFLINE_TARBALL`; no network fallback is
permitted (DEPS-R08). It then removes JSON `.modules.yaml` fields `prunedAt`
and `storeDir`; deletes `node_modules/.pnpm/lock.yaml`, the root lockfile, and
`.pnpm-workspace-state-v1.json`; rewrites every recursive `.bin` shim relative
to its own `$basedir`; prunes dangling links; and rejects retained stage,
store, worktree, output, or escaping symlink references (DEPS-R02).

`pnpm deploy` remains required only in Stage 1 because it is the sole mode that
emits pnpm's authoritative pruned install lock. The deploy-root lockfile is not
pruned, and mini-workspace `--lockfile-only` re-resolution resolves different
versions. The two-stage replay is byte-keyed by the canonical pruned result,
not by that broad derivation. On the current Linux platform, frozen replay
omits 131 foreign-platform optional tree entries that deploy over-materializes;
this is the only permitted one-way output difference (DEPS-T01). See
[the retained experiment](./.experiments/2026-08-26-two-stage-prune-install.md).

The containment rule deliberately does not permit a workspace link whose
resolved destination is the live worktree. Such a link necessarily escapes the
relocatable action output. The package-tree API can project declared workspace
files into the output and link to that contained projection, but that is not
DEPS-R03 live-source behavior; the editor-surface realization therefore still
needs a boundary outside the cacheable package tree that satisfies DEPS-R03
without weakening DEPS-R02.

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

The retired package-evidence regime has no retained closure compiler. The
current deploy-based action owns the declared-input boundary directly. A future
per-package fetch-and-verify tier must introduce its closure implementation
with a live consumer and pass the Buck admission contract rather than reviving
unused evidence infrastructure.
