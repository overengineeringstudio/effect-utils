# Staleness = merged-or-closed PR; the default branch is never eligible

## Status

accepted

## Context

A branch being "merged" is the strongest "this work is done" evidence, but the
survey proved the git-only proxy (HEAD an ancestor of `origin/main`) is useless
because the repos squash-merge — merged branches sit hundreds–thousands of commits
"ahead" of main (one MERGED branch was 597, another 1179 ahead). Reliable
merged-detection therefore needs the GitHub PR state.

Dry-run validation surfaced a hazard: `ai/nanoid main` — a vendored dependency's
default branch — was archive-eligible because the PR-state join matched an old
upstream PR whose `headRefName` was `main` while the worktree was in no recorded
live set. Archiving a dependency's default branch is never wanted, and common
names (`main`/`master`) are the ones most prone to such join false positives.

## Decision

The positive staleness predicate is: the branch's GitHub PR is **merged OR
closed** (joined by branch name; one batched `gh pr list --state all` per repo).
Closed-unmerged counts under the same gates — the lossless floor self-protects the
risky case (a closed branch deleted from its remote has unreachable commits and is
kept). An **open PR or no PR ⇒ keep**; absence of evidence never licenses deletion
(non-GitHub remote / `gh` unavailable / resolver failure all ⇒ keep).

A hard **default-branch guard** runs before any staleness/liveness logic: a
worktree whose ref equals its repo's default branch (read offline from the bare's
`HEAD`, `Git.getStoreDefaultBranch`) is NEVER reclaimed, regardless of PR state or
liveness — a belt-and-suspenders complement to the cross-megarepo veto.

## Consequences

- Stale-deletion is coupled to GitHub + `gh`/network; acceptable because the store
  is in practice entirely `github.com/*`. The resolver batches + caches per gc run
  and lives off the hot path of ordinary `mr` commands.
- The resolver returns state (merged/closed/open/none) + `mergedAt`/`closedAt` (for
  the post-merge grace, [0005](0005-three-reclamation-timers.md)).
- Branches with no PR (incl. never-pushed agent scratch) are never collected.
