# 0001 — effect-utils owns the public otel-scrape contract

**Status:** Accepted.

**Context:** The design needs a public, reusable home because it relies on effect-utils packages for typed OTEL values, command helpers, and content-addressed artifact descriptors.

**Decision:** The public VRS and package-facing contract live in effect-utils under `context/otel-scrape/`. Any implementation must conform to effect-utils-owned contracts first:

- `@overeng/otel-contract` for typed telemetry values.
- `@overeng/content-address` for artifact identity and descriptor conventions.
- Existing effect-utils command/telemetry helpers where they satisfy the wrapper contract.

Private deployment topology, machine names, and downstream consumer details are not part of this public contract.

**Consequences:**

- The issue tracker for implementation is effect-utils.
- Downstream repositories can reference the public contract without copying private design context.
- Package boundaries are resolved by [0003-rust-package-boundary.md](./0003-rust-package-boundary.md).
