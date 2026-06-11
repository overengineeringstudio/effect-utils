# Merged PR is the primary staleness signal

## Status

accepted

## Context

A worktree's branch being "merged" is the strongest "this work is done" evidence.
The real-store survey proved the git-only proxy (HEAD is an ancestor of
`origin/main`) is useless here because the repos squash-merge: merged branches
sit hundreds–thousands of commits "ahead" of main (e.g. a MERGED branch 597 and
another 1179 commits ahead). Reliable merged-detection therefore requires the
GitHub PR state, joined by branch name (`gh pr list --state all --json
number,state,headRefName,mergedAt`, one batched call per repo, join locally).

## Decision

Use GitHub PR state (PR for the branch is MERGED) as the primary positive
staleness signal, accepting the coupling of stale-deletion to GitHub + `gh`/API +
network. This is acceptable because the store is, in practice, entirely
`github.com/*` and `mr` already models github sources.

Conservative degradation: when no merged-PR evidence is available — no PR, a
non-GitHub remote, or `gh` unavailable/unauthenticated — the worktree is NOT
eligible for stale deletion and is kept. Absence of evidence never licenses
deletion.

## Consequences

- Branches with no PR (incl. never-pushed agent scratch worktrees) and
  closed-unmerged PRs are not collected by the merged-primary path (closed-PR
  handling may be added later as a separate, lower-confidence tier).
- The deletion path needs a branch→PR-state resolver with batching + caching to
  stay within API rate limits; treat resolver failure as "no evidence" (keep).
- Merged-detection cost/latency lives on the GC path; keep it off the hot path of
  ordinary `mr` commands.
