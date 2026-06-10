# Accept the default OTLP/JSON dialect; reject others loudly, never silently

otelite's receiver accepts the OTLP/JSON dialect that OpenTelemetry language
SDKs emit by default — **hex** trace/span IDs, **string** int64 (timestamps,
nanos), **integer** enums (`kind`, `severity`). Payloads in other
spec-conformant JSON encodings (base64 IDs, string enums, numeric int64) are
**rejected loudly** (HTTP 400 / gRPC error), never silently dropped.

## Why

A plan-review spike fed several spec-conformant OTLP/JSON variants through the
`opentelemetry-proto` (`with-serde`) decoder: base64 IDs, `"SPAN_KIND_SERVER"`
string enums, and numeric timestamps each **fail to decode**. Protobuf has no
such ambiguity, so a proto-emitting SDK and a non-default-dialect JSON emitter
are not interchangeable — one captures, the other errors. Supporting every
JSON dialect means a custom deserializer; the default-dialect SDKs (including
the Effect/TS path) are the real consumers, so that cost isn't justified at v1.

## The non-negotiable part: loud, not silent

The prototype returned HTTP 200 even when decode failed — a silent drop that
would make a test pass while capturing nothing. **Decode failures must return a
client error** (400 / gRPC `InvalidArgument`) so a misconfigured emitter is
visible, not mistaken for "no telemetry." Negative fixtures assert the rejected
dialects produce an error and capture nothing (`requirements.md` R02; the
cross-transport equivalence gate, spec M5).

## Consequence

The cross-transport equivalence invariant is scoped to the accepted dialect, and
the accepted-dialect boundary is documented in the spec and `--help`. Widening
the dialect later is additive (a more lenient deserializer) and non-breaking.

## Metrics JSON: persist the validated raw body (lossless)

The `with-serde` deserialize used as the dialect gate is also **lossy** for
metrics: it silently drops the string-form int64 value oneof (`"asInt":"7"`),
the regular `histogram` data oneof, and the `exponentialHistogram` data oneof.
On the **JSON** receive path the sink previously re-serialized that degraded
proto value, so those metrics were captured with a null value or omitted
entirely — a HTTP 200 + counted but silently mis-captured export, the exact
"loud, never silent" violation this decision forbids.

Fix (JSON metrics path only): the incoming body is already canonical OTLP/JSON
in the accepted dialect, and `inspect` walks raw JSON. So `http_metrics` still
runs the `with-serde` deserialize purely as the **validator** (Err → 400 +
`note_rejected`, gate unchanged), then on Ok persists the **validated raw body**
re-emitted through `serde_json::Value` (via `Sink::write_metrics_json`) instead
of the lossy proto value, counting metrics from the JSON structure. The JSON
metrics path is now lossless for string-int64 sums/gauges, histograms, and
exponential histograms. Traces/logs JSON paths and all protobuf/gRPC paths are
unchanged (already lossless; proto decode has no such ambiguity).

Caveat: the upstream metrics `with-serde` deserializer is far more lenient than
the trace one — it tolerates most non-default dialect shapes (numeric int64
nanos, string enums) rather than erroring. For metrics the validator gate is
therefore effectively structural (malformed JSON / hard field-type mismatches),
not the full dialect gate that traces enjoy. A stricter metrics dialect gate
would need a bespoke validator and is left as a follow-up.
