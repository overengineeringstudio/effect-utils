# 0004 — Generated telemetry registry

**Status:** Accepted.

**Context:** `otel-scrape` is implemented in Rust, while the existing typed telemetry contract lives in TypeScript under `@overeng/otel-contract`. Manually mirroring span names, metric names, attribute keys, and profile descriptor fields across languages would create a second schema by drift.

`otelite` does not currently provide a general code generator, but it does provide reusable contract patterns: schema-tagged machine JSON, canonical JSON serialization, conformance goldens, and TypeScript-side typed decoding/assertion wrappers in `@overeng/utils-dev/otelite`.

**Decision:** `otel-scrape` telemetry names and wire-shape constants are owned by a small schema source of truth and generated into both Rust and TypeScript bindings.

The implementation should reuse `otelite`'s contract patterns where possible, and factor shared contract-generation or golden-test infrastructure when that gives a clearer long-term single source of truth. Generated outputs must make drift visible in normal repo checks.

**Consequences:**

- Rust must not become the de facto owner of telemetry semantic names just because it owns the process wrapper runtime.
- TypeScript and Rust consumers use generated bindings rather than manually duplicated string literals.
- The first vertical slice may introduce the minimal generator/schema needed for `otel_scrape.command`, `otel_scrape.process`, core attributes, and profile-link fields; adapter fleet expansion should not proceed on manually mirrored constants.
- The generated registry should integrate with existing genie/devenv checks so stale generated files fail locally and in CI.
