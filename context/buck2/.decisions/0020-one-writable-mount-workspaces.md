# 0020 One-Writable-Mount Workspaces with Read-Only cp -a Member Mounts

Status: accepted

## Context

Decision [0014](./0014-megarepo-cell-composition.md) committed to cells for
cross-member source deps but left two things open: mr's mount mechanism and
the workspace shape. Symlink mounts were then proven content-blind — Buck2
hashes the target string, not the member content, so edits do not invalidate
and one key serves stale artifacts
([../05-composition/.experiments/2026-08-27-symlink-content-blindness.md](../05-composition/.experiments/2026-08-27-symlink-content-blindness.md)) —
and the interim proposal (read-only mounts with writable mounts deferred) was
adversarially broken: the hub repo held two cell identities (root of its own
builds, member in 255 compositions), violating COMP-R02 exactly where
development happens, and Phase 2 itself would have manufactured the deferred
writable-mount demand
([../05-composition/.experiments/2026-08-27-adversarial-review-0020.md](../05-composition/.experiments/2026-08-27-adversarial-review-0020.md)).

## Evidence and Argument

Four investigations closed the space:

- The workflow survey measured live cross-workspace branch sharing at one
  deliberate use in 37,061 recorded mutations, with shared `main` worktrees
  carrying weeks-old uncommitted lockfile drift that silently rewrote
  dependency identity for consumers. Authoring through mounts versus member
  worktrees ran 1:820; the practiced cross-repo flow is commit-mediated
  upstream-first.
- The mount-mechanism e2e
  ([../05-composition/.experiments/2026-08-27-readonly-mount-e2e.md](../05-composition/.experiments/2026-08-27-readonly-mount-e2e.md))
  disqualified hardlink farms (chmod protects the store through shared
  inodes; demonstrated corruption laundering into the cache) and git-worktree
  mounts for the read-only role (no atomic regeneration: a half-failed
  checkout moved HEAD over stale bytes that Buck2 silently built), and
  validated `cp -a` from the immutable store with a RENAME_EXCHANGE advance
  (4 ms atomic swap under a live daemon; six-point regeneration contract).
- The workspace prototype proved the full shape: byte-identical action
  digests between a writable dev worktree and a read-only consumer mount at
  the same commit; a third workspace at 100% remote cache; the criterion-6
  round trip with a discriminating key transition (the consumer's lookup key
  changed as a result of the mount advance alone and hit an entry only the
  dev workspace could have written); acquire ~380 ms at real scale;
  acquire-to-push under 2 s; exclusivity enforced by git itself (a second
  worktree on the same branch is refused). The fleet policy guards (worktree
  placement, search depth) force the workspace root onto the existing store
  worktree path — which is also the layout that keeps every store-hygiene,
  GC, and search rule working.
- `git submodule` was evaluated and rejected: independent object stores
  forfeit sharing, gitlinks duplicate megarepo.lock into git history, and
  fixed relative paths fight COMP-R02 under nesting. No simpler prior art
  delivers content-real and writable-shared simultaneously without a daemon
  or privilege (the EdenFS class).

## Options

| Option                                                        | Tradeoff                                                                                     | Outcome  |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------- |
| One-writable-mount workspaces (this decision)                 | One cell identity per repo everywhere; workspace model moves one level down                  | Accepted |
| Read-only mounts now, writable deferred                       | Hub keeps two digest namespaces; Phase 2 manufactures the deferred demand                    | Rejected |
| Full ref-type-keyed shape incl. shared-branch writable mounts | Exclusivity/prune machinery scoped to arbitrary shared branches; consumer measured vestigial | Rejected |
| Keep symlinks, forbid cache upload from compositions          | Zero mr work; content-blind inputs and no cross-repo reuse — forfeits criterion 6            | Rejected |

## Decision

Every repository — including the one under development — lives at
`repos/<name>` inside a synthesized workspace root located at the existing
store worktree path (`…/<owner>/<repo>/refs/heads/<branch>/`), which holds
`.buckconfig`, `.buckroot`, the toolchains cell, `buck-out`, and the mounts.
The owned repo is the workspace's single writable branch-attached git
worktree; exclusivity is git's own one-worktree-per-branch rule. Every other
member is a read-only `cp -a` mount of its locked revision, advanced by
stage + RENAME_EXCHANGE under the six-point regeneration contract, with the
capability projection copied in per (toolset, platform) and verified by its
`--check` gate. Members ship no `.buckconfig` (a bare checkout then fails
loudly before doing anything). Agents' default cwd is the owned member,
which is a normal git repository and preserves today's DX. Live
cross-workspace branch sharing retires as a mutation surface; storage dedup
survives via git object sharing and the shared cache. CI composition roots
may be store-resident and disposable.

The Buck2-era agent workflow contract (q12) is normative and gets a rev 3
rewritten for this shape (the authoring surface is the workspace's writable
member; `repos/<other>` is a read-only build input).

## Consequences

Carried obligations, tracked as Phase-2 checklist items in the execution
epic:

- S0 guards land before any conversion: loud non-zero on non-symlink mounts
  and refuse-to-delete-foreign real directories (18 exist in the wild).
- mr code change for the `CI=true` silent-detach trap (loud diagnostic or
  refusal), not a contract line.
- A named retirement phase for the legacy in-mount write consumers (overeng
  pnpm task modules, dotfiles bun-from-mount execution) — those compositions
  keep symlink mounts and stay out of the shared cache namespace until
  retired.
- Cross-member TypeScript consumption (types for consumed members without
  node_modules/dist in read-only mounts) is an owned open question.
- Per-member `[project] ignore` audit (live-worktree drift found 121
  untracked entries including gaps for `**/dist`, `**/__pycache__`,
  `packages/.editor-view`).
- macOS verification of the RENAME_EXCHANGE primitive (GNU `mv --exchange`
  on APFS) plus cp -a/chmod semantics before Darwin admission.
- Full-scale (tierA) build validation; fixture-scale digest claims are exact
  but small.
- Follow-ups filed separately: the devenv-profile PATH shadowing of the
  policy git wrapper (guard bypass affecting all agents), and the
  same-build lookup/upload key mismatch anomaly observed on a genrule.
