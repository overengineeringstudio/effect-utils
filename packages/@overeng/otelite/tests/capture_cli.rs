//! M7 `capture` verb: receiver-only, driven by an external emitter and stopped
//! with a signal. Exercised against the real binary (no mocks).

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::process::{Command, Stdio};

const SPAN: &str = r#"{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"cap"}}]},"scopeSpans":[{"scope":{"name":"t"},"spans":[{"traceId":"5b8efff798038103d269b633813fc60c","spanId":"eee19b7ec3c1b174","name":"captured","kind":2,"startTimeUnixNano":"1000000000","endTimeUnixNano":"1002000000"}]}]}]}"#;

/// Raw HTTP/1.1 POST of an OTLP/JSON span (no client dep needed).
fn post(addr: &str) {
    let mut s = TcpStream::connect(addr).expect("connect receiver");
    let req = format!(
        "POST /v1/traces HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        SPAN.len(),
        SPAN
    );
    s.write_all(req.as_bytes()).unwrap();
    let mut resp = String::new();
    s.read_to_string(&mut resp).unwrap();
    assert!(
        resp.starts_with("HTTP/1.1 200"),
        "receiver should 200: {resp}"
    );
}

#[test]
fn capture_serves_until_signal() {
    let dir = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_otelite"))
        .arg("capture")
        .arg("--out")
        .arg(dir.path())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    // Read stderr until the receiver announces its HTTP endpoint.
    let stderr = BufReader::new(child.stderr.take().unwrap());
    let mut addr = None;
    for line in stderr.lines().map_while(Result::ok) {
        if let Some(ep) = line.split("OTEL_EXPORTER_OTLP_ENDPOINT=").nth(1) {
            addr = ep.strip_prefix("http://").map(str::to_string);
            break;
        }
    }
    let addr = addr.expect("capture printed its endpoint");

    post(&addr);

    // Stop it with SIGTERM; capture drains + emits the summary.
    Command::new("kill")
        .arg("-TERM")
        .arg(child.id().to_string())
        .status()
        .unwrap();

    let mut stdout = String::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut stdout)
        .unwrap();
    child.wait().unwrap();

    let summary: serde_json::Value = serde_json::from_str(stdout.lines().next().unwrap()).unwrap();
    assert_eq!(summary["schema"], "otelite.summary/v1");
    assert_eq!(summary["counts"]["spans"], 1);
    assert!(summary["child"].is_null(), "capture has no child");

    let captured = std::fs::read_to_string(dir.path().join("traces.ndjson")).unwrap();
    assert!(captured.contains("captured"));
}
