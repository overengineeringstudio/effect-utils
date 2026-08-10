# 0004 — Exporter: first-party OTLP/HTTP-JSON hot path + serializer seam

**Status:** Accepted.

**Context:** The family needs real OTLP emission that `otelite` can capture,
across every bin, without a full Rust OpenTelemetry SDK owning the first release
shape (SDK lifecycle, batching, and metric semantics would become the center of
the implementation before the composition contract is stable). `otel-scrape`
already proved a small first-party OTLP/HTTP-JSON exporter
([otel-scrape decision 0008](../otel-scrape/.decisions/0008-first-party-otlp-export-boundary.md)).
Traces are the primary signal now; metrics and logs are foreseeable but not
first.

**Decision:** `otel-core` owns one exporter primitive: a first-party OTLP/HTTP-JSON
**hot path** for traces, sitting behind a **serializer seam**. The seam is the
boundary at which a later `opentelemetry-otlp` adoption (metrics/logs, protobuf,
`https`, batching) slots in without a rewrite of the bins above it. The exporter
consumes the generated typed Rust encoder (decision 0003) for attribute encoding
and treats export failures as degraded evidence that never changes child stdout,
stderr, stdin, or exit status.

The exporter is registry-agnostic (decision 0002): it serializes attribute data,
not a fixed vocabulary. `grpc` / `http/protobuf` protocols and `https` transport
are the serializer seam's future occupants, not the first-party JSON path.

**Consequences:**

- One exporter for the whole family; `otelite` serves as the E2E capture fixture
  for every bin's emission.
- The metrics/logs path is reachable behind the seam without rewriting the trace
  path (requirement T02); whether one seam suffices is [DQ2](../open-questions.md).
- Disabled-mode transparency and passthrough fidelity are exporter invariants
  inherited by every bin that emits.
- The first-party path stays small; SDK breadth is adopted only when it removes
  more complexity than it adds.
