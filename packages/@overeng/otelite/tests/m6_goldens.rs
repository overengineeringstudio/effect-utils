//! M6 conformance goldens: lock the metric/log inspect output (flat rows +
//! summary) against the captured corpus, byte-for-byte under the canonical
//! serializer. Compare-only by default; `UPDATE_GOLDENS=1` regenerates.

use std::path::PathBuf;

use otelite::inspect::canonical::canonical;
use otelite::{inspect_logs, inspect_metrics};
use serde_json::Value;

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/conformance/m6")
}

fn read(name: &str) -> String {
    std::fs::read_to_string(dir().join(name)).unwrap()
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

fn ndjson(rows: &[Value]) -> String {
    rows.iter().map(canonical).collect::<Vec<_>>().join("\n")
}

#[test]
fn metric_flat_golden() {
    let rows = inspect_metrics::rows(&read("metrics.ndjson")).unwrap();
    check("metric-flat.golden.ndjson", &ndjson(&rows));
}

#[test]
fn metric_summary_golden() {
    let s = inspect_metrics::summary(&read("metrics.ndjson")).unwrap();
    check("metric-summary.golden.json", &canonical(&s));
}

#[test]
fn log_flat_golden() {
    let rows = inspect_logs::rows(&read("logs.ndjson")).unwrap();
    check("log-flat.golden.ndjson", &ndjson(&rows));
}

#[test]
fn log_summary_golden() {
    let s = inspect_logs::summary(&read("logs.ndjson")).unwrap();
    check("log-summary.golden.json", &canonical(&s));
}
