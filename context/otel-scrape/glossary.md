# Glossary: otel-scrape

**otel-scrape** — The command wrapper. Spawns a command, owns its lifecycle span, exports trace context to children, selects an adapter, and links artifacts.

**Adapter** — A first-party implementation of the tool adapter contract for one tool. It derives spans, events, metrics, and profile links from that tool's structured output.

**Command span** — The wrapper-owned span for one `otel-scrape` invocation, built from facts the wrapper controls.

**Process-tree span** — A span representing an observed child process under a command span.

**Process observation backend** — The mechanism that produces process lifecycle observations for `otel-scrape`, such as `direct-child`, `ptrace-experimental`, or a helper stream.

**Helper stream** — A local event stream from an installed process-observation helper to `otel-scrape`. It provides lifecycle facts; `otel-scrape` still owns span construction and export.

**Run authority boundary** — The OS-scoped boundary that proves an observed process belongs to one wrapped run, such as a Linux run cgroup or a macOS Endpoint Security identity plus approved local service boundary.

**Classification ladder** — The rule that output starts as an event and is promoted to a span, metric, or profile link only when the source data justifies it.

**Root-or-join** — The propagation rule: no parent context means mint a root; parent context means join it.

**Highest-minter** — The participant highest in the causal chain that owns the trace root.

**Orchestrator** — A runner that can mint a distributed root and inject `traceparent` into commands.

**Artifact lane** — Content-addressed storage for native profile files linked from spans.

**Profile link** — A descriptor on a span containing profile type, digest, retrieval URI, and optional viewer URI.
