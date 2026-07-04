# v1 transports: HTTP (JSON+protobuf) + gRPC, built on official OTel crates

otelite accepts, at v1: OTLP/HTTP with both `application/json` and
`application/x-protobuf` encodings, **and** OTLP/gRPC. This mirrors the prod
collector's `:4317` (gRPC) / `:4318` (HTTP) dual-receiver shape so otelite is a
true drop-in capture target for any SDK pattern, not just the Effect HTTP/JSON
path.

## Build on the OpenTelemetry Rust crates, hand-roll the minimum

The implementation reuses the canonical crates rather than reinventing wire
formats:

- `opentelemetry-proto` (`gen-tonic` + `with-serde`) supplies the message types,
  canonical OTLP/JSON serde, protobuf decode, **and** the generated tonic
  server traits (`trace_service_server::TraceService`, metrics, logs) + `*Server`
  adapters. Verified present in 0.27.
- `tonic` serves the generated gRPC services.
- A thin HTTP layer (hyper/axum on the same tokio runtime) routes
  `POST /v1/{traces,metrics,logs}` into the same decode + sink path.

otelite's owned code is only: server glue, the capture sink, the child runner,
`OTEL_*` env injection, and the JSON summary. No proto, no service contract, no
bespoke serialization is authored by us.

## Consequence

gRPC pulls a `tokio` + `tonic` async runtime, so the HTTP side unifies on the
same runtime (drops the prototype's sync `tiny_http`). Binary grows from ~1.8MB
to a few MB — still ~100x smaller than collector-contrib.
