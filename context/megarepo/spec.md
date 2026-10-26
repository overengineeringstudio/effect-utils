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
mounts are never cells (`BUILD.BUCK.ROOT-R*`) live in
[../buck2/05-composition/](../builds/04-buck2/03-consumer-roots/requirements.md) and are
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

`mr store status` reports bare-store configuration issues once per repository
in `repoIssues`, independently of whether any worktrees or store `refs/`
directory exist. Member pre-flight hygiene checks report the same issues.
`missing_origin` means the bare store has no local `remote.origin.url`;
operators must configure the URL explicitly, and `mr store fix` skips it.
`missing_fetch_refspec` means origin exists but has no local
`remote.origin.fetch` key. `mr store fix` adds
`+refs/heads/*:refs/remotes/origin/*` only when that key is absent and origin
still exists, rechecking both under the store's Git writer lock. Existing fetch
configuration is preserved. Repair is idempotent and does not fetch, prune,
modify refs, or touch linked worktrees; `--dry-run` reports the proposed config
change only.

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
cell (BUILD.BUCK.ROOT-R02 in
[../buck2/05-composition/](../builds/04-buck2/03-consumer-roots/requirements.md)).

A branch worktree resolves to its canonical store path `P` only when Git's
registration agrees: the branch is registered exactly at `P`, or nowhere while
`P` is absent or registered for no branch. Any other registration is refused
as ambiguous rather than shadowed. A member path that is a real directory or
file rather than a symlink is foreign and refused before replacement.

### Exact-lock tracking selection (MR-R01)

MR-R01's pinned-materialization postcondition governs immutable commit mounts.
Preserving an author's branch worktree does not exempt the member mount from
the exact-lock selection rule: when that branch is unsuitable, apply preserves
it and selects the locked commit rather than leaving a divergent mount.

| Tracking branch state                                        | Member mount                 |
| ------------------------------------------------------------ | ---------------------------- |
| Canonical branch identity, clean tree, `HEAD == lock.commit` | `refs/heads/<branch>`        |
| `HEAD != lock.commit`, including ahead or behind             | `refs/commits/<lock.commit>` |
| Dirty canonical branch or unproven clean/exact state         | `refs/commits/<lock.commit>` |

Tracking mode is a read-only selection policy, not branch reconciliation.
`mr apply` and the apply phase of `mr fetch --apply` never checkout, reset, or
fast-forward canonical branch worktrees. A missing branch worktree may be
created only from an existing local branch already at the locked commit;
otherwise the locked commit worktree is materialized directly. Repointing the
member symlink preserves the original branch's ref, `HEAD`, index, files, and
uncommitted edits and does not require `--force`. Warm apply reuses the selected
worktree and converges without canonical mutation authorization.

Readiness reports commit drift or a dirty remote branch mount as apply-needed.
After fallback, the clean exact-commit mount is ready even when the preserved,
unmounted canonical branch remains ahead, behind, or dirty.

### Recursive materialization ownership

```text
create commit worktree → publish physical identity → release worktree lock
                              ↑
                  all recursive branches share freshness
```

`mr apply --all --lock-sync off` shares its visited roots and freshly created
commit-worktree identities across the entire invocation. Every commit-worktree
visit joins the same physical-path creation lock, including a visit that already
sees `.git` on disk: existence can precede completion of creation and publication
of freshness. Only the creator publishes freshness under that lock. Recursive
apply may populate the root and `repos/` mounts of those fresh commit worktrees;
a second recursive visit to the same physical root is a no-op.

Worktrees that existed before the invocation remain shared, not owned.
Recursive apply refuses canonical mutations there; freshness is neither
persisted nor inferred from existence. The freshness exception does not authorize
lock rewrites or generators' authoring outputs.

