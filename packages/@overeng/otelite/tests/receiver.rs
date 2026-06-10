//! M2 receiver-core gates, exercised against the real receiver (no mocks).
//!
//! Each test binds its own ephemeral ports, so they also run concurrently
//! without coordination — a smoke of the isolation property (full K-scale gate
//! is M8).

use std::sync::Arc;

use opentelemetry_proto::tonic::collector::logs::v1::logs_service_client::LogsServiceClient;
use opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceRequest;
use opentelemetry_proto::tonic::collector::metrics::v1::metrics_service_client::MetricsServiceClient;
use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest;
use opentelemetry_proto::tonic::collector::trace::v1::trace_service_client::TraceServiceClient;
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use otelite::receiver::RunningReceiver;
use otelite::sink::{Sink, SinkError};
use prost::Message;

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
    assert_eq!(
        resp.status(),
        400,
        "non-default dialect must be rejected loudly"
    );
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

/// gRPC for metrics *and* logs (not just traces): a real SDK driving the gRPC
/// receiver across all three signals is exercised end-to-end, counted, and on
/// disk. Closes the gap where only the trace gRPC path had a gate.
#[tokio::test]
async fn grpc_metrics_and_logs_capture() {
    let dir = tempfile::tempdir().unwrap();
    let rx = start(dir.path()).await;

    let metrics_json = r#"{"resourceMetrics":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"m-svc"}}]},"scopeMetrics":[{"scope":{"name":"s"},"metrics":[{"name":"reqs","unit":"1","sum":{"isMonotonic":true,"aggregationTemporality":2,"dataPoints":[{"asInt":"7","timeUnixNano":"2000000000","startTimeUnixNano":"1000000000","attributes":[]}]}}]}]}]}"#;
    let logs_json = r#"{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"l-svc"}}]},"scopeLogs":[{"scope":{"name":"s"},"logRecords":[{"timeUnixNano":"2000000000","severityNumber":9,"severityText":"INFO","body":{"stringValue":"hello-grpc-log"}}]}]}]}"#;

    let mut metrics = MetricsServiceClient::connect(rx.grpc_endpoint.clone())
        .await
        .expect("connect grpc metrics");
    let req: ExportMetricsServiceRequest = serde_json::from_str(metrics_json).unwrap();
    metrics.export(req).await.expect("grpc metrics export ok");

    let mut logs = LogsServiceClient::connect(rx.grpc_endpoint.clone())
        .await
        .expect("connect grpc logs");
    let req: ExportLogsServiceRequest = serde_json::from_str(logs_json).unwrap();
    logs.export(req).await.expect("grpc logs export ok");

    let counts = rx.shutdown().await;
    assert_eq!(counts.metrics, 1, "one metric captured over gRPC");
    assert_eq!(counts.logs, 1, "one log record captured over gRPC");
    assert!(std::fs::read_to_string(dir.path().join("metrics.ndjson"))
        .unwrap()
        .contains("reqs"));
    assert!(std::fs::read_to_string(dir.path().join("logs.ndjson"))
        .unwrap()
        .contains("hello-grpc-log"));
}

