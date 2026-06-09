//! Trace inspection: parse captured OTLP/JSON into a normalized snapshot and
//! summarize it (slow spans, exclusive durations, timing confidence, grouped
//! rollups).
//!
//! The core is golden-locked against the conformance fixtures under
//! `tests/conformance/`: the JSON that [`model::TraceSnapshot`] serializes to,
//! the output of [`summarize::summarize_trace`], and the byte-stable
//! serialization from [`canonical::canonical`] must not drift without updating
//! the goldens.

pub mod canonical;
pub mod model;
pub mod parse;
pub mod summarize;

pub use model::{AttrEntry, SpanRow, TraceSnapshot};
pub use parse::parse_otlp_trace;
pub use summarize::summarize_trace;
