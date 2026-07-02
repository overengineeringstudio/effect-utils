# 2026-07-01 — Weaver feasibility & DSL derisking

Durable record distilled from the transient prototype (`tmp/weaver-experiment/`, deletable).
All runs against real `nix run nixpkgs#weaver` == OTel Weaver **0.23.0**.

## Hypotheses & results

| # | Hypothesis | Method | Result |
| --- | --- | --- | --- |
| H1 | Weaver is runnable in our toolchain | `nix run nixpkgs#weaver --version` | ✅ 0.23.0 from nixpkgs; no packaging work. Earlier "not in nixpkgs" was stale. |
| H2 | A TS DSL can project valid `groups:` YAML | toy + composed registry → `weaver registry check --future` | ✅ clean check |
| H3 | Registry composes across ≥2 members (megarepo idiom) | 2 members (`restate`, `acme`) contribute `meta.registry` fragments; pure root projector emits one dir | ✅ one registry, deterministic |
| H4 | Cross-member refs resolve | `span.acme.probe` refs `restate.service` (defined in the OTHER member) | ✅ ref inlines across members (shown via `weaver registry generate` — `registry resolve` still works but is DEPRECATED in 0.23/0.24; prefer `generate`/`package`) |
| H5 | Upstream OTel attrs are ref-able | manifest `dependencies: [otel @ semconv vX[model]]`; signal refs `http.request.method` | ✅ resolves at **v1.37.0**; ≤v1.36 fail `--future` on upstream's own unstructured-`deprecated` |
| H6 | Weaver generates code from the registry | `weaver registry generate` + Jinja TS target | ✅ TS constants emitted (non-load-bearing under TS-first) |
| H7 | Backward-compat is gated | remove a referenced attr; `weaver registry diff --baseline-registry` | ⚠️ break detected via UNRESOLVED-REF; the evolution-policy "removal = compat violation" path was not exercised |
| H8 | otel-contract↔registry conformance is checkable | set-compare runtime attrs vs registry (cardinality+encode) | ✅ catches drift + missing; extraction feasible via `OtelAttrs.define(schema).fields`. **Completeness NOT proven** (SC-DQ1) |

## Weaver 0.23 vocabulary fidelity deltas (vs mid-2025 docs)

Each was caught by Weaver, not by reading docs:

- `deprecated` is a STRUCTURED object (`{reason: renamed, renamed_to}` |
  `{reason: obsoleted|uncategorized, note}`) — the plain-string form was removed.
- `stability` enum DROPPED `deprecated`; deprecation is orthogonal (real stability +
  `deprecated:` field).
- `--future` REQUIRES `examples` on string attributes.
- enum = `type: {members: [{id,value,brief,stability}]}`; conditional requirement =
  `requirement_level: {conditionally_required: <text>}` — both verified.
- Hand-built YAML strings caused 3 nesting bugs → the builder MUST serialize structured
  objects through a real YAML encoder.

## Three-layer validation (design output)

1. per-member author-time (partial) → 2. aggregation (ref integrity + namespace
uniqueness; catches cross-member dangling refs) → 3. Weaver (authoritative, additive gate).

## Catalog-atop-otel-contract migration proof (Axis B)

Re-expressed the REAL `restate/observability/contract.ts` in the catalog design, importing
the REAL `@overeng/otel-contract` (`prove.ts` → `../../../../packages/.../src/mod.ts`).
From ONE catalog declaration:

- the runtime encoder (`registrySpan(...).encoder`) IS otel-contract's own
  `OtelAttrs.defineSync` field plan → `encodeSync({service,handler,objectKey})` yields
  identical `{restate.service, restate.handler, restate.object.key}`;
- decode-at-edge still bites (bad `restate.error.class` enum value rejected);
- the weaver registry derives from the same source.

Coverage — the HARD cases were run too (against real otel-contract), not just attrs+span:

| otel-contract construct | catalog re-expression | result |
| --- | --- | --- |
| `OtelAttr.string/literal` + `OtelAttrs.defineSync` (span attrs) | `catalogString`/`catalogEnum` + `registrySpan` | identical encode output; enum validation bites |
| `OtelMetric.counter/histogram` w/ label schema | `registryMetric` (labels = catalog entries) | derives real `OtelMetric`; `encodeLabelsSync` works; `trustedTagPairs` (trusted path) present → validated-vs-trusted split preserved |
| `OtelOperation.define({name,schema,label})` — label EXTRACTOR fn | `registryOperation` | `op.with({label})(effect)` runs; label → span.label, dropped from attrs |
| `OtelAttr.drop(...)` | via the operation's drop field | preserved |

Conclusion: a catalog built ATOP otel-contract primitives is a **strict superset** of the
otel-contract authoring API across attrs, spans, metrics (incl. label schemas + trusted
increment), and operations — no runtime benefit lost (the machinery is otel-contract's
code, reused verbatim). Selects fold-depth = "catalog atop primitives" (decision 0002) and
confirms registry-authoritative-via-derivation.

**SC-DQ6 (metric-label keys) — SUPERSEDED by [.decisions/0003](../.decisions/0003-unified-full-dotted-keys.md)
+ [0004](../.decisions/0004-metric-label-migration.md).** The exploration below concluded a
short-key metric-label namespace; the accepted decision is the OPPOSITE — one namespaced key
per concept on every signal (the OTel-native SOTA case: same-concept-same-key, namespacing
resolves the `service`/`service.name` ambiguity, cross-cutting identity on resource
attributes), with the wire migration carried by a staged collector-OTTL bridge. The text below is
kept as the evidence trail that both options are feasible; it is NOT the decision.

> Metric labels use short keys (`service`) distinct from span attr keys (`restate.service`).
> Modeling metric labels as their OWN catalog namespace keeps the wire output UNCHANGED — no
> migration — and both this and the full-dotted-key option were prototyped weaver-valid.

## Conclusion

TS-first + Weaver-as-additive-gate + registry-as-SSOT-with-runtime-derived is feasible end
to end. Load-bearing unknowns that remain are conformance/bridge COMPLETENESS (SC-DQ1) and
the initial bootstrap + authority-flip incl. the metric-label rename (SC-DQ5) — neither
blocks the mechanism, both block "no drift" / "migrated" claims. See
[../spec.md](../spec.md) and [../open-questions.md](../open-questions.md).
