//! Trace-derived metrics (R11, decisions/0013): conformance goldens for the
//! spanmetrics derivation + agentic RED assertions through the real binary.

use std::path::PathBuf;
use std::process::Command;

use otelite::derive_spanmetrics::derive;
use otelite::inspect::canonical::canonical;
use otelite::inspect_metrics::summary_of_rows;
use serde_json::Value;

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/conformance/spanmetrics")
}

fn capture() -> String {
    std::fs::read_to_string(dir().join("traces.ndjson")).unwrap()
}

fn check(golden: &str, got: &str) {
    let p = dir().join(golden);
    if std::env::var("UPDATE_GOLDENS").as_deref() == Ok("1") {
        std::fs::write(&p, format!("{got}\n")).unwrap();
        return;
    }
    let want = std::fs::read_to_string(&p)
        .unwrap_or_else(|e| panic!("{p:?}: {e}"))
        .trim()
        .to_string();
    assert_eq!(got, want, "golden mismatch: {golden}");
}

#[test]
fn calls_duration_golden() {
    let rows = derive(&capture()).unwrap();
    let got = rows.iter().map(canonical).collect::<Vec<_>>().join("\n");
    check("calls-duration.golden.ndjson", &got);
}

#[test]
fn summary_golden() {
    let rows = derive(&capture()).unwrap();
    check("summary.golden.json", &canonical(&summary_of_rows(&rows)));
}

/// RED facts an agent would assert, through the real binary.
#[test]
fn red_assertions_via_cli() {
    let out = Command::new(env!("CARGO_BIN_EXE_otelite"))
        .arg("inspect")
        .arg(dir().join("traces.ndjson"))
        .args(["--signal", "traces", "--derive-metrics"])
        .output()
        .unwrap();
    assert!(out.status.success());
    let rows: Vec<Value> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();

    let calls: Vec<&Value> = rows.iter().filter(|r| r["name"] == "calls").collect();
    let total: u64 = calls.iter().map(|r| r["value"].as_u64().unwrap()).sum();
    let errors: u64 = calls
        .iter()
        .filter(|r| r["attrs"]["status.code"] == "STATUS_CODE_ERROR")
        .map(|r| r["value"].as_u64().unwrap())
        .sum();
    assert_eq!(total, 5, "total calls");
    assert_eq!(errors, 2, "error calls");

    // Every derived row is a faithful otelite.metric/v1 row (uniform with native).
    assert!(rows.iter().all(|r| r["schema"] == "otelite.metric/v1"));
    // A duration histogram exposes first-class stats + the connector's bounds.
    let dur = rows
        .iter()
        .find(|r| {
            r["name"] == "duration"
                && r["service"] == "payment"
                && r["attrs"]["status.code"] == "STATUS_CODE_ERROR"
        })
        .unwrap();
    assert_eq!(dur["max"], 1000.0);
    assert_eq!(dur["explicit_bounds"][0], 2.0);
}