The invoking workspace is the one canonical root an author owns when it is a
non-default branch worktree (`refs/heads/<branch>` where `<branch>` is not the
store bare repo's default branch, its `HEAD`): top-level `mr apply` may populate
its root and `repos/` mounts. File-authoring writes use one author-workspace
authorization contract: config pin/unpin, `megarepo.lock` updates (including
`mr fetch --only`), generators, and Nix lock synchronization may write inside a
proven author workspace. Both the requested output path and its physical
destination must stay inside that same root. Directory and file aliases escaping
that root remain refused. This grant never authorizes branch/ref switching or
destructive canonical Git operations.
Shared-cache setup uses `mr apply --verify-shared --lock-sync off` to verify
selected members without running generators or making any writes; missing or
drifted members require preparation from the owning workspace or an owned worktree.
The default-branch worktree is the shared consumer cache and stays refused, as does a
branch root whose default branch cannot be resolved. Ownership is proven offline
from Git metadata, not from the path suffix: the root must be the top of a
worktree of the store's `.bare` whose `HEAD` is `refs/heads/<branch>` and which
sits at exactly `refs/heads/<branch>`; subdirectories of any worktree, detached
or mismatched worktrees stay refused. The author grant covers only paths
that physically resolve inside that root; tag worktrees, nested
megarepos visited by `--all`, and aliases into other store paths stay refused.
Accepted limitation: mr cannot tell one author's feature branch from
another's, so any non-default branch worktree used as the invoking root is
treated as owned (Git does not protect it either).

Top-level `mr apply --lock-sync off` may also prepare an invoking
`refs/commits/<H>` worktree when Git resolves its worktree root to that exact
physical root and its `HEAD` to exactly `<H>`. This materialization-only grant
covers only the root and its own physical `repos/` directory, not lock/config
writes, generators, branch advancement, or aliases into other trees. Lock sync
must remain off. It does not grant ownership to preexisting shared nested trees,
and neither tags nor branch paths gain permission from this commit grant.
Enabled generators cause `PermissionDenied` before any member mount is changed,
including when their output directories or files alias external destinations.

Consumers normally prepare the dependency tree through the outer workspace's
`mr apply --all`. A separately invoked exact-commit apply may prepare its own
mounts under the top-level grant above; it cannot repair preexisting shared
trees reached recursively. Package-install hooks may check that an already
prepared member has the locked commit and fail with instructions to prepare
it from the invoking workspace. An incomplete shared nested tree requires an
owned workspace or explicit administrative repair, not a freshness grant.

Local setup that needs nested trees names the members explicitly:
`mr apply --worktree-mode tracking --commit-members <a,b> --lock-sync off`.
The listed root members become commit worktrees and are applied recursively;
everything below them is applied in commit mode, so fresh worktrees carry the
freshness grant. Unlisted members use the exact-lock tracking selection above
and are not recursed into. A clean canonical branch exactly at the lock remains
the co-development mount; divergent or dirty branches are preserved while the
member mount selects the locked commit. `--only`/`--skip` select root members only;
the listed member's
fresh commit subtree is always applied completely or not created at all. A
nested commit worktree that existed before the invocation is
accepted only if its locked tree is already mounted; an incomplete one is
refused as above. The devenv `taskModules.megarepo` option
`setupCommitMembers` is the intended consumer path: `mr:setup` passes the list.
Local readiness checks the root with `mr status`, then runs `mr status --all`
inside each listed, non-skipped member that has its own megarepo configuration,
including on the outer setup cache-hit path. Unlisted nested trees do not affect
local readiness because local exec does not prepare them. The option is empty
by default, leaving `mr:setup` a tracking apply in owned workspaces or read-only
verification in shared canonical caches (`--verify-shared --lock-sync off`).
Even with an empty selection, root status runs on outer cache hits: a canonical
branch can change `HEAD` or become dirty without changing its member symlink.

CI setup (`CI=true`, the same predicate as `--worktree-mode auto`) never uses
tracking worktrees: `mr:setup` selects `--worktree-mode commit`, and with a
non-empty `setupCommitMembers` it passes `--commit-all-members`, which selects
every root member as `--commit-members` would, because `mr status --all`
readiness inspects every root member's nested tree. The selector is resolved
inside `mr` from the config, so member names containing commas are not split.
Readiness and apply then cover the same trees, and a warm rerun accepts the
prepared commit worktrees instead of refusing them.

`mr store worktree new` creates standalone worktrees only. The composed
workspace shape — an owned worktree at `P/repos/<owned>`, read-only `cp -a`
mounts, dist overlays, per-workspace capability projection, and a synthesized
Buck root — is retired (principal q5, 2026-09-25).

By default, `mr store worktree new` bootstraps a missing bare repository and
fetches remote refs (including tags). For source-only branch work from objects
already in the store, use
`mr store worktree new owner/repo --no-fetch --ref feature/local --base <full-commit-sha>`.
`--no-fetch` requires an existing bare repository and a full 40-character SHA
of a commit already present locally; branch names and abbreviated SHAs are
rejected. It never clones or fetches, including Git's implicit lazy fetching
from promisor remotes. Missing partial-clone objects fail locally during base
validation or checkout. Only the requested branch and standalone
worktree registration are created; existing refs, Git configuration, and
`FETCH_HEAD` are not refreshed. It does not write megarepo configuration, lock
files, or composition state.

`mr store worktree rm <path>` removes exactly one standalone store worktree,
under its bare repository's Git writer lock. It preserves every branch/tag ref
and sibling worktree. Default/canonical branches (`main`, `master`, and the bare
repository's default branch), locked registrations, and worktrees referenced by
registered workspaces are protected. Dirty/untracked work is refused unless
`--discard-changes` explicitly authorizes its removal; HEAD commits unreachable
from any remote are refused unless `--allow-unpushed` is explicit.

Editor-view teardown is a prerequisite, not an implicit side effect. Close
editors/builds and run `devenv tasks run worktree:teardown --mode single` inside
the retired worktree, leave it, then run `mr store worktree rm <path>`. Unreleased
editor roots are detected through the publisher's shared lifecycle markers and
produce a structured refusal with this guidance. `mr` never invokes devenv,
changes materialization permissions, or follows symlinks to remove external
trees. In particular, read-only editor snapshot files may be CAS hardlinks:
recursive chmod would corrupt other worktrees.

Plain `git worktree remove` can unlink tracked files, fail to unlink a payload
inside a read-only directory with EACCES, then delete its administration entry
anyway, leaving the remaining payload behind; `.git` may also have been deleted.
When `.git` survives, scoped removal repairs that dangling registration from its
existing store ref and applies the same safety checks; already deleted tracked
files count as changes and require explicit discard consent. If both ownership
markers are gone, it refuses even with discard consent: ownership cannot be
proven. Editor-view GC or release must reclaim any editor payload, otherwise an
operator removes the remnant manually. The opposite partial state (tree absent,
matching admin entry present) removes only that orphan entry, after protecting
staged changes and unpushed commits. Git has no path-scoped `worktree prune`, so
this command never runs repository-wide pruning. A second removal reports the
structured `not-found` error.

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

Nix lock rewriting during `mr apply` and `mr fetch --apply` is off by default;
`--lock-sync direct|recursive` opts in. `mr:lock-sync-check` reports lock drift
without rewriting it. Member repins are made as member PRs.

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
