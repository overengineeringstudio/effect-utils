# Semantic Conventions — Intuition

_For: contributors adding telemetry · Assumes: genie basics, otel-contract exists ·
Covers: why this subsystem exists and its mental model_

## The idea

Telemetry attribute names, span names, and metric names are a **public API**. Today
they are declared ad hoc through `@overeng/otel-contract` at ~240 sites, with the
"meaning + policy" half specified only in prose. OpenTelemetry's ecosystem has a
standard for this — **semantic conventions** — and a tool, **Weaver**, that treats a
convention registry as a versioned, checkable, diff-able, code-generating contract.

This subsystem lets you author that registry in TypeScript (where we already live),
generate the Weaver YAML from it, and let Weaver validate it — without hand-writing YAML
and without Weaver being on the critical path.

## The one model to hold: define-once, ref-many

Weaver's whole model is: **define an attribute once** in a namespaced catalog, then
**reference it** from the spans/metrics/events that use it. You never redefine
`restate.service` in three spans; you define it once and each span refs it, optionally
refining _how required_ it is in that context.

```
catalog (define once)          signals (ref + refine)
registry.restate                span.restate.invoke
  restate.service  ───────ref──►   restate.service  (required)
  restate.object.key ────ref──►    restate.object.key (conditionally_required)
  restate.error.class ───ref──►    restate.error.class (recommended)
```

We carry that same split at two layers: the YAML registry (Weaver's model) AND the TS
authoring surface. And it extends past our own repo — you can `ref` an attribute the
upstream OTel registry already defines (`http.request.method`) instead of inventing your
own, so our telemetry stays portable.

## How the pieces relate

- **The registry catalog is the single source of truth** for what an attribute IS (its
  identity, type, cardinality, privacy, docs). You author each attribute once, in TS.
- **The runtime encoder is DERIVED from it.** You don't author an attribute in the catalog
  AND again in `@overeng/otel-contract` — a catalog entry is built on otel-contract's own
  primitives (so it encodes/validates exactly as today, nothing lost), and a signal
  composes catalog references, from which both the Weaver registry AND the runtime encoder
  your Effect code calls are produced. One declaration, both derivations. (While the ~240
  existing hand-written sites are migrated onto the catalog, a temporary conformance check
  keeps the two honest — a bridge, removed as each namespace moves over.)
- **Weaver is a gate, not a dependency.** It checks the registry, diffs it against the
  last version for breaking changes, and (in tests) checks that the telemetry you
  actually emit matches what the registry promises. If Weaver disappeared tomorrow, your
  runtime constants would still build. That is deliberate: Weaver is pre-1.0.

## How it composes

Each package contributes its own slice of the registry — a **fragment** — the same way
each package contributes to the root `package.json` or `tsconfig`. A root aggregator
stitches every member's fragment into one registry, checks that refs resolve across
members and that no two members claim the same namespace, and emits the YAML. Public
packages contribute generic namespaces; a private downstream consumer contributes its own
vendor namespace and composes the public fragments underneath it.

## Where it fits

```
you author ──► TS registry DSL ──► genie projects ──► weaver gate (check/diff/live-check)
                    │
                    ├──► runtime encoder (otel-contract) — DERIVED from the same source
                    └──► (during migration only) conformance check vs legacy hand-authored sites
```

The formal constraints are in [requirements.md](./requirements.md); the mechanism and the
weaver-fidelity details are in [spec.md](./spec.md); the decisions (TS-first,
catalog-atop-primitives, one-namespaced-key, migration, completeness, layering, targets) are
in `.decisions/0001`–`0007`. The migration is landed (~14 namespaces on the derived catalog);
the genuinely-open items — where privacy/metric-label enforcement lives, and the
weaver-version compatibility matrix / runbook — are in [open-questions.md](./open-questions.md).
