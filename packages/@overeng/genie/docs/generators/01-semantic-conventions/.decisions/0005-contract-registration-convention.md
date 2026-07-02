# 0005 — Contracts live behind a registered seam; a lint makes completeness structural

**Status:** Accepted.

## Context

The registry-authoritative design (0001/0002) is only as strong as the conformance sweep
being COMPLETE over every telemetry contract. Today there are ~240 `OtelAttrs.define` /
`OtelOperation.define` sites across ~15 packages with no inventory. A grep/AST sweep of
"define anywhere" is best-effort: a missed site reads as "covered" while drift hides —
worse than no gate. `no-raw-otel-primitives` already forces telemetry *through*
`@overeng/otel-contract`, but it does not make the contracts *discoverable*.

## Decision

**Each package exposes its telemetry contract from one known seam, and a lint forbids
defining a contract anywhere else.**

- A package's attributes/signals live in (or are re-exported from) a conventional file
  (e.g. `.../observability/otel.contract.ts`) and are collected into a single
  `defineOtelContract({ namespace, attributes, signals })` export.
- The root aggregator imports every package's seam into one list — the same direct-import
  object graph idiom as `rootWorkspacePackages` — and that list is the single source for
  BOTH the Weaver registry projection AND the completeness sweep, so the two cannot diverge.
- A lint rule (extending `no-raw-otel-primitives`) errors when a Layer-1/Layer-2 contract
  constructor (`attr.*` / `span` / `metric` / `OtelAttrs.define` / `OtelOperation.define`)
  is used outside a seam file. This is path-based and single-file — it is what the lint can
  actually enforce.
- **No-orphan-seam check (the keystone — the lint alone cannot provide it).** The lint
  cannot verify a seam file is actually *imported into the root aggregator*: an "orphan seam"
  (a conforming file defining a real contract, never added to the aggregator's import list)
  would lint clean yet be absent from BOTH the registry and the sweep — worse than no gate.
  So the aggregator (or a colocated test) **globs every seam-convention file on disk and
  asserts each is present in the imported member list**; a seam on disk but not in the list is
  a hard error — the same shape as a `rootWorkspacePackages` completeness test. Only with this
  check does completeness become structural rather than "path convention + a hand-maintained
  import list". It must land before any namespace's lint flips to ERROR.

**Rollout (staged with 0004's authority-flip):** the lint is WARN-only initially (it will
surface all ~240 unregistered sites without blocking CI); it flips to ERROR per namespace as
each namespace migrates behind its seam; once all namespaces are registered it is ERROR
repo-wide. Never a 240-site flag-day block.

## Consequences

- Completeness is structural, not audited — the one precondition the registry-authoritative
  guarantee rested on (SC-DQ1) is closed by construction.
- The seam does double duty: it is also the composition contribution (SC-R08), so
  registration and aggregation share one mechanism.
- Cost: one new per-package convention (the seam file) + one lint rule.

## Alternatives rejected

- **Static AST / import-graph sweep:** no new convention, but dynamic/re-exported/aliased
  define-sites slip; completeness stays best-effort, not guaranteed.
- **Runtime self-registration (register on import; a test imports the world):** completeness
  depends on total import coverage — fragile and silently under-covers.
