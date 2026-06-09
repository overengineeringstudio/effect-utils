# otelite — Glossary

Domain language for otelite, a local OTLP capture target for E2E and
instrumentation tests. Scope: the capture tool itself, not the broader OTEL
stack or the Grafana/Tempo-mediated verification lane.

## Language

**Receiver**:
The OTLP server otelite stands up to accept exports — OTLP/HTTP (JSON +
protobuf) and OTLP/gRPC. The thing that replaces the collector's ingest surface
during a test run.
_Avoid_: collector, server, listener.

**Emitter**:
The instrumented process under test that sends OTLP to the **Receiver** (an
Effect SDK app, a non-Effect SDK, or the `otel-span` curl helper). Called the
SUT (system under test) when the distinction matters.
_Avoid_: client, exporter (exporter is the SDK component inside the emitter).

**Capture**:
The set of files otelite writes from received exports — one per signal
(traces/metrics/logs). The durable artifact a test asserts against.
_Avoid_: dump, recording, output (too generic).

**Child**:
The command otelite spawns under `run`, with `OTEL_*` env injected to point its
emitter at the **Receiver**. otelite preserves the child's exit code.

**Drain**:
The shutdown step after the **Child** exits where otelite finishes serving
in-flight exports before closing the **Receiver**, so the **Capture** is
complete. Distinct from a timed wait.

**Inspect**:
Reading a **Capture** back into a normalized, filtered view (flat spans, or a
summary) for assertions. otelite normalizes; it does not assert.

**Lane**:
A verification path. otelite is the _local-file capture lane_ (fast, no stack).
The _Grafana/Tempo-mediated lane_ is what operators see. The real collector is
the _production lane_. otelite is not a substitute for either.
