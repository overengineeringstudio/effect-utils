//! Small helpers for walking captured OTLP/JSON (service name, attribute
//! flattening), shared by the metric and log inspectors. We walk
//! `serde_json::Value` rather than the proto types because
//! `opentelemetry-proto`'s `with-serde` deserialize drops the
//! `exponentialHistogram` oneof (see decisions/0012).

use serde_json::{Map, Value};

/// `service.name` from a resource's attributes, or `"unknown"`.
pub fn service_name(resource: &Value) -> String {
    resource
        .get("attributes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|kv| kv.get("key").and_then(Value::as_str) == Some("service.name"))
        .and_then(|kv| kv.get("value"))
        .and_then(scalar_string)
        .unwrap_or_else(|| "unknown".to_string())
}

/// Flatten an OTLP `attributes` array to a `Record<string,string>` (uniform
/// with span-row attrs; numeric/bool values are stringified, complex dropped).
pub fn flatten_attrs(attrs: Option<&Value>) -> Map<String, Value> {
    let mut m = Map::new();
    for kv in attrs.and_then(Value::as_array).into_iter().flatten() {
        if let (Some(k), Some(val)) = (kv.get("key").and_then(Value::as_str), kv.get("value")) {
            if let Some(s) = scalar_string(val) {
                m.insert(k.to_string(), Value::String(s));
            }
        }
    }
    m
}

/// Stringify an `AnyValue`'s scalar (string/int/double/bool); `None` for complex.
pub fn scalar_string(v: &Value) -> Option<String> {
    if let Some(s) = v.get("stringValue").and_then(Value::as_str) {
        return Some(s.to_string());
    }
    if let Some(s) = v.get("intValue") {
        return Some(num_or_str(s));
    }
    if let Some(s) = v.get("doubleValue") {
        return Some(num_or_str(s));
    }
    if let Some(b) = v.get("boolValue").and_then(Value::as_bool) {
        return Some(b.to_string());
    }
    None
}

/// An int64 in OTLP/JSON may be a string or a number; render either as a string.
fn num_or_str(v: &Value) -> String {
    v.as_str()
        .map(|s| s.to_string())
        .unwrap_or_else(|| v.to_string())
}
