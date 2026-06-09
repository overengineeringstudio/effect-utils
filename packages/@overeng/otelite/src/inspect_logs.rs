//! Log inspection (M6): flatten captured OTLP logs into per-record
//! `otelite.log/v1` rows and an `otelite.log-summary/v1` rollup
//! (decisions/0012). Walks `serde_json::Value` directly.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use crate::otlp_json::{flatten_attrs, scalar_string, service_name};

const EX_DATAERR: u8 = 65;

/// One `otelite.log/v1` row per captured log record.
pub fn rows(raw: &str) -> Result<Vec<Value>, u8> {
    let mut out = Vec::new();
    for (i, line) in raw.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let v: Value = serde_json::from_str(line).map_err(|e| {
            eprintln!("otelite: corrupt capture at line {}: {e}", i + 1);
            EX_DATAERR
        })?;
        for rl in v
            .get("resourceLogs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let service = service_name(rl.get("resource").unwrap_or(&Value::Null));
            for sl in rl
                .get("scopeLogs")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let scope = sl
                    .get("scope")
                    .and_then(|s| s.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                for rec in sl
                    .get("logRecords")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    out.push(log_row(&service, &scope, rec));
                }
            }
        }
    }
    Ok(out)
}

fn log_row(service: &str, scope: &str, rec: &Value) -> Value {
    json!({
        "schema": "otelite.log/v1",
        "service": service,
        "scope": scope,
        "severity_number": rec.get("severityNumber").cloned().unwrap_or(json!(0)),
        "severity_text": rec.get("severityText").and_then(Value::as_str).unwrap_or(""),
        "body": rec.get("body").and_then(scalar_string),
        "trace_id": hex_or_null(rec.get("traceId")),
        "span_id": hex_or_null(rec.get("spanId")),
        "time_unix_nano": rec.get("timeUnixNano").cloned().unwrap_or(Value::Null),
        "attrs": Value::Object(flatten_attrs(rec.get("attributes"))),
    })
}

/// A hex id, or `null` when absent/empty (so negative-correlation is a clean
/// `select(.trace_id == null)`).
fn hex_or_null(v: Option<&Value>) -> Value {
    match v.and_then(Value::as_str) {
        Some(s) if !s.is_empty() => json!(s),
        _ => Value::Null,
    }
}

/// One `otelite.log-summary/v1`: total + counts by severity and by service.
pub fn summary(raw: &str) -> Result<Value, u8> {
    let rows = rows(raw)?;
    let mut by_severity: BTreeMap<String, u64> = BTreeMap::new();
    let mut by_service: BTreeMap<String, u64> = BTreeMap::new();
    for row in &rows {
        let sev = row["severity_text"].as_str().unwrap_or("").to_string();
        let svc = row["service"].as_str().unwrap_or("").to_string();
        *by_severity.entry(sev).or_default() += 1;
        *by_service.entry(svc).or_default() += 1;
    }
    Ok(json!({
        "schema": "otelite.log-summary/v1",
        "total": rows.len(),
        "by_severity": by_severity,
        "by_service": by_service,
    }))
}
