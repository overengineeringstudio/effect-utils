//! Trace-derived metrics (R11, decisions/0013): a faithful local port of the
//! collector-contrib spanmetrics connector. Projects captured spans into RED
//! metrics — `calls` (monotonic delta sum) and `duration` (delta histogram, ms)
//! — as `otelite.metric/v1` rows, so they flow through the same filters/summary
//! as native metrics. Reads the raw capture because `span.kind` is not on the
//! flat span row.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use crate::otlp_json::service_name;

const EX_DATAERR: u8 = 65;

/// The spanmetrics connector's default `duration` histogram bounds (milliseconds).
const BOUNDS: [f64; 16] = [
    2.0, 4.0, 6.0, 8.0, 10.0, 50.0, 100.0, 200.0, 400.0, 800.0, 1000.0, 1400.0, 2000.0, 5000.0,
    10000.0, 15000.0,
];

/// Dimension key: (service.name, span.name, span.kind, status.code) — all proto
/// strings, so BTreeMap order is deterministic for goldens.
type Key = (String, String, String, String);

#[derive(Default)]
struct Acc {
    count: u64,
    sum_ms: f64,
    min_ms: f64,
    max_ms: f64,
    /// Cumulative-histogram buckets, len = BOUNDS.len() + 1.
    buckets: Vec<u64>,
    start_min: u128,
    end_max: u128,
    seen: bool,
}

/// Derive `calls` + `duration` `otelite.metric/v1` rows from a trace capture.
pub fn derive(raw: &str) -> Result<Vec<Value>, u8> {
    let mut by_dim: BTreeMap<Key, Acc> = BTreeMap::new();

    for (i, line) in raw.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let v: Value = serde_json::from_str(line).map_err(|e| {
            eprintln!("otelite: corrupt capture at line {}: {e}", i + 1);
            EX_DATAERR
        })?;
        for rs in v
            .get("resourceSpans")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let service = service_name(rs.get("resource").unwrap_or(&Value::Null));
            for ss in rs
                .get("scopeSpans")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                for span in ss
                    .get("spans")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    record(&service, span, &mut by_dim);
                }
            }
        }
    }

    let mut out = Vec::new();
    for ((service, name, kind, status), a) in by_dim {
        let attrs = json!({ "span.name": name, "span.kind": kind, "status.code": status });
        out.push(calls_row(&service, &attrs, &a));
        out.push(duration_row(&service, &attrs, &a));
    }
    Ok(out)
}

fn record(service: &str, span: &Value, by_dim: &mut BTreeMap<Key, Acc>) {
    let name = span
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let kind = span_kind(span.get("kind").and_then(Value::as_i64).unwrap_or(0));
    let status = status_code(
        span.get("status")
            .and_then(|s| s.get("code"))
            .and_then(Value::as_i64)
            .unwrap_or(0),
    );
    let start = nanos(span.get("startTimeUnixNano"));
    let end = nanos(span.get("endTimeUnixNano"));
    let dur_ms = end.saturating_sub(start) as f64 / 1_000_000.0;

    let a = by_dim
        .entry((
            service.to_string(),
            name,
            kind.to_string(),
            status.to_string(),
        ))
        .or_insert_with(|| Acc {
            buckets: vec![0; BOUNDS.len() + 1],
            ..Default::default()
        });
    a.count += 1;
    a.sum_ms += dur_ms;
    if !a.seen {
        a.min_ms = dur_ms;
        a.max_ms = dur_ms;
        a.start_min = start;
        a.end_max = end;
        a.seen = true;
    } else {
        a.min_ms = a.min_ms.min(dur_ms);
        a.max_ms = a.max_ms.max(dur_ms);
        a.start_min = a.start_min.min(start);
        a.end_max = a.end_max.max(end);
    }
    a.buckets[bucket_index(dur_ms)] += 1;
}

/// The cumulative-histogram bucket for a value: first `i` with `v <= BOUNDS[i]`,
/// else the overflow bucket (`BOUNDS.len()`).
fn bucket_index(v: f64) -> usize {
    BOUNDS.iter().position(|&b| v <= b).unwrap_or(BOUNDS.len())
}

fn calls_row(service: &str, attrs: &Value, a: &Acc) -> Value {
    json!({
        "schema": "otelite.metric/v1",
        "service": service,
        "name": "calls",
        "type": "sum",
        "unit": "",
        "attrs": attrs,
        "time_unix_nano": a.end_max.to_string(),
        "start_time_unix_nano": a.start_min.to_string(),
        "value": a.count,
        "monotonic": true,
        "temporality": "delta",
    })
}

fn duration_row(service: &str, attrs: &Value, a: &Acc) -> Value {
    let mean = if a.count > 0 {
        json!(a.sum_ms / a.count as f64)
    } else {
        Value::Null
    };
    json!({
        "schema": "otelite.metric/v1",
        "service": service,
        "name": "duration",
        "type": "histogram",
        "unit": "ms",
        "attrs": attrs,
        "time_unix_nano": a.end_max.to_string(),
        "start_time_unix_nano": a.start_min.to_string(),
        "count": a.count,
        "sum": a.sum_ms,
        "min": a.min_ms,
        "max": a.max_ms,
        "mean": mean,
        "bucket_counts": a.buckets,
        "explicit_bounds": BOUNDS.to_vec(),
    })
}

fn nanos(v: Option<&Value>) -> u128 {
    match v {
        Some(Value::String(s)) => s.parse().unwrap_or(0),
        Some(Value::Number(n)) => n.as_u64().map(u128::from).unwrap_or(0),
        _ => 0,
    }
}

fn span_kind(k: i64) -> &'static str {
    match k {
        1 => "SPAN_KIND_INTERNAL",
        2 => "SPAN_KIND_SERVER",
        3 => "SPAN_KIND_CLIENT",
        4 => "SPAN_KIND_PRODUCER",
        5 => "SPAN_KIND_CONSUMER",
        _ => "SPAN_KIND_UNSPECIFIED",
    }
}

fn status_code(c: i64) -> &'static str {
    match c {
        1 => "STATUS_CODE_OK",
        2 => "STATUS_CODE_ERROR",
        _ => "STATUS_CODE_UNSET",
    }
}
