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

**Program identity** — The wrapped executable's basename (`tsc`, `cargo`), used as the command span name and `command.program`. Public-safe (never a path or args), so it is always emitted.

**Argv hash** — A stable hash over the child argv vector (`command.argv_hash`). Always emitted; it is the correlation/dedup key, not merely a redaction of the raw argv.

**Span origin** — The `span.origin` attribute (`otel-scrape` or `otel-scrape-adapter`) plus `otel.scope.name = otel-scrape`, marking a span as wrapper-owned without the span name carrying the instrumentation.

**Merged process observation** — In the default degraded `direct-child` backend, the process observation folded into the command span (`fidelity = "merged"`) instead of a separate span. A distinct process span appears only under an exact backend.

**Trusted sink** — A telemetry destination an operator has explicitly asserted private and access-controlled (`OTEL_SCRAPE_TRUSTED_SINK` / `--trusted-sink`). Raw argv/cwd/local paths are emitted only to a trusted sink; the assertion is explicit, per-sink, and off by default. Trust unlocks identity, never credentials or payloads.
