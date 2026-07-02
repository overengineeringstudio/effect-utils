# Semantic Conventions — Specification

This document specifies the semantic-conventions subsystem of `@overeng/genie`. It
builds on [requirements.md](./requirements.md).

## Status

Draft. Design derisked by an end-to-end prototype against real `weaver 0.23.0`
(`nix run nixpkgs#weaver`); not yet implemented. Durable evidence:
[.experiments/2026-07-01-weaver-feasibility.md](./.experiments/2026-07-01-weaver-feasibility.md)
(distilled from the transient `tmp/weaver-experiment/`).

## Scope

Defines: the TS registry DSL (catalog + signals), the composition model, the Weaver
`groups:` YAML projection, the three-layer validation model, the Weaver gate wiring, and
the otel-contract conformance mechanism.

Does not define: the *semantic contract* (attribute meaning, privacy/metric-label
policy, a consumer's own vendor namespace) — owned separately by each downstream consumer
(private). The runtime encoder internals — owned by `@overeng/otel-contract`. Dashboard /
trace query surfaces — owned by the consumer's observability stack.

## Architecture

Full SSOT chain, layering (Layer-2 home), and composition hierarchy:
[.decisions/0006](./.decisions/0006-ssot-chain-and-layering.md). Summary:

```
 AUTHORED (only facts):  attribute = annotated Effect Schema (otel + weaver meta)
                         signal    = attribute refs + per-ref requirement level
        │
 DERIVED:  ├─ runtime encoder / product APIs   (otel-contract `.`, OtelAttrs.define)   [runtime]
           └─ registry fragment                (otel-contract `./registry` projector)  [design-time]
                 └─ genie L1 (dep-free) ──► Weaver YAML → check/diff/live-check (additive gate)
                                        ──► TS constants / Rust bindings
                 └─ bridge OTTL (from `bridge:` annotation, 0004)

 namespace + catalog are DERIVED (from key prefix / signal refs), not authored (0006).
```

Layers, each depending only downward: **L2** `@overeng/otel-contract` `.` (runtime authoring
SSOT) + `./registry` (design-time projector); **L1** `@overeng/genie` `src/runtime/weaver`
(dep-free render); composed by per-package `weaver.genie.ts` + root `registry.genie.ts`. The
runtime seam is *derived*, not separately authored (SC-R13/R14); upstream OTel semconv is a
manifest `dependency` first-party signals `ref` (SC-R06). Weaver's Jinja codegen is available
but non-load-bearing (SC-T01) — genie L1 renders bindings directly.

## Effect-Schema conventions — Layer 2

Layer 2 is Effect-Schema-based, so it follows our Effect conventions; Layer 1 is deliberately
effect-free (genie's dep-free runtime), so it uses plain typed data (below), not Schema.

- **Rich schema types, not primitives:** `attr.enum` → `Schema.Literal(...)`; `attr.template`
  → `Schema.TemplateLiteral(...)`; attribute keys use otel-contract's branded
  `OtelAttributeKey`/`OtelMetricName`/`OtelSpanName`; sensitive attrs `Schema.Redacted`.
- **Hierarchical `identifier` annotations** on every attribute Schema (the `Otel.*`
  convention otel-contract already uses), alongside the otel + weaver metadata annotations.
- **Author-time validation raises `Schema.TaggedError`s with context** — not plain `throw`:
  stray-namespace-key, dangling-ref, duplicate-namespace, missing-annotation, unmarked-foreign
  ref each get a tagged error; genuinely-impossible states use `Effect.die` (defects). (The
  e2e prototype used plain `throw`; the real impl uses tagged errors.)
- **Type extraction** via `typeof X.Type`; decode any untrusted input through the Schema.

## Registry data model — Layer 1 (SC-R01, SC-R02, SC-R03)

Layer 1 mirrors Weaver's define-once/ref split as plain typed data (effect-free). A
**fragment** is one member's slice.

```ts
type RegistryFragment = {
  namespace: string          // "restate" → registry.restate group
  memberPath: string         // provenance (meta.workspace.memberPath)
  displayName: string
  attributes: AttrDef[]      // DEFINE-once catalog (registry.<ns>)
  signals: SignalDef[]       // spans/metrics/events that REF the catalog
}

type AttrDef = {
  id: string                 // must start with `${namespace}.`
  type: AttrType             // 'string'|'int'|'double'|'boolean'|'string[]'
                             //   | { members: EnumMember[] } | `template[${string}]`
  brief: string
  stability: 'stable' | 'development'      // NOTE: 'deprecated' is NOT a stability
  examples?: (string|number|boolean)[]     // REQUIRED for string attrs (weaver --future)
  note?: string
  deprecated?: Deprecated                  // orthogonal to stability (see below)
  // otel-contract policy, carried as weaver annotations (SC-R13):
  cardinality?: 'low' | 'bounded' | 'high'
  encode?: 'auto'|'string'|'number'|'boolean'|'json'|'drop'|'redacted'
}

type Deprecated =                          // weaver 0.23 STRUCTURED form (string removed)
  | { reason: 'renamed'; renamed_to: string }
  | { reason: 'obsoleted' | 'uncategorized'; note: string }

type AttrRef = {                           // signals reference, never inline-define
  ref: string
  requirement_level?: 'required'|'recommended'|'opt_in'
    | { conditionally_required: string } | { recommended: string }
  sampling_relevant?: boolean
  note?: string
}
```

**Weaver-vocabulary fidelity (derisked; see [.decisions/0001](./.decisions/0001-ts-first-weaver-additive.md)):**

| Concept | Weaver 0.23 shape | Note |
| --- | --- | --- |
| enum | `type: { members: [{id,value,brief,stability}] }` | verified |
| template | `type: template[string[]]` | dynamic-key attrs |
| requirement (conditional) | `requirement_level: { conditionally_required: <text> }` | object form |
| deprecation | `deprecated: { reason, renamed_to \| note }` | **string form removed** |
| stability | `stable` \| `development` | `deprecated` **removed** from enum |
| string examples | `examples: [...]` | **required** under `--future` |

**otel-contract policy → Weaver annotations.** `cardinality`/`encode` are emitted under a
namespaced `annotations.<policy>.{cardinality,encode}` block — non-normative to upstream
Weaver, machine-readable for the conformance + metric-label gates. Richer policy enums a
consumer may layer on (finer cardinality tiers, privacy classes, metric-label policy) map
the same way, without forking Weaver's schema.

## Genie builder & emit (SC-R05)

Each member returns a `GenieOutput` whose `meta.registry` carries the fragment:

```ts
export const registryFragment = (
  f: RegistryFragment,
): GenieOutput<RegistryFragment, { registry: RegistryFragment }> => {
  assertFragmentWellFormed(f)              // per-member author-time (partial)
  return createGenieOutput({ data: f, stringify: renderMemberSlice(f), meta: { registry: f } })
}
```

**Emit MUST serialize structured objects through a real YAML encoder**, not hand-built
indented strings — the prototype hit three nesting bugs (enum, requirement_level,
deprecated) from string concatenation. Follow the `github-workflow` builder's
structured-YAML pattern. Output paths mirror the OTel semconv model layout:
`<registry-dir>/manifest.yaml`, `<ns>.attributes.yaml` per namespace, `signals.yaml`.

## Composition (SC-R07, SC-R08, SC-R09)

Mirrors `package.json.aggregateFromPackages` / `workspace-graph.ts`:

```ts
// root registry.genie.ts
import memberA from '<pkgA>/otel.genie.ts'
import memberB from '<pkgB>/otel.genie.ts'
const members = [memberA, memberB] as const                    // direct-import object graph
export default registryFromMembers({ members, name: 'acme', repoName: 'effect-utils' })
```

`registryFromMembers` is a `@overeng/genie/composition`-style, filesystem-free projector
over `member.meta.registry`:

1. collect fragments, sort by namespace (deterministic).
2. **namespace uniqueness** — reject two members claiming `registry.<ns>` (SC-R09).
3. **global ref integrity** — every signal `ref` must resolve to a defined attribute
   across ALL fragments (incl. upstream-declared, once dependency resolution is wired);
   dangling refs fail (SC-R09). Verified: catches a cross-member dangling ref that the
   per-member check cannot.
4. emit the registry dir deterministically.

Public members declare generic namespaces; a private downstream consumer declares its own
vendor namespace. Aggregation spans the megarepo boundary (the downstream registry composes
the public fragments), following the megarepo alignment propagation order.

## Three-layer validation model

```
1. per-member author-time  (fast, PARTIAL)   namespacing, local well-formedness,
   assertFragmentWellFormed                    string-needs-examples. CANNOT check
                                               cross-member refs.
2. aggregation             (whole-registry)   ref integrity, namespace uniqueness.
   registryFromMembers                         Proven to catch dangling cross-member refs.
3. weaver                  (AUTHORITATIVE)     schema, Rego policy, diff compat,
   check/diff/live-check                        live-check. Non-load-bearing gate.
```

## Weaver gate wiring (SC-R10, SC-R11, SC-R12)

- **check (SC-R10):** devenv task `weaver:check` → `weaver registry check -r
  <dir> --future`; wired into `check:all` and CI. Pin `nixpkgs#weaver` to an exact
  version; pin the upstream semconv `@vX.Y.Z[model]` to a Weaver-compatible tag
  (v1.37.0 verified clean with 0.23; ≤v1.36 fail `--future` on their own
  unstructured-deprecated).
- **diff (SC-R11):** on PRs, `weaver registry diff --baseline-registry <merge-base
  registry>` + shipped schema-evolution policies. (Prototype confirmed weaver detects a
  removed-but-referenced attr via unresolved-ref; the evolution-policy path — "removal =
  compat violation" — is a capability to wire, not yet exercised.)
- **live-check (SC-R12):** in e2e tests, capture emitted OTLP and feed `weaver registry
  live-check --input-source <file|otlp>`; validates types/units/enum/required/coverage
  against the registry. Any OTLP exporter (incl. the test-capture harness) suffices. In the
  fleet, telemetry flows OTLP → **Grafana Alloy → Mimir (metrics) / Tempo (traces)**, queried
  via Grafana; Alloy is also where the metric-label migration bridge runs
  ([.decisions/0004](./.decisions/0004-metric-label-migration.md)). `weaver registry resolve`
  is deprecated in 0.23/0.24 — prefer `generate`/`package`.

## Runtime derivation: the catalog atop otel-contract (SC-R13, SC-R14)

The catalog is authored once and the runtime encoder is DERIVED from it. A catalog entry
wraps a real `@overeng/otel-contract` primitive (so encode/brand/decode-at-edge is
otel-contract's own code), plus design-time metadata for weaver:

```ts
RestateService = catalogString({ key: 'restate.service', cardinality: 'bounded',
  brief, stability, examples })               // .schema IS OtelAttr.string(...)

RestateAttempt = registrySpan('span.restate.attempt', {
  service: required(RestateService), objectKey: optional(conditionally(RestateObjectKey, ...)) })
// → RestateAttempt.encoder  = OtelAttrs.defineSync(Schema.Struct(refs))   // runtime, unchanged
// → RestateAttempt.weaverGroup()                                          // weaver signal group
```

Proven against the real restate contract: one declaration yields the identical runtime
encode output AND the weaver group, with validation intact (see
[.experiments](./.experiments/2026-07-01-weaver-feasibility.md)). Product APIs
(`OtelOperation`/`OtelMetric`/span.label/trusted-increment) are re-pointed at catalog
entries but keep otel-contract internals.

**Migration bridge (transitional, not the end state).** While legacy inline
`OtelAttr.string({key})` sites still exist, a conformance check runs as a bridge:

```
for each legacy runtime attr (key, cardinality?, encode?):
    def = catalog.byId[key]
    if missing / cardinality mismatch / encode mismatch → violation
```

This bridge is removed per namespace as sites migrate to catalog references (SC-DQ5). Its
completeness precondition is closed by the registered-seam + lint of
[.decisions/0005](./.decisions/0005-contract-registration-convention.md): contracts are
discoverable by construction, so the sweep cannot silently miss a site.

## Generated-file contract (GEN-R07)

Each generated binding (TS constants, Rust consts, YAML) carries a provenance header:
generated + do-not-edit, the regeneration task, the `source:` path, and a `fingerprint:
sha256:<…>` over ALL semantic inputs — the registry source, the generator, the **pinned
Weaver version**, and the **pinned upstream semconv version** (all change the output). Any
`last generated` timestamp is fingerprint-guarded (no timestamp-only churn). Outputs are
read-only (genie's existing chmod); `genie:check` (same locally + CI) regenerates + diffs; the
Nix gate reads only tracked, freshness-gated files (the pinned upstream is a FOD input, 0007).

## Remaining mechanism choices (settled)

- **Provenance = per-file `source` + input `fingerprint`** (Q9=A), mirroring otel-scrape's
  `REGISTRY_INPUT_FINGERPRINT`; hash is of the semantic inputs (above), not the emitted bytes
  (genie's read-only + byte-compare already catches hand edits).
- **`span.label` / operation label path:** the derived encoder uses the direct
  `OtelAttrs.defineSync` path (validated e2e); `span.label` stays runtime-only and is filtered
  from the registry projection (SC-T03) — `OtelSpan.define` is not used for derivation since it
  mandates a non-namespaced `span.label` attribute.
- **TS-constants scope:** own-namespace keys only; upstream-referenced keys
  (`http.request.method`) come from upstream's own generated constants, not ours.
- **Policy annotations:** emitted under `annotations.overeng_policy.{cardinality,encode}`
  (weaver-ignored, machine-readable for our gates).

## Design Questions

- **SC-DQ1 Conformance completeness — RESOLVED:** a per-package registered seam
  (`defineOtelContract`, collected like `rootWorkspacePackages`) is the single source for
  both the registry projection and the completeness sweep, and a lint errors on any contract
  defined outside a seam — completeness is structural. Staged warn → per-namespace ERROR →
  repo-wide. See [.decisions/0005](./.decisions/0005-contract-registration-convention.md).
- **SC-DQ2 Fold depth (chosen direction; confirming):** the registry-derives-runtime
  direction is the design intent (SC-R13). Proven no-runtime-loss via "catalog atop
  otel-contract primitives" ([.decisions/0002](./.decisions/0002-catalog-atop-otel-contract.md)).
  Open sub-question: do the product APIs (`OtelOperation`/`OtelMetric`) keep a thin
  hand-authored surface that references the catalog, or are they themselves generated? And
  is the legacy inline `OtelAttr.string({key})` form retired or kept as a private
  building-block behind the catalog? Resolves as the migration progresses.
- **SC-DQ3 Metric-label / privacy enforcement:** beyond derivation, should a gate reject
  high/unbounded/secret attributes used as metric labels (a metric-label / privacy policy)?
  Where does that live — this subsystem (mechanism) vs a consumer's own semantic contract
  (policy)? Resolves with the consumer's contract owner.
- **SC-DQ5 Bootstrap & authority flip:** the spec above describes the END state. Getting
  there from today's ~240 otel-contract sites (no registry yet) is a live-migration-shaped
  problem: seed the registry by extracting from existing `OtelAttrs.define` schemas, then
  stage the conformance gate warn→block per namespace. Distinct from SC-DQ1 (ongoing
  completeness). See [open-questions.md](./open-questions.md); run it as a staged live
  migration (carry both, prove each site, then remove the bridge).
- **SC-DQ4 Weaver version churn:** what is the update cadence / compatibility matrix
  between pinned Weaver, pinned upstream semconv, and the emitted schema? Resolves by a
  version-bump runbook + a smoke test in CI.
- **SC-DQ6 Metric-label key projection — RESOLVED:** one namespaced key per concept on every
  signal (registry key dotted, metric wire renders underscore by default); existing metrics
  migrate retention-first, with a central Alloy OTTL bridge only for long-window metrics. See
  [.decisions/0003](./.decisions/0003-unified-full-dotted-keys.md) +
  [0004](./.decisions/0004-metric-label-migration.md).
