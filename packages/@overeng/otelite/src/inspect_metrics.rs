//! Metric inspection (M6): flatten captured OTLP metrics into per-data-point
//! `otelite.metric/v1` rows and an `otelite.metric-summary/v1` rollup. Shape
//! chosen by eval (decisions/0012). Walks `serde_json::Value` directly.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Value};

use crate::otlp_json::{flatten_attrs, service_name};

const EX_DATAERR: u8 = 65;

/// One `otelite.metric/v1` row per captured data point.
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
        for rm in v
            .get("resourceMetrics")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let service = service_name(rm.get("resource").unwrap_or(&Value::Null));
            for sm in rm
                .get("scopeMetrics")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                for m in sm
                    .get("metrics")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    metric_rows(&service, m, &mut out);
                }
            }
        }
    }
    Ok(out)
}

fn points(body: &Value) -> impl Iterator<Item = &Value> {
    body.get("dataPoints")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

fn metric_rows(service: &str, m: &Value, out: &mut Vec<Value>) {
    let name = m.get("name").and_then(Value::as_str).unwrap_or("");
    let unit = m.get("unit").and_then(Value::as_str).unwrap_or("");
    if let Some(sum) = m.get("sum") {
        let mono = sum
            .get("isMonotonic")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let temp = temporality(sum.get("aggregationTemporality"));
        for dp in points(sum) {
            let mut row = base(service, name, "sum", unit, dp);
            insert(&mut row, "value", number_value(dp));
            insert(&mut row, "monotonic", json!(mono));
            insert(&mut row, "temporality", json!(temp));
            out.push(row);
        }
    } else if let Some(g) = m.get("gauge") {
        for dp in points(g) {
            let mut row = base(service, name, "gauge", unit, dp);
            insert(&mut row, "value", number_value(dp));
            out.push(row);
        }
    } else if let Some(h) = m.get("histogram") {
        for dp in points(h) {
            let mut row = base(service, name, "histogram", unit, dp);
            let count = num_field(dp, "count");
            let sum = num_field(dp, "sum");
            let mean = match (sum.as_f64(), count.as_f64()) {
                (Some(s), Some(c)) if c > 0.0 => json!(s / c),
                _ => Value::Null,
            };
            insert(&mut row, "count", count);
            insert(&mut row, "sum", sum);
            insert(&mut row, "min", num_field(dp, "min"));
            insert(&mut row, "max", num_field(dp, "max"));
            insert(&mut row, "mean", mean);
            insert(&mut row, "bucket_counts", num_array(dp.get("bucketCounts")));
            insert(
                &mut row,
                "explicit_bounds",
                num_array(dp.get("explicitBounds")),
            );
            out.push(row);
        }
    } else if let Some(eh) = m.get("exponentialHistogram") {
        for dp in points(eh) {
            let mut row = base(service, name, "exphistogram", unit, dp);
            insert(&mut row, "count", num_field(dp, "count"));
            insert(&mut row, "sum", num_field(dp, "sum"));
            insert(&mut row, "scale", num_field(dp, "scale"));
            insert(&mut row, "zero_count", num_field(dp, "zeroCount"));
            insert(&mut row, "positive_buckets", buckets(dp.get("positive")));
            insert(&mut row, "negative_buckets", buckets(dp.get("negative")));
            out.push(row);
        }
    }
    // `summary` metric type is out of v1 scope (rare; SDKs rarely emit it).
}

fn base(service: &str, name: &str, ty: &str, unit: &str, dp: &Value) -> Value {
    json!({
        "schema": "otelite.metric/v1",
        "service": service,
        "name": name,
        "type": ty,
        "unit": unit,
        "attrs": Value::Object(flatten_attrs(dp.get("attributes"))),
        "time_unix_nano": dp.get("timeUnixNano").cloned().unwrap_or(Value::Null),
        "start_time_unix_nano": dp.get("startTimeUnixNano").cloned().unwrap_or(Value::Null),
    })
}

fn insert(row: &mut Value, key: &str, val: Value) {
    if let Value::Object(m) = row {
        m.insert(key.to_string(), val);
    }
}

/// gauge/sum point value, normalized to a JSON number regardless of whether the
/// capture encoded int64 as a number or (per OTLP/JSON spec) a string.
fn number_value(dp: &Value) -> Value {
    dp.get("asInt")
        .or_else(|| dp.get("asDouble"))
        .map(to_number)
        .unwrap_or(Value::Null)
}

/// Coerce a JSON number-or-string int64/double to a canonical JSON number, so
/// numeric assertions and aggregation are encoder-independent.
fn to_number(v: &Value) -> Value {
    if v.is_number() {
        return v.clone();
    }
    if let Some(s) = v.as_str() {
        if let Ok(n) = s.parse::<i64>() {
            return json!(n);
        }
        if let Ok(f) = s.parse::<f64>() {
            return json!(f);
        }
    }
    Value::Null
}

/// A numeric data-point field, normalized to a JSON number (or null if absent).
fn num_field(dp: &Value, key: &str) -> Value {
    dp.get(key).map(to_number).unwrap_or(Value::Null)
}

/// An array of numbers (bucket counts / bounds), each normalized.
fn num_array(v: Option<&Value>) -> Value {
    match v.and_then(Value::as_array) {
        Some(arr) => Value::Array(arr.iter().map(to_number).collect()),
        None => json!([]),
    }
}

/// Exp-histogram positive/negative buckets, snake-cased to match the row.
fn buckets(v: Option<&Value>) -> Value {
    match v {
        Some(b) => json!({
            "offset": num_field(b, "offset"),
            "bucket_counts": num_array(b.get("bucketCounts")),
        }),
        None => Value::Null,
    }
}

fn temporality(v: Option<&Value>) -> &'static str {
    match v.and_then(Value::as_i64) {
        Some(1) => "delta",
        Some(2) => "cumulative",
        _ => "unspecified",
    }
}

