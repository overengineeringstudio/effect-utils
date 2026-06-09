//! otelite — a coordination-free local OTLP capture tool for E2E and
//! instrumentation tests. The library exposes the capture engine; the binary
//! (`src/main.rs`) wraps it in the `run` / `inspect` / `capture` CLI.

pub mod derive_spanmetrics;
pub mod inspect;
pub mod inspect_cmd;
pub mod inspect_logs;
pub mod inspect_metrics;
pub mod otlp_json;
pub mod receiver;
pub mod run;
pub mod sink;
