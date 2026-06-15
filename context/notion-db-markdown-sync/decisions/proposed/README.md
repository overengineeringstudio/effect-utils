# Proposed decisions (PR #775, pending human ratification)

These are agent-proposed decisions made autonomously during the implementation of
PR #775 ("land the full long-term Notion DB Markdown Sync VRS") to avoid blocking
on design forks. Each records the principled options considered, trade-offs,
evidence, and the chosen option.

**Status:** provisional. The human will ratify, revise, or drop each. Once
ratified, decisions graduate into the numbered `decisions/NNNN-*.md` sequence
(taking the next available number after 0013). Revised or dropped decisions are
noted here before removal.

**Provenance:** this directory replaces the single
`pr775-autonomous-decisions.md` file (git-removed). These are NOT VRS docs —
VRS stays timeless; this is a time-bound rationale ledger. The entire `proposed/`
directory may be deleted once all decisions are folded into ratified
`decisions/NNNN-*.md` records or the PR epic.

No secrets in these files (public repo). Notion token/page IDs are referenced by
name or non-secret identifier only.

## Files

| File                                                      | Decision                                             | Status                    |
| --------------------------------------------------------- | ---------------------------------------------------- | ------------------------- |
| `0001-single-pr-milestones-as-commits.md`                 | D1 — Single PR, milestones as commits                | proposed (user-confirmed) |
| `0002-live-notion-is-hard-gate-for-done.md`               | D2 — Live Notion L6 is a hard gate for done          | proposed                  |
| `0003-shared-property-write-core-in-new-package.md`       | D3 — Shared core in `@overeng/notion-property-write` | proposed                  |
| `0004-cross-cutting-context-vrs-is-canonical.md`          | D4 — Cross-cutting `context/` VRS is canonical       | proposed                  |
| `0005-clean-break-v1-delete-legacy-surfaces.md`           | D5 — Clean break v1, delete legacy surfaces          | proposed                  |
| `0006-orchestrator-per-milestone-adversarial-review.md`   | D6 — Orchestrator + per-milestone adversarial review | proposed                  |
| `0007-definition-of-done-verification-gating.md`          | D7 — Definition of done / verification gating        | proposed                  |
| `0008-webhook-scope-boundary-decoded-dirty-hints-only.md` | D8 — Webhook scope: decoded dirty hints only         | proposed                  |
| `0009-non-body-lifecycle-v1-boundaries-fail-closed.md`    | D9 — Non-body lifecycle v1 boundaries fail closed    | proposed                  |
| `0010-shared-guard-vocabulary-adopt-by-composition.md`    | D10 — Shared guard vocabulary, adopt-by-composition  | proposed                  |
| `0011-control-plane-file-split.md`                        | D11 — Control-plane file split (state.sqlite, DD-A/DD-B) | proposed               |
| `0012-tracked-phase-followups.md`                         | D12 — Tracked phase follow-ups not closed by PR #775 (F1–F7) | proposed            |

## Open items deferred to ratification

- D3 package-vs-client collapse (see revisit trigger in 0003).
- Any live scenario found structurally unprovable in the synthetic workspace.
- Final naming of v1 SQLite read-only surfaces (`changes`, `conflicts`,
  `sync_status`, `schema`, `debug_*`) — provisional from epic; will firm up in
  Phase 4.
- D10 relation guard name: `UnavailableRelationTarget` vs `RelationTargetsUnavailable`.
- D10 settlement guard name: `ReadAfterWriteMismatch` vs `SettlementContextMissing`.
