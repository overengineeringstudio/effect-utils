//! M2 receiver-core gates, exercised against the real receiver (no mocks).
//!
//! Each test binds its own ephemeral ports, so they also run concurrently
//! without coordination — a smoke of the isolation property (full K-scale gate
//! is M8).

use std::sync::Arc;

use opentelemetry_proto::tonic::collector::trace::v1::trace_service_client::TraceServiceClient;
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use otelite::receiver::RunningReceiver;
use otelite::sink::{Sink, SinkError};

/// One span in the default OTel-SDK OTLP/JSON dialect: hex IDs, string int64
/// nanos, integer `kind`. Carries `service.name=fixture` and a unique `name`.
fn default_dialect_trace(span_name: &str) -> String {
    format!(
        r#"{{"resourceSpans":[{{"resource":{{"attributes":[{{"key":"service.name","value":{{"stringValue":"fixture"}}}}]}},"scopeSpans":[{{"scope":{{"name":"test"}},"spans":[{{"traceId":"5b8efff798038103d269b633813fc60c","spanId":"eee19b7ec3c1b174","name":"{span_name}","kind":2,"startTimeUnixNano":"1544712660000000000","endTimeUnixNano":"1544712661000000000"}}]}}]}}]}}"#
    )
}

async fn start(out_dir: &std::path::Path) -> RunningReceiver {
    let sink = Arc::new(Sink::create(out_dir).await.expect("create sink"));
    RunningReceiver::start(sink).await.expect("start receiver")
}

/// HTTP/JSON export is captured as canonical OTLP/JSON, span counted.
#[tokio::test]
async fn http_json_capture() {
    let dir = tempfile::tempdir().unwrap();
    let rx = start(dir.path()).await;
    let resp = reqwest::Client::new()
        .post(format!("{}/v1/traces", rx.http_endpoint))
        .header("content-type", "application/json")
        .body(default_dialect_trace("GET /http-json"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let counts = rx.shutdown().await;
    assert_eq!(counts.spans, 1);
    let captured = std::fs::read_to_string(dir.path().join("traces.ndjson")).unwrap();
    assert!(captured.contains("GET /http-json"));
    assert!(captured.contains("5b8efff798038103d269b633813fc60c"));
}

/// Durability: the span is on disk by the time the client gets its 200 — read
/// the file *before* shutdown/sync. Proves the write gates the ack.
#[tokio::test]
async fn durable_before_ack() {
    let dir = tempfile::tempdir().unwrap();
    let rx = start(dir.path()).await;
    let resp = reqwest::Client::new()
        .post(format!("{}/v1/traces", rx.http_endpoint))
        .header("content-type", "application/json")
        .body(default_dialect_trace("durable"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    // No shutdown/sync yet — if the ack didn't gate on the write, this is empty.
    let captured = std::fs::read_to_string(dir.path().join("traces.ndjson")).unwrap();
    assert!(captured.contains("durable"), "span not on disk at ack time");
    rx.shutdown().await;
}

/// Non-default JSON dialect (numeric int64 nanos) is rejected loudly (400) and
/// captured nowhere — never a silent 200 (decisions/0011).
#[tokio::test]
async fn non_default_dialect_rejected_loudly() {
    let dir = tempfile::tempdir().unwrap();
    let rx = start(dir.path()).await;
    // startTimeUnixNano as a JSON number (not a string) — conformant OTLP/JSON
    // but not the default-SDK dialect, so the decoder rejects it.
    let body = r#"{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"5b8efff798038103d269b633813fc60c","spanId":"eee19b7ec3c1b174","name":"x","startTimeUnixNano":1544712660000000000}]}]}]}"#;
    let resp = reqwest::Client::new()
        .post(format!("{}/v1/traces", rx.http_endpoint))
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400, "non-default dialect must be rejected loudly");
    let counts = rx.shutdown().await;
    assert_eq!(counts.spans, 0, "rejected payload must not be captured");
    let captured = std::fs::read_to_string(dir.path().join("traces.ndjson")).unwrap();
    assert!(captured.is_empty());
}

/// gRPC export lands on the reported port and is captured.
#[tokio::test]
async fn grpc_capture() {
    let dir = tempfile::tempdir().unwrap();
    let rx = start(dir.path()).await;
    let mut client = TraceServiceClient::connect(rx.grpc_endpoint.clone())
        .await
        .expect("connect grpc on reported port");
    let req: ExportTraceServiceRequest =
        serde_json::from_str(&default_dialect_trace("grpc-span")).unwrap();
    client.export(req).await.expect("grpc export ok");
    let counts = rx.shutdown().await;
    assert_eq!(counts.spans, 1);
    let captured = std::fs::read_to_string(dir.path().join("traces.ndjson")).unwrap();
    assert!(captured.contains("grpc-span"));
}

/// A second sink on the same out-dir fails loudly (O_EXCL) instead of
/// truncating the first run's capture (decisions/0010).
#[tokio::test]
async fn shared_out_dir_fails_loud() {
    let dir = tempfile::tempdir().unwrap();
    let _first = Sink::create(dir.path()).await.expect("first sink");
    let second = Sink::create(dir.path()).await;
    assert!(
        matches!(second, Err(SinkError::AlreadyExists(_))),
        "second run on same out-dir must fail loudly with AlreadyExists"
    );
}
