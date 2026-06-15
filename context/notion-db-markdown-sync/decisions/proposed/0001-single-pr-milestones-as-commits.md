# Single PR with milestones as incremental verified commits

Status: proposed (user-confirmed)

Epic #775 spans 8 implementation phases across three packages. The delivery
shape is a single PR (#775) where each phase lands as an incremental verified
commit (green `check:all`, sub-agent-reviewed) rather than a stack of per-phase
PRs merged separately to `main`.

This matches the user's explicit instruction that "one coherent system lands at
once." Revertibility is preserved per commit. Because all work lives in one repo,
there is no megarepo repin/merge-order overhead that a stacked approach would
incur.

## Considered Options

| Option                                                     | Result   | Reason                                                                                                                          |
| ---------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Single PR #775; milestones = incremental verified commits  | Selected | Matches "one coherent system lands at once"; no repin overhead; per-commit revertibility; explicitly confirmed by user.         |
| Megarepo PR stack (one PR per phase, merged incrementally) | Rejected | Integrated system is incomplete until the last PR; introduces repin/ordering overhead; contradicts user's explicit instruction. |

## Consequences

Review must be done milestone-by-milestone (not as a single final diff) since the
total diff will be large. Each phase commit must be independently green before
the next phase begins. The PR body serves as the durable epic checklist.
