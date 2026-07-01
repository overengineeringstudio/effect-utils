# 0003 — One catalog key per concept: full dotted keys everywhere (incl. metric labels)

**Status:** Under reconsideration. Originally Accepted by user decision, but an adversarial
design review surfaced new information not weighed at decision time (see "Reconsideration"
below). Pending a fresh call.

## Reconsideration (open)

A review argued the (c) justifications don't hold up: metric-label ref-ability is NOT unique
to (c) — the rejected option (a) (short-key metric-label namespace) is also weaver-valid and
was the prototype's own "honest modeling" conclusion — so the only real gain of (c) over (a)
is one catalog entry instead of two. Against that, (c)'s cost is larger than first stated:
renaming an emitted metric label (`service`→`restate_service` in Prometheus) causes a
permanent TSDB series discontinuity, **silently** breaks recording rules/alerts (no error,
just no data), and **destroys the cross-service `service` join key** used by `sum by
(service)` / `group_left` across exporters. Under the two-layer design this is orthogonal to
the layer split. Leading reconsidered recommendation: adopt (a) and, if consistency is
wanted, link the span-attr and label entries with a lint rather than a wire rename. To be
decided with the user.

## Context

A concept can appear under different keys per signal: today the restate span uses attribute
`restate.service` while the restate metric uses the short Prometheus-style label `service`
(and `outcome`, `handler`, …). SC-DQ6 asked how a single catalog expresses that. Two viable
models (both prototyped): (a) metric labels are their own catalog namespace with short keys
(wire unchanged), or (c) one catalog entry per concept with the full dotted key used
everywhere, including as the metric label.

## Decision

**Option (c): one catalog entry per concept; the full dotted attribute key is used
everywhere, including metric labels.** A metric references the same catalog attribute a span
does; there is no short-key alias. This is the OTel-idiomatic model — semantic conventions
use dotted attribute keys, and the OTLP→Prometheus exporter performs the dotted→underscore
mapping (`restate.service` → Prometheus `restate_service`). It maximizes the single-SSOT /
clean-derivation property the design optimizes for, and keeps first-party metric labels
weaver-`ref`-able against the same catalog and upstream semconv.

## Consequences

- **Live telemetry migration (must be coordinated).** Emitted metric label keys change
  (`service` → `restate.service`, surfacing in Prometheus as `restate_service`). Existing
  dashboards, alerts, and recording/queries that reference the old short labels MUST be
  updated. This is a fleet-wide change owned by the migration plan (SC-DQ5) and coordinated
  with whoever owns the affected dashboards (a downstream, private observability surface).
  Not a silent authoring tweak.
- Metric-label cardinality policy still applies (a high-cardinality attribute remains
  invalid as a metric label) — enforced against the single catalog entry.
- Simpler catalog: no per-context alias machinery; every key is decided once.
- SC-R15 is satisfied by construction (keys are catalog-governed, never ad hoc).

## Alternatives rejected

- **(a) metric-label namespace with short keys:** avoids the wire migration but keeps a
  concept under two keys and two catalog entries. Rejected in favor of a single SSOT per
  concept, accepting the migration cost.