#[derive(Default)]
struct Agg {
    ty: String,
    unit: String,
    data_points: u64,
    services: BTreeSet<String>,
    value_min: Option<f64>,
    value_max: Option<f64>,
    value_sum: f64,
    has_value: bool,
}

/// One `otelite.metric-summary/v1` object: per-name rollup + totals.
pub fn summary(raw: &str) -> Result<Value, u8> {
    let rows = rows(raw)?;
    let mut by_name: BTreeMap<String, Agg> = BTreeMap::new();
    for row in &rows {
        let name = row["name"].as_str().unwrap_or("").to_string();
        let a = by_name.entry(name).or_default();
        a.ty = row["type"].as_str().unwrap_or("").to_string();
        a.unit = row["unit"].as_str().unwrap_or("").to_string();
        a.data_points += 1;
        a.services
            .insert(row["service"].as_str().unwrap_or("").to_string());
        // value stats only for gauge/sum *rows* (not the aggregate type, which
        // could be a histogram if a name is reused across types).
        let row_ty = row["type"].as_str().unwrap_or("");
        if row_ty == "gauge" || row_ty == "sum" {
            if let Some(v) = row["value"].as_f64() {
                a.has_value = true;
                a.value_min = Some(a.value_min.map_or(v, |m| m.min(v)));
                a.value_max = Some(a.value_max.map_or(v, |m| m.max(v)));
                a.value_sum += v;
            }
        }
    }
    let metrics: Vec<Value> = by_name
        .into_iter()
        .map(|(name, a)| {
            let mut o = json!({
                "name": name,
                "type": a.ty,
                "unit": a.unit,
                "data_points": a.data_points,
                "services": a.services.into_iter().collect::<Vec<_>>(),
            });
            if a.has_value {
                insert(&mut o, "value_min", json!(a.value_min));
                insert(&mut o, "value_max", json!(a.value_max));
                insert(&mut o, "value_sum", json!(a.value_sum));
            }
            o
        })
        .collect();
    Ok(json!({
        "schema": "otelite.metric-summary/v1",
        "metrics": metrics,
        "total_metrics": rows.iter().map(|r| r["name"].as_str().unwrap_or("")).collect::<BTreeSet<_>>().len(),
        "total_data_points": rows.len(),
    }))
}
