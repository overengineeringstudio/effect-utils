# DELTA-002: Editor bootstrap warm integrity exceeds BUCK-R07

Status: open

## Divergence

BUCK-R07 requires a warm no-op at no more than 5 s. The bounded generator
bootstrap now publishes the repository-root view and the OpenTelemetry contract
view required by the Weaver import closure, but local-disk warm samples measured
8.61 s, 7.18 s, and 7.76 s. The fresh sample remains within budget at 62.6 s.

## VRS

- [BUCK-R07](../../requirements.md) carries the 5 s warm and 3 min fresh
  budgets.
- [REUSE-R03](../../04-reuse/requirements.md) applies those budgets to the
  admitted reuse surface.
- The implementation and timing evidence are recorded in
  `/srv/bulk/coding-agents/_reports/effect-utils.editor-bootstrap-r07.md`.

## Implementation

Each published view retains the editor-view integrity contract: a warm
publication re-hashes every byte-owned immutable snapshot payload before reuse.
The second required view adds another payload proof. Backing and `node_modules`
fingerprints within a snapshot and publications using disjoint editor-root
locks now overlap, but shared-disk contention leaves the two-view warm path
2.18–3.61 s above the budget.

## Direction

update implementation

## Resolution Signal

Decide whether the editor-view integrity record may persist a recursive metadata
proof alongside the byte digest. If approved, warm reuse validates that metadata
proof and falls back to the byte proof on any mismatch; tamper regressions must
still fail closed. Close this delta when three controlled warm bootstrap samples
are each at or below 5 s while the two-view closure checker, direct Weaver load,
and snapshot-integrity tests remain green.
