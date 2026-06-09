//! M5 — cross-transport equivalence, the central correctness invariant
//! (spec.md Testing): the same logical span emitted via OTLP/HTTP-JSON,
//! OTLP/HTTP-protobuf, and OTLP/gRPC must produce a byte-identical canonical
//! capture after normalization. One regression in any decode path or in the
//! serializer fails this gate.

use std::sync::Arc;

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
