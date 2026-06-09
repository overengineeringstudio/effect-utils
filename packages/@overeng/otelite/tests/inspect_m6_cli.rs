//! M6 agentic gates: the actual assertions a coding agent would make about
//! captured metrics/logs, run through the real binary against the corpus
//! fixtures. Mirrors the eval scenario suite (decisions/0012).

use std::path::PathBuf;
use std::process::Command;

fn otelite() -> Command {
    Command::new(env!("CARGO_BIN_EXE_otelite"))
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/conformance/m6")
        .join(name)
}

fn rows(stdout: &[u8]) -> Vec<serde_json::Value> {
    String::from_utf8_lossy(stdout)
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

fn metrics() -> Vec<serde_json::Value> {
    let out = otelite()
        .arg("inspect")
        .arg(fixture("metrics.ndjson"))
        .args(["--signal", "metrics"])
        .output()
        .unwrap();
    assert!(out.status.success());
    rows(&out.stdout)
}

fn logs() -> Vec<serde_json::Value> {
    let out = otelite()
        .arg("inspect")
        .arg(fixture("logs.ndjson"))
        .args(["--signal", "logs"])
        .output()
        .unwrap();
    assert!(out.status.success());
    rows(&out.stdout)
}

/// M2: the request counter for status 500 is exactly 7 — a flat one-row select.
#[test]
fn metric_single_point_filter() {
    let m = metrics();
    let row: Vec<_> = m
        .iter()
        .filter(|r| r["name"] == "http.server.requests" && r["attrs"]["http.status_code"] == "500")
        .collect();
    assert_eq!(row.len(), 1);
    assert_eq!(row[0]["value"], 7);
    assert_eq!(row[0]["schema"], "otelite.metric/v1");
}

/// M6/M8: histogram /checkout exposes max and a derived mean as first-class fields.
#[test]
fn histogram_stats() {
    let m = metrics();
    let h = m
        .iter()
        .find(|r| r["name"] == "http.server.duration" && r["attrs"]["http.route"] == "/checkout")
        .unwrap();
    assert_eq!(h["max"], 1840.0);
    assert_eq!(h["mean"], 150.0);
    assert!(h["bucket_counts"].is_array() && h["explicit_bounds"].is_array());
}

/// M12: exp-histogram round-trips scale/zero_count/positive buckets.
#[test]
fn exp_histogram_fields() {
    let m = metrics();
    let e = m.iter().find(|r| r["type"] == "exphistogram").unwrap();
    assert_eq!(e["scale"], 2);
    assert_eq!(e["zero_count"], 3);
    assert!(e["positive_buckets"]["bucket_counts"].is_array());
}

/// M5: sum carries monotonic + temporality (so "valid for rate()" is assertable).
#[test]
fn sum_semantics() {
    let m = metrics();
    let s = m
        .iter()
        .find(|r| r["name"] == "http.server.requests")
        .unwrap();
    assert_eq!(s["monotonic"], true);
    assert_eq!(s["temporality"], "cumulative");
}

/// Summary: value stats on gauge/sum only; histogram rows omit them (footgun fix).
#[test]
fn metric_summary_value_stats_scoped() {
    let out = otelite()
        .arg("inspect")
        .arg(fixture("metrics.ndjson"))
        .args(["--signal", "metrics", "--summary"])
        .output()
        .unwrap();
    let s: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let by_name: std::collections::HashMap<&str, &serde_json::Value> = s["metrics"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| (m["name"].as_str().unwrap(), m))
        .collect();
    assert_eq!(by_name["http.server.requests"]["value_sum"], 1760.0);
    assert!(by_name["http.server.duration"].get("value_sum").is_none());
}

/// L4/L5/L9: ERROR logs share a trace_id; uncorrelated logs are null trace_id.
#[test]
fn log_trace_correlation() {
    let l = logs();
    let err_traces: std::collections::BTreeSet<&str> = l
        .iter()
        .filter(|r| r["severity_text"] == "ERROR")
        .map(|r| r["trace_id"].as_str().unwrap())
        .collect();
    assert_eq!(err_traces.len(), 1, "both ERRORs share one trace");
    let uncorrelated = l.iter().filter(|r| r["trace_id"].is_null()).count();
    assert_eq!(uncorrelated, 3);
}

/// L3: log summary rolls up by severity and service.
#[test]
fn log_summary_rollup() {
    let out = otelite()
        .arg("inspect")
        .arg(fixture("logs.ndjson"))
        .args(["--signal", "logs", "--summary"])
        .output()
        .unwrap();
    let s: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(s["by_severity"]["ERROR"], 2);
    assert_eq!(s["by_severity"]["INFO"], 3);
    assert_eq!(s["total"], 6);
}

/// Filters apply to flat metric rows (--attr).
#[test]
fn metric_attr_filter() {
    let out = otelite()
        .arg("inspect")
        .arg(fixture("metrics.ndjson"))
        .args(["--signal", "metrics", "--attr", "http.status_code=500"])
        .output()
        .unwrap();
    let r = rows(&out.stdout);
    assert_eq!(r.len(), 1);
    assert_eq!(r[0]["value"], 7);
}