/// Exponential histograms survive the protobuf receive path: receive → capture →
/// `inspect --signal metrics` exposes the exp-hist stats. (The JSON path now
/// survives them too — see `http_json_metrics_lossless`, which persists the
/// validated raw body instead of the lossy proto re-serialization.)
#[tokio::test]
async fn exponential_histogram_round_trips_over_protobuf() {
    use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest;
    use opentelemetry_proto::tonic::common::v1::{any_value, AnyValue, KeyValue};
    use opentelemetry_proto::tonic::metrics::v1::{
        exponential_histogram_data_point::Buckets, metric, ExponentialHistogram,
        ExponentialHistogramDataPoint, Metric, ResourceMetrics, ScopeMetrics,
    };
    use opentelemetry_proto::tonic::resource::v1::Resource;

    let dp = ExponentialHistogramDataPoint {
        time_unix_nano: 2_000_000_000,
        start_time_unix_nano: 1_000_000_000,
        count: 6,
        sum: Some(42.0),
        scale: 3,
        zero_count: 1,
        positive: Some(Buckets {
            offset: 2,
            bucket_counts: vec![1, 2, 2],
        }),
        ..Default::default()
    };
    let req = ExportMetricsServiceRequest {
        resource_metrics: vec![ResourceMetrics {
            resource: Some(Resource {
                attributes: vec![KeyValue {
                    key: "service.name".into(),
                    value: Some(AnyValue {
                        value: Some(any_value::Value::StringValue("eh-svc".into())),
                    }),
                }],
                ..Default::default()
            }),
            scope_metrics: vec![ScopeMetrics {
                metrics: vec![Metric {
                    name: "latency".into(),
                    unit: "ms".into(),
                    data: Some(metric::Data::ExponentialHistogram(ExponentialHistogram {
                        data_points: vec![dp],
                        aggregation_temporality: 2,
                    })),
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        }],
    };

    let dir = tempfile::tempdir().unwrap();
    let rx = start(dir.path()).await;
    let resp = reqwest::Client::new()
        .post(format!("{}/v1/metrics", rx.http_endpoint))
        .header("content-type", "application/x-protobuf")
        .body(req.encode_to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200, "protobuf exp-hist must be accepted");
    let counts = rx.shutdown().await;
    assert_eq!(counts.metrics, 1);

    // The captured file → inspect rows (exactly what the CLI flattens).
    let raw = std::fs::read_to_string(dir.path().join("metrics.ndjson")).unwrap();
    let rows = otelite::inspect_metrics::rows(&raw).expect("flatten metric rows");
    let eh = rows
        .iter()
        .find(|r| r["type"] == "exphistogram")
        .expect("an exphistogram row survived the protobuf path");
    assert_eq!(eh["service"], "eh-svc");
    assert_eq!(eh["count"], 6);
    assert_eq!(eh["scale"], 3);
    assert_eq!(eh["zero_count"], 1);
    assert_eq!(eh["positive_buckets"]["offset"], 2);
    assert_eq!(
        eh["positive_buckets"]["bucket_counts"],
        serde_json::json!([1, 2, 2])
    );
}

/// HTTP-JSON metrics are lossless: a string-form int64 `sum`, a regular
/// `histogram`, and an `exponentialHistogram` in one JSON export all survive
/// receive → capture → `inspect --signal metrics`. Before the fix the
/// `with-serde` deserialize that built the persisted proto value silently
/// dropped the string-int64 value, the histogram oneof, and the exp-hist oneof;
/// persisting the validated raw body keeps them (decisions/0011).
#[tokio::test]
async fn http_json_metrics_lossless() {
    let body = r#"{"resourceMetrics":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"p"}}]},"scopeMetrics":[{"scope":{"name":"p"},"metrics":[
 {"name":"a","sum":{"aggregationTemporality":2,"isMonotonic":true,"dataPoints":[{"asInt":"7","startTimeUnixNano":"1","timeUnixNano":"2","attributes":[]}]}},
 {"name":"lat","unit":"ms","histogram":{"aggregationTemporality":2,"dataPoints":[{"count":"3","sum":42.5,"min":1.0,"max":30.0,"bucketCounts":["1","1","1"],"explicitBounds":[5.0,20.0],"startTimeUnixNano":"1","timeUnixNano":"2","attributes":[]}]}},
 {"name":"eh","unit":"ms","exponentialHistogram":{"aggregationTemporality":2,"dataPoints":[{"count":"6","sum":42.0,"scale":3,"zeroCount":"1","positive":{"offset":2,"bucketCounts":["1","2","2"]},"startTimeUnixNano":"1","timeUnixNano":"2","attributes":[]}]}}
]}]}]}"#;

    let dir = tempfile::tempdir().unwrap();
    let rx = start(dir.path()).await;
    let resp = reqwest::Client::new()
        .post(format!("{}/v1/metrics", rx.http_endpoint))
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let counts = rx.shutdown().await;
    assert_eq!(counts.metrics, 3, "all three metrics counted");
    assert_eq!(counts.rejected, 0, "default-dialect JSON is not rejected");

    let raw = std::fs::read_to_string(dir.path().join("metrics.ndjson")).unwrap();
    let rows = otelite::inspect_metrics::rows(&raw).expect("flatten metric rows");

    // BUG-1: the string-form int64 sum value must be captured as 7, not null.
    let sum = rows
        .iter()
        .find(|r| r["name"] == "a")
        .expect("sum row present");
    assert_eq!(sum["type"], "sum");
    assert_eq!(sum["value"], 7);

    // BUG-2: the regular histogram must be present with its stats.
    let hist = rows
        .iter()
        .find(|r| r["name"] == "lat")
        .expect("histogram row present (not dropped)");
    assert_eq!(hist["type"], "histogram");
    assert_eq!(hist["count"], 3);
    assert_eq!(hist["sum"], 42.5);
    assert_eq!(hist["min"], 1.0);
    assert_eq!(hist["max"], 30.0);
    assert_eq!(hist["bucket_counts"], serde_json::json!([1, 1, 1]));
    assert_eq!(hist["explicit_bounds"], serde_json::json!([5.0, 20.0]));

    // Exp-histogram-on-JSON (previously documented as lossy) now survives too.
    let eh = rows
        .iter()
        .find(|r| r["type"] == "exphistogram")
        .expect("exp-histogram row survived the JSON path");
    assert_eq!(eh["count"], 6);
    assert_eq!(eh["scale"], 3);
    assert_eq!(eh["zero_count"], 1);
    assert_eq!(eh["positive_buckets"]["offset"], 2);
    assert_eq!(
        eh["positive_buckets"]["bucket_counts"],
        serde_json::json!([1, 2, 2])
    );
}

/// A metrics JSON body the `with-serde` validator rejects (here a hard type
/// error: `name` as a number) is still rejected loudly (400) and captured
/// nowhere — the validator gate is preserved even though the JSON path now
/// persists the raw body on success.
///
/// Note: the upstream metrics `with-serde` deserializer is far more lenient than
/// the trace one — it tolerates most non-default dialect shapes (numeric int64
/// nanos, string enums) rather than erroring, so for metrics this gate is
/// effectively structural (malformed JSON / wrong field types), not a full
/// dialect gate. See decisions/0011.
#[tokio::test]
async fn http_json_metrics_non_default_dialect_rejected_loudly() {
    let dir = tempfile::tempdir().unwrap();
    let rx = start(dir.path()).await;
    // `name` as a JSON number is a hard type mismatch the deserializer rejects.
    let body = r#"{"resourceMetrics":[{"scopeMetrics":[{"metrics":[{"name":5,"sum":{"isMonotonic":true,"aggregationTemporality":2,"dataPoints":[{"asInt":"7"}]}}]}]}]}"#;
    let resp = reqwest::Client::new()
        .post(format!("{}/v1/metrics", rx.http_endpoint))
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400, "non-default dialect must be rejected");
    let counts = rx.shutdown().await;
    assert_eq!(counts.metrics, 0, "rejected payload must not be captured");
    assert_eq!(counts.rejected, 1);
    assert!(std::fs::read_to_string(dir.path().join("metrics.ndjson"))
        .unwrap()
        .is_empty());
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
