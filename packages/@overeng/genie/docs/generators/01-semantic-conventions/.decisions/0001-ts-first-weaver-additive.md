# 0001 — TS-first authoring; Weaver as an additive gate; registry authoritative

**Status:** Accepted. D1 (TS-first), D2 (Weaver additive), and D3 (registry SSOT, runtime
derives) all user-confirmed. Derisked by e2e prototype against `weaver 0.23.0` and the real
`@overeng/otel-contract`.

## Context

Adopting OTel Weaver as the semantic-convention best practice raises three coupled
choices. An earlier design note in a private downstream consumer had asserted two clauses
that cannot both hold while Weaver is pre-1.0:

1. "the registry is authored in Weaver model YAML" (YAML-first), and
2. "Weaver's codegen and live-check are additive, never load-bearing while pre-1.0".

They collide because the *rich* contract (types, per-signal `requirement_level`,
post-`ref`/`extends` attribute sets) only materializes after **resolution**. Projecting
rich runtime artifacts from unresolved YAML forces either Weaver's resolver to be
load-bearing (violates 2) or a reimplementation of it in genie (defeats authoring YAML at
all). One clause must give.

## Decision

- **D1 TS-first (Axis A).** The registry is authored in a typed TS DSL; the Weaver
  `groups:` YAML is a generated, read-only artifact. This keeps clause (2) — Weaver stays
  additive — at the cost of clause (1). It reuses the TS ergonomics and the existing
  enforced `@overeng/otel-contract` seam.
- **D2 Weaver additive (SC-T01).** `check`/`diff`/`live-check`/`generate` are a gate;
  runtime constants are producible without Weaver on the path. Weaver is pinned via
  `nixpkgs#weaver`; v1 `groups:` is treated as the stable contract.
- **D3 Registry is the single SSOT; runtime DERIVES from it (Axis B).** The registry
  catalog is the one authored source of attribute identity + policy; the runtime encoders
  are derived from it (a catalog attribute authored once; signals compose refs, deriving
  both the weaver group and the `OtelAttrs` encoder). This is the "clean derivation / clear
  SSOT chain" direction (GEN-R01…R03), chosen over a two-surface conformance model after
  the user prioritized single-SSOT derivation. The conformance check is retained only as a
  MIGRATION BRIDGE (SC-DQ5), not the resting state. Fold depth (how the catalog sits atop
  otel-contract) is [0002](./0002-catalog-atop-otel-contract.md).

## Consequences

- The earlier downstream design note must be **amended** in its own (private) repo:
  clause (1) changes from "authored in Weaver YAML" to "authored TS-first, Weaver YAML
  generated". That is a constitutional edit there, requires user sign-off, and is a
  separate action — noted but not performed by this VRS.
- Weaver's pre-1.0 churn risk is bounded: it never blocks producing runtime artifacts.
- Legacy inline `OtelAttr.string({key})` usage (~240 define-sites across ~15 enforced
  consumer packages) migrates to catalog references, staged per namespace behind the
  conformance bridge (SC-DQ5). No runtime
  behavior is lost (0002).
- Superseded framing: an earlier draft kept otel-contract as an unchanged, independently
  authored "conformant consumer" ("B-default"). That is now only the transitional bridge;
  the end state is derivation. History kept here for the record.
- otel-contract keeps its inline-per-struct model and back-compat DURING migration; the
  end state has the runtime encoder derived from the catalog — kept coherent meanwhile by
  the conformance gate — whose
  completeness is the one unsolved precondition (SC-DQ1).

## Evidence

E2E prototype (`tmp/weaver-experiment/`, transient): TS DSL → composed `groups:` YAML
across 2 members; `weaver check --future` clean; cross-member + upstream (`http.request
.method` from semconv v1.37.0) refs resolve; `generate` emits TS constants; conformance
set-compare catches drift + missing. Weaver-vocabulary fidelity deltas (structured
`deprecated`, `stability` drops `deprecated`, string-examples rule) captured in
[../spec.md](../spec.md).

## Alternatives rejected

- **YAML-first (keep the earlier note as-is):** makes Weaver load-bearing (violates D2), abandons TS
  ergonomics, demotes the enforced otel-contract seam to downstream.
- **R1 — cram Weaver design-time fields into otel-contract runtime metadata:** pollutes
  bundled runtime with doc strings; otel-contract's inline-per-struct model is the
  opposite of a define-once catalog. Fights both models.
- **R3 — re-found otel-contract on the registry:** large blast radius for small marginal
  gain; deferred as a user-gated spike (SC-DQ2), not rejected outright.
