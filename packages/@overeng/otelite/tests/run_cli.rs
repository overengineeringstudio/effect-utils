//! M3 `run`-verb gates, exercised against the real built binary (no mocks).
//! Capture/drain *count* gates use the fixture emitter and live in M5/M8; here
//! we gate the run mechanics that don't need an emitter.

use std::path::Path;
use std::process::Command;

fn otelite() -> Command {
    Command::new(env!("CARGO_BIN_EXE_otelite"))
}

/// Parse the single-line summary JSON from stdout.
fn summary(stdout: &[u8]) -> serde_json::Value {
    let s = String::from_utf8_lossy(stdout);
    let line = s.lines().next().expect("a summary line on stdout");
    serde_json::from_str(line).expect("stdout is valid summary JSON")
}

/// `run` preserves the child's exit code.
#[test]
fn preserves_child_exit_code() {
    let dir = tempfile::tempdir().unwrap();
    let out = otelite()
        .args(["run", "--out"])
        .arg(dir.path())
        .args(["--", "sh", "-c", "exit 42"])
        .output()
        .unwrap();
    assert_eq!(
        out.status.code(),
        Some(42),
        "child exit code must be preserved"
    );
    // Summary still emitted on stdout, even on non-zero exit.
    assert_eq!(summary(&out.stdout)["child"]["exit_code"], 42);
}

/// stdout is one clean summary JSON object even when the child spews to stdout.
#[test]
fn stdout_is_clean_summary_only() {
    let dir = tempfile::tempdir().unwrap();
    let out = otelite()
        .args(["run", "--out"])
        .arg(dir.path())
        .args(["--", "sh", "-c", "echo NOISE_ON_CHILD_STDOUT; echo more"])
        .output()
        .unwrap();
    let s = summary(&out.stdout);
    assert_eq!(s["schema"], "otelite.summary/v1");
    // The child's literal stdout line must not appear as a top-level stdout line.
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert_eq!(
        stdout.lines().count(),
        1,
        "stdout must be exactly one JSON line"
    );
    // The child's noise is on stderr instead.
    assert!(String::from_utf8_lossy(&out.stderr).contains("NOISE_ON_CHILD_STDOUT"));
}

