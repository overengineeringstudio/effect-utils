# Experiment 0002 — E2E wrapper prototype

**Hypothesis:** The VRS shape can be exercised by a small end-to-end prototype before committing to package boundaries.

**Method:** Built a disposable Bun prototype in `tmp/otel-scrape-prototype/` that wraps child commands, preserves stdout/stderr/exit code, injects and joins W3C `TRACEPARENT`, classifies structured adapter output into events/spans/metrics/profile links, and writes JSON telemetry evidence. It runs both a fixture adapter that emits every classification output and a real `oxlint --format=json` adapter path.

**Results:**

- `bun tmp/otel-scrape-prototype/prototype.ts run-fixture` passed and produced a command span, phase span, event, metric, and `sha256:` profile descriptor.
- `bun tmp/otel-scrape-prototype/prototype.ts wrapper-oxlint` passed against real `oxlint --format=json` output and produced a diagnostics-count metric.
- `bun tmp/otel-scrape-prototype/prototype.ts assert` passed, including a nested `TRACEPARENT` join assertion.
- The prototype verifies the contract shape, not OTLP export or package integration. It mimics the `@overeng/content-address` descriptor shape with Node `crypto` because workspace package imports were not available from the bare tmp script.
- A follow-up prototype run using the local `@overeng/content-address` source directly verified content-addressed profile descriptors and exposed a nested-wrapper ownership gap: passthrough output lets a parent wrapper classify the nested tool's structured output a second time.

**Conclusion:** The wrapper, propagation, classification, and profile-link concepts are coherent. The first-adapter proof shape is resolved by [../.decisions/0007-first-adapter-plus-fixtures.md](../.decisions/0007-first-adapter-plus-fixtures.md): prove one real adapter path plus focused profile/artifact fixtures instead of forcing every output kind through one tool run.

The nested-wrapper ownership gap is resolved by decision [0002](../.decisions/0002-leaf-wrapper-owns-adapter-parsing.md): adapter parsing belongs to the leaf wrapper that directly launches the adapted tool.
