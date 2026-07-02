# 0002 — Fold depth: the catalog is built ATOP otel-contract primitives

**Status:** Accepted. Empirically derisked against the real `@overeng/otel-contract` and
the real restate contract (attrs, spans, metrics, operations); user-confirmed.

## Context

D3 of [0001](./0001-ts-first-weaver-additive.md) makes the registry the single SSOT with
the runtime encoder DERIVED from it. That leaves one question: how tightly does the catalog
fold into `@overeng/otel-contract`?

- **Option 1 — catalog IS the primitive:** the catalog entry replaces `OtelAttr`;
  `OtelAttr`/`OtelAttrs` are rebuilt on it or retired. Cleanest single concept, but the
  deepest change to otel-contract's internals — and the place runtime behavior could
  silently regress.
- **Option 2 — catalog ATOP otel-contract primitives:** `registryAttr`/`registrySpan` are
  built ON the existing `OtelAttr`/`OtelAttrs` machinery, adding design-time metadata +
  catalog placement + weaver derivation. otel-contract's encode engine is reused verbatim.

The user's governing concern: _do we lose any benefit the Effect otel-contract API
provides?_

## Decision

**Option 2.** A catalog attribute wraps a real otel-contract primitive as its `.schema`, so
encode/brand/decode-at-edge is otel-contract's own code, reused verbatim. The catalog is a
strict SUPERSET of `OtelAttr` (adds `brief`/`stability`/`examples` + namespace + weaver
type). `registrySpan`/`registryMetric` derive both the weaver group and the runtime
`OtelAttrs` encoder from one declaration.

Rationale: this makes it structurally impossible to lose a runtime benefit, because the
runtime path is unchanged otel-contract code. Option 1's marginal gain (one concept instead
of a thin layer) is not worth the regression risk on an oxlint-enforced, ~15-consumer seam.

## Consequences

- No runtime behavior lost: proven for the real restate contract across attrs, spans,
  metrics (label schemas + validated/trusted split), and operations (label extractor +
  `drop`) — see [../.experiments](../.experiments/2026-07-01-weaver-feasibility.md).
- Product APIs (`OtelOperation`/`OtelMetric`/span.label/trusted-increment) are re-pointed at
  catalog entries but keep otel-contract internals.
- Attributes move from inline-per-struct to define-once-in-catalog + reference — the
  migration (SC-DQ5), staged per namespace.
- Open sub-questions: whether the legacy inline `OtelAttr.string({key})` form is retired or
  kept as a private building block behind the catalog (SC-DQ2); how metric-label short keys
  project (SC-DQ6).

## Alternatives rejected

- **Option 1 (catalog is the primitive):** deeper otel-contract rewrite, higher regression
  risk, marginal conceptual gain. Rejected for now; could be revisited once the catalog
  layer is proven in production.
