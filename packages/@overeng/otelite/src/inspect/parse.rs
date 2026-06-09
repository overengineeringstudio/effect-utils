//! OTLP/JSON trace parsing.
//!
//! [`parse_otlp_trace`] turns an OTLP/JSON value into a normalized
//! [`TraceSnapshot`]. It accepts both the raw export shape (`resourceSpans`)
//! and the Tempo query shape (`batches`); the otelite receiver writes the
//! former, so captures parse unchanged. Parsing is permissive: missing fields
//! default rather than fail, so partial captures still yield a snapshot.
//!
//! The output ordering (spans by start time then span id, attributes by key)
//! is part of the golden-locked contract — it keeps serialized snapshots
//! byte-stable. Do not change the parse logic without updating the conformance
//! goldens.

use serde_json::Value;

use super::model::{AttrEntry, SpanRow, TraceSnapshot};

/// Parse an OTLP/JSON value into a [`TraceSnapshot`].
///
/// `fallback_trace_id` is the trace id to record on the snapshot when the spans
/// don't carry a distinct one (e.g. the caller already knows which trace it
/// asked for). `otlp_trace_id` is only populated when a span's `traceId`
/// differs from this fallback.
pub fn parse_otlp_trace(value: &Value, fallback_trace_id: &str) -> TraceSnapshot {
    let batches = value
        .get("batches")
        .or_else(|| value.get("resourceSpans"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut spans = Vec::new();
    let mut root_service = String::from("unknown");
    let trace_id = fallback_trace_id.to_string();
    let mut otlp_trace_id = None;

    for batch in &batches {
        let svc = resource_service_name(batch.get("resource"));
        if root_service == "unknown" && !svc.is_empty() {
            root_service = svc.clone();
        }
        for scope in batch
            .get("scopeSpans")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
        {
            for s in scope
                .get("spans")
                .and_then(|v| v.as_array())
                .into_iter()
                .flatten()
            {
                if otlp_trace_id.is_none() {
                    if let Some(t) = s.get("traceId").and_then(|v| v.as_str()) {
                        if !t.is_empty() && t != fallback_trace_id {
                            otlp_trace_id = Some(t.to_string());
                        }
                    }
                }
                spans.push(SpanRow {
                    span_id: s
                        .get("spanId")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    parent_span_id: s
                        .get("parentSpanId")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string()),
                    name: s
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    service_name: svc.clone(),
                    start_time_unix_nano: nano_field(s, "startTimeUnixNano"),
                    end_time_unix_nano: nano_field(s, "endTimeUnixNano"),
                    status_code: s
                        .get("status")
                        .and_then(|v| v.get("code"))
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0) as i32,
                    attributes: parse_attrs(s.get("attributes")),
                });
            }
        }
    }

    // Stable order: by start time, then span id.
    spans.sort_by(|a, b| {
        a.start_time_unix_nano
            .cmp(&b.start_time_unix_nano)
            .then(a.span_id.cmp(&b.span_id))
    });

    TraceSnapshot {
        trace_id,
        otlp_trace_id,
        root_service,
        spans,
    }
}

fn resource_service_name(resource: Option<&Value>) -> String {
    let attrs = resource
        .and_then(|r| r.get("attributes"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    for a in &attrs {
        if a.get("key").and_then(|v| v.as_str()) == Some("service.name") {
            if let Some(s) = a
                .get("value")
                .and_then(|v| v.get("stringValue"))
                .and_then(|v| v.as_str())
            {
                return s.to_string();
            }
        }
    }
    String::from("unknown")
}

/// Read a unix-nanos field that OTLP/JSON encodes as a string (int64-as-string)
/// or, more leniently, as a JSON number.
fn nano_field(s: &Value, key: &str) -> u128 {
    match s.get(key) {
        Some(Value::String(s)) => s.parse().unwrap_or(0),
        Some(Value::Number(n)) => n.as_u64().map(|v| v as u128).unwrap_or(0),
        _ => 0,
    }
}

fn parse_attrs(value: Option<&Value>) -> Vec<AttrEntry> {
    let arr = value
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut out: Vec<AttrEntry> = Vec::with_capacity(arr.len());
    for a in arr {
        let key = a
            .get("key")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let value = a.get("value").map(stringify_attr_value).unwrap_or_default();
        out.push(AttrEntry { key, value });
    }
    // Stable order so JSON goldens are byte-stable.
    out.sort_by(|a, b| a.key.cmp(&b.key));
    out
}

/// Flatten an OTLP `AnyValue` to a string. Covers the scalar variants the
/// inspect path cares about; anything else stringifies to empty.
fn stringify_attr_value(v: &Value) -> String {
    if let Some(s) = v.get("stringValue").and_then(|v| v.as_str()) {
        return s.to_string();
    }
    if let Some(b) = v.get("boolValue").and_then(|v| v.as_bool()) {
        return b.to_string();
    }
    if let Some(n) = v.get("intValue") {
        return match n {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            _ => String::new(),
        };
    }
    if let Some(n) = v.get("doubleValue").and_then(|v| v.as_f64()) {
        return n.to_string();
    }
    String::new()
}
