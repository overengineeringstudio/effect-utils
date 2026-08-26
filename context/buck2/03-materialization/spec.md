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
inputs: all workspace package.json + pnpm-lock.yaml + pnpm-workspace.yaml
        + declared patches            (manifest skeleton; no sources)
  -> stage skeleton at a fixed path derived from the output
  -> chmod manifests writable (generated manifests are checked in read-only)
  -> pnpm deploy --offline --frozen-lockfile --store-dir <shared store>
  -> normalize: delete pnpm metadata files, rewrite .bin shims,
     prune dangling optional-dep symlinks
  -> replace injected workspace-dep copies with relative symlinks
     to live member sources (symlink-back)
output: relocatable node_modules tree (relative symlinks, store hardlinks)
```

`pnpm deploy` is the only pnpm mode emitting internal-relative symlinks; a
normal workspace install emits upward-escaping links and is not relocatable.
Fixed-path staging is load-bearing: pnpm encodes the staging path into
virtual-store keys, so a random staging dir breaks determinism. Measured cost:
~1 s for a 74-package closure, ~3 s for a 328-package closure, from a warm
store.

Keying upgrade (DEPS-R07): a first stage prunes the lockfile per package
(deploy emits this natively); the install action keys on the pruned lockfile,
so unrelated manifest churn stops invalidating the cell.

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
