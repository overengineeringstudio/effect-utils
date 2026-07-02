# Semantic Conventions — Open Questions

Unresolved design questions. Each links a spec `DQ`. Questions leave this file when
resolved — into the spec as decisions or into `.experiments/` as tested hypotheses.

## SC-DQ1 — Conformance-sweep completeness — RESOLVED

Resolved by [.decisions/0005](./.decisions/0005-contract-registration-convention.md): a
per-package registered seam (`defineOtelContract`, collected like `rootWorkspacePackages`)
is the single source for both the registry projection and the completeness sweep, and a lint
(extending `no-raw-otel-primitives`) errors on any contract defined outside a seam — so
completeness is structural, not best-effort grep. Staged warn → per-namespace ERROR →
repo-wide ERROR, tracking 0004's authority-flip. Rejected: static AST sweep (best-effort),
runtime self-registration (fragile).

## SC-DQ2 — Fold-depth sub-questions (direction chosen)

**Resolved direction:** registry-derives-runtime, via "catalog atop otel-contract
primitives" ([.decisions/0001](./.decisions/0001-ts-first-weaver-additive.md) D3 +
[0002](./.decisions/0002-catalog-atop-otel-contract.md)). Proven no runtime benefit is lost
(the catalog is a strict superset of `OtelAttr`). The earlier "two-surface conformant
consumer" framing is retained only as the migration bridge.

**Remaining sub-questions:**
- Do the product APIs (`OtelOperation`/`OtelMetric`) keep a thin hand-authored surface that
  references the catalog, or are they themselves generated from it?
- Is the legacy inline `OtelAttr.string({key})` form retired, or kept as a private
  building block behind `catalogString`/`catalogEnum`?

**Resolves when:** the migration reaches the first fully-migrated namespace and the answers
are settled by the shape that reads cleanest there.

## SC-DQ6 — Metric-label key projection — RESOLVED

Resolved by [.decisions/0003](./.decisions/0003-unified-full-dotted-keys.md) (one namespaced
key per concept; metric wire renders underscore by default) +
[0004](./.decisions/0004-metric-label-migration.md) (retention-first transition, central
Alloy bridge only for long-window metrics).

## SC-DQ5 — Bootstrap & authority flip (initial migration)

**Question:** How is the initial registry populated from today's ~240 `@overeng/otel-contract`
sites (no registry exists yet), and how does authority flip from "otel-contract is de facto
truth" to "registry is truth" (SC-R13) without a flag day?

**Why it matters:** The spec describes the END state (registry SSOT, runtime derived).
Getting there from the current state is a live-migration-shaped problem (distinct from
SC-DQ1, which is *ongoing* sweep completeness). Naive "author the whole registry by hand" is
a large one-shot; naive "flip the gate on" fails 240 sites at once.

**Includes the metric-label rename (0003/0004):** per-namespace migration also carries the
metric-label key change (bare → namespaced, `service`→`restate.service`, wire
`restate_service`) and the paired dashboard/alert updates. The approach is settled
([.decisions/0004](./.decisions/0004-metric-label-migration.md)): retention-first (emit-new,
fix known consumers, let old series expire), with a central Alloy OTTL bridge only for
long-window/SLO/external metrics. What remains open here is the broader authority-flip
(seeding the registry from ~240 sites, warn→block per namespace) into which the label rename
is folded.

**Candidates:**
- Seed the registry by EXTRACTING from existing `OtelAttrs.define` schemas
  (`.fields` exposes key/cardinality/encode) — a one-time generator producing a first-cut
  registry, then hand-refined with brief/stability/examples.
- Stage the authority flip per-namespace: conformance gate runs in warn-only for
  un-migrated namespaces, blocking only for migrated ones; migrate namespace-by-namespace.
  Use `/sk-live-migrations` for the staged carry + per-site proof + bridge removal.

**Resolves when:** a bootstrap generator + a staged per-namespace flip plan exist and the
first namespace is migrated green.

## SC-DQ3 — Where does privacy / metric-label enforcement live?

**Question:** Beyond identity, should a gate reject high/unbounded/secret attributes used as
metric labels (a metric-label / privacy policy)? Is that mechanism (this subsystem) or
policy (a consumer's own semantic contract)?

**Resolves when:** reconciled with the consumer's contract owner.

## SC-DQ4 — Weaver / semconv version compatibility matrix

**Question:** What is the update cadence and compatibility matrix between pinned Weaver,
pinned upstream semconv (`@vX.Y.Z[model]`), and the emitted schema?

**Evidence so far:** weaver 0.23 `--future` is clean with semconv v1.37.0; ≤v1.36 fail on
their own unstructured-`deprecated`. Pre-1.0 Weaver CLI/resolved-schema may churn; v1
`groups:` input is the stable contract.

**Resolves when:** a version-bump runbook + a CI smoke test exist.

## Non-VRS follow-up — amend the earlier downstream design note

Not a design question — a constitutional edit in a downstream consumer's own (private) repo.
An earlier note there ("registry authored in Weaver YAML") must be amended to reflect
TS-first authoring (see [.decisions/0001](./.decisions/0001-ts-first-weaver-additive.md)).
Requires user sign-off; tracked as a separate action, not owned by this VRS.
