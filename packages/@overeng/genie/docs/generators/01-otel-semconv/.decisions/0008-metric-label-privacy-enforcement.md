# 0008 — Metric-label / privacy enforcement: mechanism invariants vs consumer policy

**Status:** Accepted. Resolves SC-DQ3.

## Context

The catalog carries per-attribute `cardinality` (`low`/`bounded`/`high`) and `encode`
(incl. `redacted`) policy annotations. Beyond deriving encoders, should this subsystem GATE
which attributes may be used as metric LABELS — rejecting high-cardinality or secret
attributes — or is that the downstream consumer's semantic contract (policy)?

## Decision

**The mechanism enforces the HARD invariants; the consumer's contract owns the richer policy.**

- **Mechanism (already implemented, `@overeng/otel-contract` `assertMetricLabels`, author-time):**
  a metric label MUST be `low`/`bounded` cardinality and MUST NOT use a `drop` encoder. A
  high-cardinality label is rejected at author time. This is a hard correctness invariant, kept
  as-is — no change.
- **No `redacted`-label rule is added.** `redacted` encodes to the constant mask `'<redacted>'`
  (not the secret), so a redacted attribute used as a metric label emits a low-cardinality
  constant that leaks nothing. The "secret as a metric label" threat the proposed rule would
  guard is therefore **void** — the rule would defend a non-threat on the wrong axis and only
  block a harmless (useless) case. Rejected.
- **Consumer contract (policy):** which specific bounded attributes are permitted as labels for
  a given metric, privacy CLASSES beyond the already-safe redaction (pii/internal/public),
  finer cardinality tiers — these live in the downstream consumer's own semantic contract, not
  in this mechanism. Consistent with the spec's scope (this subsystem is mechanism; the
  semantic/privacy contract is owned by each downstream consumer).

## Rationale (evidence)

See [.experiments/2026-07-03-metric-label-enforcement.md](../.experiments/2026-07-03-metric-label-enforcement.md).
Two findings settled it:

1. **`redacted` masks the value** (`OtelAttr.encode('redacted')` → constant `'<redacted>'`) — so
   the privacy invariant is unnecessary.
2. **Metric-label cardinality cost is active-series (RAM) bound, not disk bound.** A large
   telemetry-storage disk does not relieve high-cardinality metric-label cost (Prometheus/Mimir
   active-series limits are RAM-gated). The fleet's own telemetry contract already mandates
   bounded-only metric labels and keeps ids/versions/paths as trace/log attributes — so the
   existing high-cardinality gate is warranted and fleet-aligned.

## Consequences

- No code change: `assertMetricLabels` stays as the single author-time metric-label gate.
- SC-DQ3 is resolved on the effect-utils (mechanism) side; the richer per-metric label policy
  remains a cross-repo concern owned by the consumer's contract.

## Alternatives rejected

- **Add a `redacted`-label rejection** — void (the value is already masked; not a leak).
- **Add a design-time weaver-registry metric-label gate** — redundant with the author-time
  runtime gate; deferred as unneeded machinery (revisit only if a non-TS producer authors
  metrics directly against the registry).
- **Relax the high-cardinality gate on "big disk" grounds** — the premise is wrong (RAM/series,
  not disk, is the constraint).
