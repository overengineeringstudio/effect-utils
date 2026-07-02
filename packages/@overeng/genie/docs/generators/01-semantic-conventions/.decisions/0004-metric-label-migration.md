# 0004 — Metric-label rename: retention-first, bridge only when justified

**Status:** Accepted (approach). Concrete renames tracked as `/sk-live-migrations` entries.

## Context

[0003](./0003-unified-full-dotted-keys.md) moves a concept from a bare metric label
(`service`) to a namespaced key (registry `restate.service`, wire `restate_service`).
Getting existing metrics there must not break dashboards/alerts.

The `/sk-live-migrations` gate mandates running migration-avoidance first — and **metrics are
a rolling projection with retention, not durable state.** Mimir ages old series out on its
own; a label rename only has to cover the query window people actually use. So the default is
NOT a database-style migration bridge.

The OTel schema mechanism (`rename_attributes` + `schemaprocessor`) is rename-only, no
dual-emit (alpha), so where a bridge *is* needed it must be an OTTL `transform` copy, which
Grafana Alloy (already the metric path → Mimir) runs natively.

## Decision

**Default (most metrics): retention-based cutover, no bridge.**
1. Emit the new namespaced label (mechanically, via Layer 2).
2. Update the *known* consumers (the specific dashboards/alerts/recording-rules that
   reference the old label).
3. Let the old series expire over one retention window. Record the cutover date in the
   `/sk-live-migrations` entry; a bounded seam older than retention is acceptable.

This is the migration-avoidance answer: time + retention do the work a bridge would.

**Exception (long-window / SLO / external metrics): central Alloy OTTL dual-emit bridge.**
For the specific metrics whose consumers query beyond the retention window (SLOs, capacity
planning, external contracts), carry both labels during the transition:
```
set(datapoint.attributes["restate.service"], datapoint.attributes["service"])
    where datapoint.attributes["service"] != nil
```
Constraints that make this correct and safe:
- **Generation is driven by a registry annotation, not `weaver registry diff`.** The
  deprecated attribute carries `bridge: { context: datapoint | resource, scope_metrics: [<names>] }`
  — the resource-vs-datapoint context and the metric scope are emission facts the diff does
  not (and, on pre-1.0 weaver, may not) carry. The annotation makes generation total and
  prevents an over-broad `set()` mislabeling unrelated datapoints.
- **Deployed as the fleet-wide change it is:** canary one Alloy instance/tenant before the
  fleet; the generated config is versioned so revert is one command.
- **Retire by date, not by proving a negative.** You cannot observe "no consumer reads the
  old key," so sunset the old label at a fixed date (retention + margin); anything still on
  it is a known-late consumer fixed reactively. Annotate the bridge per the live-migrations
  grammar for mechanical contraction.

## Consequences

- Most renames are a runbook (emit-new, fix-known, wait one retention window), not a bridge.
- The bridge is the exception a rename must justify, not the default it inherits.
- Reusable where used: a registry `deprecated: renamed` + `bridge:` annotation → generated,
  scoped, canaried Alloy OTTL config → dated sunset.

## Boundary — this repo generates; the deployment repo runs

This subsystem owns only the **generation** of the OTTL bridge config artifact (from the
registry `bridge:` annotation) and the discipline around it. The **running bridge is fleet
infrastructure** — which Alloy pipeline the snippet is wired into, the Mimir UTF-8/translation
settings, the canary/rollback, and the dated sunset — and is realized in the downstream
(private) deployment repo as a separate change, not here. The concrete Alloy pipeline wiring
and canary mechanics are intentionally out of scope for this generator; only the artifact
contract (a scoped OTTL statement set) crosses the boundary.

## Alternatives rejected

- **Bridge-by-default (database-migration discipline for every rename):** disproportionate
  for a retention-bounded projection; the earlier draft's "permanent discontinuity" cost is
  cosmetic once retention is accounted for.
- **Generate the OTTL from `weaver registry diff` alone:** not total (no context/scope; diff
  may not surface field-level `deprecated` pre-1.0).
- **Per-app dual-emit:** scatters the bridge across codebases; central Alloy does it once
  (a specific high-risk rename may still opt into per-app emission).
