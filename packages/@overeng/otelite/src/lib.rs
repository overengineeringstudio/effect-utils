//! otelite — a coordination-free local OTLP capture tool for E2E and
//! instrumentation tests. The library exposes the capture engine; the binary
//! (`src/main.rs`) wraps it in the `run` / `inspect` / `capture` CLI.

pub mod receiver;
pub mod sink;
