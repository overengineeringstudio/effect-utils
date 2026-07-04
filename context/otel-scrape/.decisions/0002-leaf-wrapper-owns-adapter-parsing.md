# 0002 — Leaf wrapper owns adapter parsing

**Status:** Accepted.

**Context:** The E2E prototype in `tmp/otel-scrape-prototype/` showed that nested wrappers can join one trace correctly while still duplicating adapter-derived telemetry. Because passthrough fidelity preserves stdout and stderr bytes, an outer wrapper can see structured output emitted by a nested wrapped tool and classify it a second time.

**Decision:** Adapter parsing is owned by the leaf `otel-scrape` wrapper that directly launches the adapted tool. Parent wrappers must not classify structured output already owned by a nested `otel-scrape` invocation.

**Consequences:**

- Nested wrapped commands can join the same trace without duplicate adapter-derived spans, events, metrics, or profile links.
- The implementation needs an ownership/suppression protocol so parent wrappers can preserve passthrough bytes while avoiding adapter parsing for nested wrapped descendants.
- Adapters stay local to the tool invocation they were selected for. Parent wrappers still own command and observable process lifecycle spans.
- Consumers should not be required to deduplicate duplicate adapter records downstream.