/// `OTEL_*` env: endpoint/protocol are owned (overwritten); resource attrs pass
/// through; `--service` beats a parent `OTEL_SERVICE_NAME`.
#[test]
fn env_owned_and_respected_split() {
    let dir = tempfile::tempdir().unwrap();
    let envfile = dir.path().join("childenv");
    let out = otelite()
        .env("OTEL_EXPORTER_OTLP_ENDPOINT", "http://decoy.invalid:1")
        // A per-signal endpoint would otherwise win over our base and misroute
        // telemetry away from the receiver — must be cleared.
        .env("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "http://decoy-traces.invalid/v1/traces")
        .env("OTEL_RESOURCE_ATTRIBUTES", "deployment.env=test")
        .env("OTEL_SERVICE_NAME", "parent-svc")
        .env("ENVOUT", &envfile)
        .args(["run", "--out"])
        .arg(dir.path())
        .args(["--service", "override-svc", "--", "sh", "-c"])
        .arg(r#"printf '%s\n%s\n%s\n[%s]\n' "$OTEL_EXPORTER_OTLP_ENDPOINT" "$OTEL_RESOURCE_ATTRIBUTES" "$OTEL_SERVICE_NAME" "$OTEL_EXPORTER_OTLP_TRACES_ENDPOINT" > "$ENVOUT""#)
        .output()
        .unwrap();
    assert!(out.status.success());
    let env = std::fs::read_to_string(&envfile).unwrap();
    let mut lines = env.lines();
    let endpoint = lines.next().unwrap();
    let resource = lines.next().unwrap();
    let service = lines.next().unwrap();
    let traces_endpoint = lines.next().unwrap();
    assert!(
        endpoint.starts_with("http://127.0.0.1:"),
        "endpoint must be overwritten to the receiver, got {endpoint}"
    );
    assert_eq!(
        resource, "deployment.env=test",
        "resource attrs pass through"
    );
    assert_eq!(
        service, "override-svc",
        "--service beats parent OTEL_SERVICE_NAME"
    );
    assert_eq!(
        traces_endpoint, "[]",
        "per-signal *_TRACES_ENDPOINT must be cleared so the base endpoint wins"
    );
}

/// `--protocol grpc` points the child's endpoint at the gRPC receiver.
#[test]
fn protocol_grpc_points_at_grpc_endpoint() {
    let dir = tempfile::tempdir().unwrap();
    let envfile = dir.path().join("e");
    let out = otelite()
        .env("ENVOUT", &envfile)
        .args(["run", "--out"])
        .arg(dir.path())
        .args(["--protocol", "grpc", "--", "sh", "-c"])
        .arg(r#"printf '%s\n%s\n%s\n' "$OTEL_EXPORTER_OTLP_ENDPOINT" "$OTEL_EXPORTER_OTLP_PROTOCOL" "$OTELITE_GRPC_ENDPOINT" > "$ENVOUT""#)
        .output()
        .unwrap();
    assert!(out.status.success());
    let e = std::fs::read_to_string(&envfile).unwrap();
    let mut l = e.lines();
    let endpoint = l.next().unwrap();
    let protocol = l.next().unwrap();
    let grpc = l.next().unwrap();
    assert_eq!(protocol, "grpc");
    assert_eq!(
        endpoint, grpc,
        "endpoint must be the gRPC one under --protocol grpc"
    );
}

/// Without `--out`, otelite mints a unique dir under $TMPDIR and echoes it.
#[test]
fn auto_unique_out_dir_echoed() {
    let out = otelite().args(["run", "--", "true"]).output().unwrap();
    assert!(out.status.success());
    let s = summary(&out.stdout);
    let out_dir = s["out"].as_str().unwrap();
    assert!(
        out_dir.contains("otelite-"),
        "auto out-dir should be named otelite-*"
    );
    assert!(
        Path::new(out_dir).join("traces.ndjson").exists(),
        "capture files created"
    );
    std::fs::remove_dir_all(out_dir).ok();
}

/// SIGINT mid-run: a terminal Ctrl-C reaches both otelite and its child (shared
/// process group). otelite must *swallow* its own SIGINT, let the child take it,
/// drain, and still emit the summary — reporting the child's signal death as
/// `128+SIGINT` (130). Regression guard for the drain-on-signal path.
#[cfg(unix)]
#[test]
fn sigint_mid_run_drains_and_reports_signal() {
    use std::io::{BufRead, BufReader, Read};
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;

    let dir = tempfile::tempdir().unwrap();
    // The child prints a readiness marker (forwarded to otelite's stderr), then
    // blocks — so the test can signal only once otelite is in its wait loop.
    let mut child = otelite()
        .args(["run", "--out"])
        .arg(dir.path())
        .args(["--", "sh", "-c", "echo READY_MARKER; sleep 30"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Put otelite in its own process group so signaling the group can't reach
        // the test runner; the child inherits this group too.
        .process_group(0)
        .spawn()
        .unwrap();
    let pgid = child.id();

    // Synchronize on the child's marker (no sleep): once it appears, the child is
    // running and otelite has registered its signal handler.
    let mut stderr = BufReader::new(child.stderr.take().unwrap());
    let mut line = String::new();
    loop {
        line.clear();
        let n = stderr.read_line(&mut line).unwrap();
        assert_ne!(n, 0, "otelite exited before the child became ready");
        if line.contains("READY_MARKER") {
            break;
        }
    }

    // Ctrl-C the whole group (negative pid). otelite swallows it; the child dies.
    Command::new("sh")
        .arg("-c")
        .arg(format!("kill -INT -{pgid}"))
        .status()
        .unwrap();

    let mut stdout = String::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut stdout)
        .unwrap();
    let status = child.wait().unwrap();

    assert_eq!(
        status.code(),
        Some(130),
        "child killed by SIGINT → otelite reports 128+SIGINT"
    );
    let s = summary(stdout.as_bytes());
    assert_eq!(
        s["schema"], "otelite.summary/v1",
        "summary emitted despite SIGINT"
    );
    assert_eq!(s["child"]["exit_code"], 130);
}

/// A missing child command after `--` is a usage error (sysexits 64).
#[test]
fn missing_child_is_usage_error() {
    let out = otelite().args(["run", "--out", "/tmp/x"]).output().unwrap();
    assert_eq!(out.status.code(), Some(64));
    assert!(out.stdout.is_empty(), "no summary on a usage error");
}
