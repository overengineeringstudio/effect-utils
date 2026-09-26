# Megarepo Spec

This document specifies the megarepo tool (`mr`): what it arranges on disk and
how members are mounted into a megarepo. It builds on
[requirements.md](./requirements.md); terms are defined in
[ontology.md](./ontology.md).

## Status

Draft.

The tool's "why" is [vision.md](./vision.md), and
[requirements.md](./requirements.md) is ratified (2026-09-02). This spec
remains a draft: it records the ratified target — including the source
hierarchy the follow-up restructure PR is measured against — ahead of the
implementation reaching it.

## Scope

**Defines:** repo arrangement, source mounts, the CLI surface, and the source
hierarchy.

**Does not define:** the buck2-facing composition contract — the standalone
root shape, cell identity, action-identity hygiene, and the rule that source
mounts are never cells (`COMP-R*`) live in
[../buck2/05-composition/](../buck2/05-composition/requirements.md) and are
referenced here, never restated. Nor does it define buck2 execution,
materialization, or cache wiring (`../buck2/02-*` … `../buck2/04-*`).

## Responsibility

`mr` arranges repositories: it resolves declared sources into the host-global
store and mounts each member into the megarepo.

```text
  megarepo.kdl (intent)                  megarepo.lock (resolved state)
        │                                        │
        ▼                                        ▼
  resolve sources → bare repos + per-ref worktrees in the store
        │                     └─ liveness, hygiene, GC
        ▼
  repos/<name> → store worktree (source mount)
```

The store is durable, host-global, and shared across every megarepo on the
machine. Mounts are per-megarepo and disposable: `mr apply` rebuilds them from
the lock plus the store.

## Repo Arrangement

### Intent and resolved state

Two files, never merged:

| File            | Role           | Authored     | Committed |
| --------------- | -------------- | ------------ | --------- |
| `megarepo.kdl`  | intent         | by hand      | yes       |
| `megarepo.lock` | resolved state | by `mr` only | yes       |

`megarepo.kdl` declares members as `name "<source>"`, where the source is a
GitHub shorthand (`owner/repo`), an HTTPS or SSH URL, or a local path, each
optionally suffixed `#<ref>`. `megarepo.lock` records, per member, the resolved
`url`, `ref`, 40-char `commit`, a `pinned` flag, and `lockedAt`. Local-path
members are not lock entries: there is nothing to resolve.

`pinned` and ref type are independent axes. Ref type says what a member
_tracks_ (branch mutable; tag and commit immutable); `pinned` says whether
`mr fetch --apply` may advance it.

### Store layout

The store (`$MEGAREPO_STORE`, default `~/.megarepo`) holds one bare repo per
remote and one worktree per ref, keyed by the ref's own path:

```text
~/.megarepo/<host>/<owner>/<repo>/
  .bare/                       # shared git objects
  HEAD -> refs/heads/<default> # default-branch tracking
  refs/heads/<branch>/         # branch worktree (mutable ref)
  refs/tags/<tag>/             # tag worktree (immutable)
  refs/commits/<sha>/          # commit worktree (immutable, pinned materialization)
  .archive/<name>/             # GC capture area, reaped after the retention TTL
  .state/                      # liveness registry, GC config, observation ledger
```

The path is the identity: `refs/{type}/{raw-ref-path}/` says both what a
worktree is checked out at and how mutable it is. A `refs/commits/<sha>/`
worktree is a _pinned materialization_ — `mr` put it there to satisfy an exact
lock entry, so its sha drifting from the lock is a contract violation, not a
skip (decision [0009](./.decisions/0009-apply-drift-postcondition.md)).

### Ref classification

Ref type is resolved in two phases. Phase 1 queries the local bare repo after
fetch (`refs/tags/<ref>`, then `refs/remotes/origin/<ref>`) — authoritative,
and the reason tags such as `jq-1.6` classify correctly. Phase 2 is a
heuristic fallback when the repo cannot answer: 40-char hex ⇒ commit; a
semver-like pattern (bare or prefixed) ⇒ tag; otherwise branch.

### Store liveness, hygiene, and GC

The store is shared across every megarepo on the host, so reclamation is
governed by cross-workspace evidence rather than by any single workspace's
view. Each workspace publishes its `livePaths` into the liveness registry at
`$STORE/.state/workspaces/<hash>.json`; membership of a path in _any_
workspace's live set is an absolute veto on deleting it.

