# 0005 — Exact descendant process-tree fidelity before release

**Status:** Accepted.

**Context:** The wrapper is valuable because it can turn one logical workload into a coherent `command -> process tree -> tool phase` trace. A command span plus a direct-child span is useful for a prototype, but it does not satisfy the full diagnostic intent when build tools fan out through package managers, compilers, test runners, and nested helper processes.

Exact descendant-process attribution is platform-sensitive. Linux and macOS expose different process-observation primitives, and short-lived subprocesses are easy to miss with naive polling.

**Decision:** `otel-scrape` must provide exact descendant process-tree spans on supported release platforms before a stable release.

The first implementation may stage this behind an experimental flag or limited platform support, but it must not present best-effort descendant discovery as satisfying the release contract. Validation must include Linux and macOS ARM evidence, with `mbp2021` used for macOS validation as needed.

**Consequences:**

- The Rust implementation must select process-observation mechanisms that can prove parent/child attribution for short-lived descendants, not just sample likely descendants.
- Best-effort or sampled discovery may exist only as explicitly marked experimental/degraded output.
- Release acceptance requires conformance evidence for exact process-tree behavior on Linux and macOS ARM.
- The implementation should keep nested `otel-scrape` context propagation as a separate exact causal path; process-tree fidelity must not depend on nested wrappers being present.
