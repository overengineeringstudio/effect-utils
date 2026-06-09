//! M4 `inspect`-verb gates against the real binary. Captures are written
//! directly (canonical OTLP/JSON, exactly what the receiver emits) so these
//! gates don't need a live emitter.

use std::io::Write;
use std::process::{Command, Stdio};

fn otelite() -> Command {
    Command::new(env!("CARGO_BIN_EXE_otelite"))
}

/// One trace, two spans (op1 root with http.method=GET, op2 child), service svc-a.
const CAPTURE: &str = r#"{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"svc-a"}}]},"scopeSpans":[{"scope":{"name":"s"},"spans":[{"traceId":"11111111111111111111111111111111","spanId":"aaaaaaaaaaaaaaaa","name":"op1","kind":2,"startTimeUnixNano":"1000000000","endTimeUnixNano":"1005000000","attributes":[{"key":"http.method","value":{"stringValue":"GET"}}]},{"traceId":"11111111111111111111111111111111","spanId":"bbbbbbbbbbbbbbbb","parentSpanId":"aaaaaaaaaaaaaaaa","name":"op2","kind":1,"startTimeUnixNano":"1001000000","endTimeUnixNano":"1002000000"}]}]}]}"#;

fn write_capture(dir: &std::path::Path) {
    std::fs::write(dir.join("traces.ndjson"), format!("{CAPTURE}\n")).unwrap();
}

fn rows(stdout: &[u8]) -> Vec<serde_json::Value> {
    String::from_utf8_lossy(stdout)
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).expect("each line is JSON"))
        .collect()
}

/// `inspect <dir>` flattens to NDJSON `otelite.span/v1` rows.
#[test]
fn inspect_flat_rows() {
    let dir = tempfile::tempdir().unwrap();
    write_capture(dir.path());
    let out = otelite().arg("inspect").arg(dir.path()).output().unwrap();
    assert!(out.status.success());
    let rows = rows(&out.stdout);
    assert_eq!(rows.len(), 2, "two spans → two rows");
    assert!(rows.iter().all(|r| r["schema"] == "otelite.span/v1"));
    assert!(rows.iter().all(|r| r["service"] == "svc-a"));
    assert!(rows
        .iter()
        .all(|r| r["trace_id"] == "11111111111111111111111111111111"));
    let names: Vec<&str> = rows.iter().map(|r| r["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"op1") && names.contains(&"op2"));
}

/// `--name` and `--attr` filter the rows.
#[test]
fn inspect_filters() {
    let dir = tempfile::tempdir().unwrap();
    write_capture(dir.path());

    let by_name = otelite()
        .arg("inspect")
        .arg(dir.path())
        .args(["--name", "op1"])
        .output()
        .unwrap();
    assert_eq!(rows(&by_name.stdout).len(), 1);

    let by_attr = otelite()
        .arg("inspect")
        .arg(dir.path())
        .args(["--attr", "http.method=GET"])
        .output()
        .unwrap();
    let r = rows(&by_attr.stdout);
    assert_eq!(r.len(), 1);
    assert_eq!(r[0]["name"], "op1");
}

/// `--summary` emits one per-trace summary object, schema-tagged.
#[test]
fn inspect_summary() {
    let dir = tempfile::tempdir().unwrap();
    write_capture(dir.path());
    let out = otelite()
        .arg("inspect")
        .arg(dir.path())
        .arg("--summary")
        .output()
        .unwrap();
    assert!(out.status.success());
    let r = rows(&out.stdout);
    assert_eq!(r.len(), 1, "one trace → one summary");
    assert_eq!(r[0]["schema"], "otelite.trace-summary/v1");
    assert_eq!(r[0]["span_count"], 2);
}

/// `inspect -` reads the capture from stdin (composes with `run | inspect -`).
#[test]
fn inspect_stdin() {
    let mut child = otelite()
        .args(["inspect", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(format!("{CAPTURE}\n").as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success());
    assert_eq!(rows(&out.stdout).len(), 2);
}

/// `run | inspect -`: a run summary on stdin is followed to its `.out` capture,
/// so the advertised pipe composes (here the summary is fed directly).
#[test]
fn inspect_follows_run_summary() {
    let dir = tempfile::tempdir().unwrap();
    write_capture(dir.path());
    let summary = serde_json::json!({
        "schema": "otelite.summary/v1",
        "out": dir.path().to_str().unwrap(),
    })
    .to_string();
    let mut child = otelite()
        .args(["inspect", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(summary.as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success());
    assert_eq!(
        rows(&out.stdout).len(),
        2,
        "followed summary .out to the capture"
    );
}

/// The real advertised pipe: `otelite run -- <cmd> | otelite inspect -`. The
/// child emits nothing here, so the wiring (run summary → inspect follow) is
/// validated end-to-end with zero rows.
#[test]
fn real_run_piped_into_inspect() {
    let run_out = otelite().args(["run", "--", "true"]).output().unwrap();
    assert!(run_out.status.success());
    let mut child = otelite()
        .args(["inspect", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&run_out.stdout)
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "run|inspect- pipe must succeed");
    assert_eq!(rows(&out.stdout).len(), 0, "`true` emits no spans");
    // Clean up the auto out-dir the run created.
    if let Ok(s) = serde_json::from_slice::<serde_json::Value>(
        run_out.stdout.split(|b| *b == b'\n').next().unwrap_or(&[]),
    ) {
        if let Some(out_dir) = s["out"].as_str() {
            std::fs::remove_dir_all(out_dir).ok();
        }
    }
}

/// Missing source → 66; corrupt capture → 65.
#[test]
fn inspect_error_codes() {
    let missing = otelite()
        .args(["inspect", "/no/such/dir"])
        .output()
        .unwrap();
    assert_eq!(missing.status.code(), Some(66));

    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("traces.ndjson"), "not json\n").unwrap();
    let corrupt = otelite().arg("inspect").arg(dir.path()).output().unwrap();
    assert_eq!(corrupt.status.code(), Some(65));
}
