//! M7 `capture` verb: receiver-only, driven by an external emitter and stopped
//! by closing stdin (EOF). Exercised against the real binary (no mocks).

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

/// stdout is a tagged event stream: the first line is `otelite.endpoints/v1`
/// (emitted the instant both listeners bind — parsed as JSON, no scraping); the
/// receiver is stopped by closing stdin (EOF); the final stdout line is
/// `otelite.summary/v1`.
#[test]
fn capture_endpoints_stream_and_eof_stop() {
    let dir = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_otelite"))
        .arg("capture")
        .arg("--out")
        .arg(dir.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();

    let mut stdout = BufReader::new(child.stdout.take().unwrap());

    // First stdout line = the endpoints event; parse it as JSON (no scraping).
    let mut first = String::new();
    stdout.read_line(&mut first).unwrap();
    let endpoints: serde_json::Value = serde_json::from_str(first.trim()).unwrap();
    assert_eq!(endpoints["schema"], "otelite.endpoints/v1");
    let addr = endpoints["http"]
        .as_str()
        .unwrap()
        .strip_prefix("http://")
        .unwrap()
        .to_string();

    post(&addr);

    // Stop by closing stdin (EOF) — no signal/PID plumbing needed.
    drop(child.stdin.take());

    // Read the remaining stdout; the final line is the summary event.
    let mut rest = String::new();
    stdout.read_to_string(&mut rest).unwrap();
    child.wait().unwrap();

    let last = rest.lines().last().expect("capture emitted a summary line");
    let summary: serde_json::Value = serde_json::from_str(last).unwrap();
    assert_eq!(summary["schema"], "otelite.summary/v1");
    assert_eq!(summary["counts"]["spans"], 1);
    assert!(summary["child"].is_null(), "capture has no child");

    let captured = std::fs::read_to_string(dir.path().join("traces.ndjson")).unwrap();
    assert!(captured.contains("captured"));
}
