//! M5 — cross-transport equivalence, the central correctness invariant
//! (spec.md Testing): the same logical span emitted via OTLP/HTTP-JSON,
//! OTLP/HTTP-protobuf, and OTLP/gRPC must produce a byte-identical canonical
//! capture after normalization. One regression in any decode path or in the
//! serializer fails this gate.

use std::sync::Arc;

use opentelemetry_proto::tonic::collector::metrics::v1::metrics_service_client::MetricsServiceClient;
use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest;
use opentelemetry_proto::tonic::collector::trace::v1::trace_service_client::TraceServiceClient;
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use otelite::receiver::RunningReceiver;
use otelite::sink::Sink;
use prost::Message;
use serde_json::Value;

/// The one logical span (default OTel-SDK dialect) all three transports emit.
const SPAN_JSON: &str = r#"{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"equiv"}},{"key":"deployment.env","value":{"stringValue":"test"}}]},"scopeSpans":[{"scope":{"name":"t"},"spans":[{"traceId":"5b8efff798038103d269b633813fc60c","spanId":"eee19b7ec3c1b174","name":"GET /x","kind":2,"startTimeUnixNano":"1544712660000000000","endTimeUnixNano":"1544712661000000000","attributes":[{"key":"http.method","value":{"stringValue":"GET"}},{"key":"http.status_code","value":{"intValue":"200"}}]}]}]}]}"#;

fn fixture() -> ExportTraceServiceRequest {
    serde_json::from_str(SPAN_JSON).unwrap()
}

/// Normalizer N: recursively key-sort objects and sort every `attributes` array
/// by its `key`, so benign ordering differences don't fail byte-equality. (IDs
/// are already lowercase hex and int64s already strings via with-serde.)
fn normalize(line: &str) -> String {
    let mut v: Value = serde_json::from_str(line).expect("captured line is JSON");
    norm(&mut v);
    serde_json::to_string(&v).unwrap()
}

fn norm(v: &mut Value) {
    match v {
        Value::Object(map) => {
            let mut sorted: serde_json::Map<String, Value> = serde_json::Map::new();
            let mut keys: Vec<String> = map.keys().cloned().collect();
            keys.sort();
            for k in keys {
                let mut child = map.remove(&k).unwrap();
                norm(&mut child);
                sorted.insert(k, child);
            }
            *map = sorted;
        }
        Value::Array(arr) => {
            for item in arr.iter_mut() {
                norm(item);
            }
            // Sort attribute arrays (elements with a "key") by key.
            if arr
                .iter()
                .all(|e| e.get("key").and_then(Value::as_str).is_some())
                && !arr.is_empty()
            {
                arr.sort_by(|a, b| a["key"].as_str().unwrap().cmp(b["key"].as_str().unwrap()));
            }
        }
        _ => {}
    }
}

/// Start a fresh receiver capturing into `dir`.
async fn start(dir: &std::path::Path) -> RunningReceiver {
    let sink = Arc::new(Sink::create(dir).await.unwrap());
    RunningReceiver::start(sink).await.unwrap()
}

async fn capture_http(dir: &std::path::Path, proto: bool) -> String {
    let rx = start(dir).await;
    let req = fixture();
    let client = reqwest::Client::new();
    let mut b = client.post(format!("{}/v1/traces", rx.http_endpoint));
    if proto {
        b = b
            .header("content-type", "application/x-protobuf")
            .body(req.encode_to_vec());
    } else {
        b = b
            .header("content-type", "application/json")
            .body(serde_json::to_string(&req).unwrap());
    }
    assert_eq!(b.send().await.unwrap().status(), 200);
    rx.shutdown().await;
    read_one(dir)
}

async fn capture_grpc(dir: &std::path::Path) -> String {
    let rx = start(dir).await;
    let mut client = TraceServiceClient::connect(rx.grpc_endpoint.clone())
        .await
        .unwrap();
    client.export(fixture()).await.unwrap();
    rx.shutdown().await;
    read_one(dir)
}

fn read_one(dir: &std::path::Path) -> String {
    std::fs::read_to_string(dir.join("traces.ndjson"))
        .unwrap()
        .lines()
        .next()
        .unwrap()
        .to_string()
}

#[tokio::test]
async fn cross_transport_equivalence() {
    let json_dir = tempfile::tempdir().unwrap();
    let proto_dir = tempfile::tempdir().unwrap();
    let grpc_dir = tempfile::tempdir().unwrap();

    let json = normalize(&capture_http(json_dir.path(), false).await);
    let proto = normalize(&capture_http(proto_dir.path(), true).await);
    let grpc = normalize(&capture_grpc(grpc_dir.path()).await);

    assert_eq!(
        json, proto,
        "HTTP-JSON and HTTP-protobuf must capture identically"
    );
    assert_eq!(
        proto, grpc,
        "HTTP-protobuf and gRPC must capture identically"
    );

    // Sanity: the canonical capture carries the span faithfully.
    assert!(json.contains("GET /x"));
    assert!(json.contains("5b8efff798038103d269b633813fc60c"));
    assert!(json.contains("http.status_code"));
}

// ---- M5 cross-transport equivalence: metrics --------------------------------

/// The one logical metrics export (default OTel-SDK dialect) emitted over
/// HTTP-JSON: a string-form int64 `sum` and a regular `histogram`. These are
/// exactly the shapes the JSON `with-serde` deserialize used to drop, so this
/// gate proves HTTP-JSON now produces the same captured rows as protobuf and
/// gRPC, not an empty/null-valued degradation.
const METRICS_JSON: &str = r#"{"resourceMetrics":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"equiv-m"}}]},"scopeMetrics":[{"scope":{"name":"m"},"metrics":[{"name":"a","sum":{"aggregationTemporality":2,"isMonotonic":true,"dataPoints":[{"asInt":"7","startTimeUnixNano":"1","timeUnixNano":"2","attributes":[]}]}},{"name":"lat","unit":"ms","histogram":{"aggregationTemporality":2,"dataPoints":[{"count":"3","sum":42.5,"min":1.0,"max":30.0,"bucketCounts":["1","1","1"],"explicitBounds":[5.0,20.0],"startTimeUnixNano":"1","timeUnixNano":"2","attributes":[]}]}}]}]}]}"#;

