//! Normalized trace model used by the `inspect` command.
//!
//! These types are the shape produced by [`super::parse::parse_otlp_trace`] and
//! consumed by [`super::summarize::summarize_trace`]. They are intentionally
//! flat: tree structure (depth/children) is derived at render time, not stored
//! on the wire.
//!
//! The field set and serde representation are golden-locked — the conformance
//! goldens under `tests/conformance/` depend on the exact JSON these types
//! serialize to. Do not rename fields or change `serde` attributes without
//! updating the goldens.

use serde::{Deserialize, Serialize};

/// One span, normalized from OTLP. Timestamps are unix-nanos; `status_code`
/// follows the OTLP status enum (0 = unset, 1 = ok, 2 = error).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpanRow {
    pub span_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_span_id: Option<String>,
    pub name: String,
    pub service_name: String,
    pub start_time_unix_nano: u128,
    pub end_time_unix_nano: u128,
    pub status_code: i32,
    #[serde(default)]
    pub attributes: Vec<AttrEntry>,
}

/// A single span attribute, with the value flattened to a string regardless of
/// the original OTLP value type (string/bool/int/double).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttrEntry {
    pub key: String,
    pub value: String,
}

/// A single trace projected to a flat span list, the input to `inspect` /
/// `summarize`. `otlp_trace_id` is only set when the spans carry a trace id
/// distinct from the caller-supplied fallback.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TraceSnapshot {
    pub trace_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub otlp_trace_id: Option<String>,
    pub root_service: String,
    pub spans: Vec<SpanRow>,
}