Default `mr store gc` reclaims cold `refs/heads/*` worktrees through
short-circuiting gates in this order — default-branch guard, cross-megarepo
liveness veto, staleness (GitHub PR merged or closed), lossless floor, grace
timers — then captures by archive and reaps only after the retention TTL
(decision [0001](./.decisions/0001-reclaim-cold-worktrees-in-default-gc.md)).
`ref_mismatch` worktrees take a distinct clean-archive path that never invokes
the `mr store fix` repair behavior, trading the PR-state signal for a stronger
clean/lossless floor (decision
[0008](./.decisions/0008-ref-mismatch-clean-archive.md)). `--all` is the
protection-bypassing mode and honors none of this.

Absence of evidence never licenses deletion: an unavailable `gh`, a failed
fetch, an unreadable workspace record, or an empty observation ledger all
resolve to _keep_.

## Source Mounts

`mr apply` makes the workspace match the lock: each remote member's
`repos/<name>` becomes a symlink to the store worktree that satisfies its lock
entry, and each local-path member's to its path. A mount is a source checkout
for reading, editing, and running the member's own tooling; it is never a Buck
cell (COMP-R02 in
[../buck2/05-composition/](../buck2/05-composition/requirements.md)).

A branch worktree resolves to its canonical store path `P` only when Git's
registration agrees: the branch is registered exactly at `P`, or nowhere while
`P` is absent or registered for no branch. Any other registration is refused
as ambiguous rather than shadowed. A member path that is a real directory or
file rather than a symlink is foreign and refused before replacement.

`mr store worktree new` creates standalone worktrees only. The composed
workspace shape — an owned worktree at `P/repos/<owned>`, read-only `cp -a`
mounts, dist overlays, per-workspace capability projection, and a synthesized
Buck root — is retired (principal q5, 2026-09-25).

## CLI Surface

| Command                          | Responsibility | Contract                                                              |
| -------------------------------- | -------------- | --------------------------------------------------------------------- |
| `mr init` / `mr add`             | arrangement    | create `megarepo.kdl`; add a member declaration                       |
| `mr fetch --apply`               | arrangement    | fetch remotes, advance unpinned members, then update the lock         |
| `mr lock`                        | arrangement    | record current workspace commits into the lock; never touches remotes |
| `mr apply`                       | mounts         | lock → workspace, exactly; never modifies the lock                    |
| `mr status` / `mr ls`            | both           | report intent vs lock vs workspace drift; read-only                   |
| `mr pin`                         | arrangement    | freeze a member against `mr fetch --apply`                            |
| `mr store gc` / `status` / `fix` | arrangement    | reclaim, report, and repair store worktrees                           |
| `mr exec`                        | both           | run a command across members                                          |
| `mr check`                       | both           | validate config, lock, and workspace consistency                      |

Filtering (`--only` / `--skip`, mutually exclusive) applies to bulk
arrangement commands; generators skip members that were not synced rather than
failing on a missing path.

Member-list views render with a spotlight model: items inside the cwd-derived
scope render fully, items outside it are dimmed, and `--all` disables dimming
because the user asked for the whole picture. Scope is supplied through a React
context and applied centrally by the shared row component — individual
renderers never set dimming for scope purposes, so the rule cannot drift per
view.

## Source Hierarchy

The hierarchy below was ratified as the target (q10, 2026-08-31) and is now the
current layout: `src/lib/` no longer exists.

```text
packages/@overeng/megarepo/src/
  core/                  # repo arrangement primitives
    git.ts ref.ts lock.ts config.ts
    megarepo-traversal.ts issues.ts observability.ts
    source-policy.ts version.ts
    nix-lock/
  store/                 # store layout, branch-worktree resolution, liveness, hygiene, GC, locks
  sync/                  # member sync: store fetch, worktree placement, mount inspection
  generators/            # config-file generators (vscode workspace, JSON schema)
  buck2-capabilities/    # capability projection run by the Nix buck2-capabilities output
  buck2-manifest.ts      # public subpath export: ./buck2-manifest
  *.contract.ts          # OTel semantic-convention contracts, read by path
  cli/                   # unchanged
```

`core/` imports none of its siblings: repo arrangement is usable, and
testable, on its own. `store/` is the home of the `store-*` family. Store
layout, liveness, hygiene and GC are arrangement-side, but the family is too
large to sit as loose files in `core/`, so it gets a sibling directory.
`sync/` and `generators/` are siblings of `core/` rather than members of it,
because they compose `core/` and `store/`.

`buck2-manifest.ts` stays a top-level file: it is the package's public subpath
export (`@overeng/megarepo/buck2-manifest`) and its stability contract is
external. `buck2-capabilities/capability-projection.ts` is shipped by path in
the Buck rules product and executed by `nix/buck2-capabilities.nix`. The
`*.contract.ts` files likewise stay at the `src/` root, because the weaver
registry references them by path. Tests stay colocated with their subject
(`*.unit.test.ts`, `*.integration.test.ts` beside the module).

## Open Design Questions

None open.
