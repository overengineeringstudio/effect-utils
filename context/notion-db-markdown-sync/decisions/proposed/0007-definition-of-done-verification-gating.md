# Definition of done and verification gating for PR #775

Status: proposed

"Done" for PR #775 requires all of the following:

- Every named guard (R13) has at least one test at the cheapest sufficient layer
  (L0–L7 matrix).
- Every user-visible workflow has at least one CLI/E2E test.
- L6 live covers the API-semantic-only cases: schema drift, relation
  completeness, files/comments capability, and read-after-write settlement.
- `dt check:quick --no-tui` and `dt check:all --no-tui` are green before each
  milestone handoff; full live suite is green before final ready-for-review.
- Every spec section traces to a requirement; no VRS doc presents two competing
  contracts (Phase 0 acceptance criterion).

## Considered Options

| Option                                                                                                 | Result   | Reason                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full gating: named guards × test layers + CLI/E2E + L6 live + check:all green + VRS trace completeness | Selected | Matches the VRS's correctness claims; live-only semantics cannot be proven by fakes; Phase 0 must establish a single coherent contract before implementation. |

## Consequences

If a live scenario is structurally unprovable in the synthetic workspace, it must
be documented as a ratification-gated gap, not silently dropped. The gap document
must identify the missing invariant and the condition under which it becomes
provable.
