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