/// The SAME logical export built natively in proto types — the lossless source
/// for the protobuf and gRPC transports. It must NOT be derived from
/// `METRICS_JSON` via `with-serde`, since that deserialize is itself lossy (it
/// drops the string-int64 sum value and the histogram oneof); building from the
/// JSON would compare two degraded captures and pass vacuously.
fn metrics_fixture() -> ExportMetricsServiceRequest {
    use opentelemetry_proto::tonic::common::v1::{any_value, AnyValue, KeyValue};
    use opentelemetry_proto::tonic::metrics::v1::{
        metric, number_data_point, Histogram, HistogramDataPoint, Metric, NumberDataPoint,
        ResourceMetrics, ScopeMetrics, Sum,
    };
    use opentelemetry_proto::tonic::resource::v1::Resource;

    let sum = Metric {
        name: "a".into(),
        data: Some(metric::Data::Sum(Sum {
            is_monotonic: true,
            aggregation_temporality: 2,
            data_points: vec![NumberDataPoint {
                start_time_unix_nano: 1,
                time_unix_nano: 2,
                value: Some(number_data_point::Value::AsInt(7)),
                ..Default::default()
            }],
        })),
        ..Default::default()
    };
    let hist = Metric {
        name: "lat".into(),
        unit: "ms".into(),
        data: Some(metric::Data::Histogram(Histogram {
            aggregation_temporality: 2,
            data_points: vec![HistogramDataPoint {
                start_time_unix_nano: 1,
                time_unix_nano: 2,
                count: 3,
                sum: Some(42.5),
                min: Some(1.0),
                max: Some(30.0),
                bucket_counts: vec![1, 1, 1],
                explicit_bounds: vec![5.0, 20.0],
                ..Default::default()
            }],
        })),
        ..Default::default()
    };
    ExportMetricsServiceRequest {
        resource_metrics: vec![ResourceMetrics {
            resource: Some(Resource {
                attributes: vec![KeyValue {
                    key: "service.name".into(),
                    value: Some(AnyValue {
                        value: Some(any_value::Value::StringValue("equiv-m".into())),
                    }),
                }],
                ..Default::default()
            }),
            scope_metrics: vec![ScopeMetrics {
                metrics: vec![sum, hist],
                ..Default::default()
            }],
            ..Default::default()
        }],
    }
}

/// Capture the metrics fixture over the given transport and return the
/// `inspect --signal metrics` rows (already `to_number`-normalized, so int64
/// string vs number both land as the same JSON number), sorted by metric name.
async fn metric_rows_over(dir: &std::path::Path, transport: Transport) -> Vec<Value> {
    let rx = start(dir).await;
    match transport {
        Transport::HttpJson => {
            let resp = reqwest::Client::new()
                .post(format!("{}/v1/metrics", rx.http_endpoint))
                .header("content-type", "application/json")
                .body(METRICS_JSON)
                .send()
                .await
                .unwrap();
            assert_eq!(resp.status(), 200);
        }
        Transport::HttpProto => {
            let resp = reqwest::Client::new()
                .post(format!("{}/v1/metrics", rx.http_endpoint))
                .header("content-type", "application/x-protobuf")
                .body(metrics_fixture().encode_to_vec())
                .send()
                .await
                .unwrap();
            assert_eq!(resp.status(), 200);
        }
        Transport::Grpc => {
            let mut client = MetricsServiceClient::connect(rx.grpc_endpoint.clone())
                .await
                .unwrap();
            client.export(metrics_fixture()).await.unwrap();
        }
    }
    rx.shutdown().await;
    let raw = std::fs::read_to_string(dir.join("metrics.ndjson")).unwrap();
    let mut rows = otelite::inspect_metrics::rows(&raw).expect("flatten metric rows");
    rows.sort_by(|a, b| a["name"].as_str().unwrap().cmp(b["name"].as_str().unwrap()));
    rows
}

enum Transport {
    HttpJson,
    HttpProto,
    Grpc,
}

#[tokio::test]
async fn cross_transport_metrics_equivalence() {
    let json_dir = tempfile::tempdir().unwrap();
    let proto_dir = tempfile::tempdir().unwrap();
    let grpc_dir = tempfile::tempdir().unwrap();

    let json = metric_rows_over(json_dir.path(), Transport::HttpJson).await;
    let proto = metric_rows_over(proto_dir.path(), Transport::HttpProto).await;
    let grpc = metric_rows_over(grpc_dir.path(), Transport::Grpc).await;

    assert_eq!(
        json, proto,
        "HTTP-JSON and HTTP-protobuf must flatten to equivalent metric rows"
    );
    assert_eq!(
        proto, grpc,
        "HTTP-protobuf and gRPC must flatten to equivalent metric rows"
    );

    // Sanity: the rows carry both metrics faithfully (sum value + histogram), so
    // equivalence isn't satisfied by all three degrading identically.
    assert_eq!(json.len(), 2);
    let sum = json.iter().find(|r| r["name"] == "a").unwrap();
    assert_eq!(sum["value"], 7);
    let hist = json.iter().find(|r| r["name"] == "lat").unwrap();
    assert_eq!(hist["count"], 3);
    assert_eq!(hist["sum"], 42.5);
}
