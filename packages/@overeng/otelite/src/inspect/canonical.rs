//! Canonical (byte-stable) JSON serialization.
//!
//! [`canonical`] recursively sorts object keys before serializing, so the same
//! logical value always produces the same bytes. This is what makes the
//! conformance goldens comparable and is part of the golden-locked contract.

use serde_json::Value;

/// Serialize a JSON value with object keys sorted recursively. Returns `"{}"`
/// if serialization somehow fails (it shouldn't for in-memory values).
pub fn canonical(v: &Value) -> String {
    fn canonicalize(v: &Value) -> Value {
        match v {
            Value::Object(map) => {
                let mut bt = std::collections::BTreeMap::new();
                for (k, vv) in map {
                    bt.insert(k.clone(), canonicalize(vv));
                }
                Value::Object(bt.into_iter().collect())
            }
            Value::Array(arr) => Value::Array(arr.iter().map(canonicalize).collect()),
            other => other.clone(),
        }
    }
    serde_json::to_string(&canonicalize(v)).unwrap_or_else(|_| "{}".to_string())
}
