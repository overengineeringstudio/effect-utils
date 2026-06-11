# Closed-unmerged PRs count as a staleness signal (extends 0005)

## Status

accepted (extends decision 0005, which had deferred closed-PR handling)

## Context

A closed-but-unmerged PR means the work was resolved without landing. Its commits
are not in `main`. The concern is "I closed it but might revisit". The mitigating
insight: the lossless floor self-protects the risky case — recoverability requires
the commit to be reachable on a remote, and a closed PR whose head branch was
deleted on the remote has unreachable commits (not in main either), so the floor
keeps the worktree automatically. Only closed branches still present/reachable on
the remote are reclaim candidates, and those lose nothing on deletion (re-fetchable).

## Decision

Treat a CLOSED-unmerged PR as a valid staleness signal under the SAME gates as a
merged PR (cross-megarepo veto, lossless floor, the three timers). No separate
longer grace for closed — the lossless floor already differentiates recoverable
from not.

The primary staleness predicate is therefore: the branch's PR is **merged OR
closed**. Absence of any PR (open, or no PR at all) still means keep.

## Consequences

- Slightly more reclaim (closed-unmerged worktrees whose branches are still on
  the remote).
- An OPEN PR is never a staleness signal — open work is kept regardless of age.
- The staleness resolver must return PR state (merged/closed/open/none) +
  `mergedAt` (for post-merge grace; closed uses `closedAt` analogously if a
  post-close grace is later desired).
