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

Both actions remain internal to the public `pnpm_node_modules` rule. The label,
default output, and `PnpmNodeModulesInfo` provider are unchanged. Stage 2 does
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
<pkg>/node_modules -> ../../.editor-view/<cell>/node_modules   (stable link)
.editor-view/<cell> -> .editor-view/.store/<cell>-<stamp>      (atomic flip)
```

The flip target is a `cp -al` snapshot of the action output, not `buck-out`
itself: Buck deletes an action's output directory before re-running it, which
would leave the stable link dangling for the whole action (measured 3.06 s
window); the snapshot costs ~0.23 s and closes it entirely. A live tsserver
resolves through the two-hop link and survives flips without restart; vitest
runs through the same view.

## Staleness Gate

Before a materialized view is used, its recorded manifest fingerprint is
compared against the repository's current manifests; mismatch fails with both
fingerprints named (DEPS-R06). The gate runs in the refresh flow and in CI
entry points. This inverts the status-quo failure mode, where a removed
dependency stays silently green locally and only a fresh CI install notices.

## Relationship to the Closure Compiler

The exact lockfile-closure compiler in `@overeng/buck2-tools` remains dormant
as the front-end for a future exact-materialization tier (per-package fetch
and verify materializers). The deploy-based action is the same declared-input
boundary, so upgrading tiers later swaps the implementation behind the target
without reworking consumers.
