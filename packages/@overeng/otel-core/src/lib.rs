//! `otel-core` — registry-agnostic OpenTelemetry primitives for the effect-utils
//! Rust lane.
//!
//! Extracted from `otel-scrape` (otel-scrape decision 0009 / `context/content-address`):
//!
//! - [`content_address`]: content-addressed store (CAS) helpers mirroring the
//!   `context/content-address` contract.
//! - [`context`]: W3C trace-context propagation ([`context::TraceContext`]).
//! - [`hex`]: generic hex encoding and stable content-hash utilities.
//!
//! Deliberately free of the `otel_scrape` telemetry registry, span model, trust
//! gate, and OTLP exporter — those stay in `otel-scrape` and fold onto weaver
//! separately. The dependency is one-way: `otel-scrape -> otel-core`.

pub mod content_address;
pub mod context;
pub mod hex;
