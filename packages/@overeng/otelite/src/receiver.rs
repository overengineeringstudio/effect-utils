//! The OTLP receiver: OTLP/HTTP (json + protobuf) via axum and OTLP/gRPC via
//! tonic, on one tokio runtime, sharing one [`Sink`].
//!
//! - Ephemeral `:0` ports, read back via `local_addr()` (decisions/0010): the
//!   resolved ports are reported, never guessed — clean parallel isolation.
//! - gRPC uses a pre-bound `TcpIncoming` (no bind→drop→rebind TOCTOU).
//! - Non-default / undecodable payloads are rejected **loudly** (HTTP 400 /
//!   gRPC error), never silently dropped (decisions/0011).
//! - Shutdown drains in-flight requests (graceful) then fsyncs the sink.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use prost::Message;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use opentelemetry_proto::tonic::collector::logs::v1::{
    logs_service_server::{LogsService, LogsServiceServer},
    ExportLogsServiceRequest, ExportLogsServiceResponse,
};
use opentelemetry_proto::tonic::collector::metrics::v1::{
    metrics_service_server::{MetricsService, MetricsServiceServer},
    ExportMetricsServiceRequest, ExportMetricsServiceResponse,
};
use opentelemetry_proto::tonic::collector::trace::v1::{
    trace_service_server::{TraceService, TraceServiceServer},
    ExportTraceServiceRequest, ExportTraceServiceResponse,
};

use crate::sink::{Counts, Sink};

/// Max accepted OTLP payload per request. Real batches can exceed axum's 2 MiB
/// and tonic's 4 MiB defaults; a capture tool must not 413/abort a legitimate
/// batch. Generous but bounded (vs. unbounded) to avoid OOM from a runaway body.
const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;

/// A running receiver: both servers bound and serving, the child not yet spawned.
pub struct RunningReceiver {
    pub http_endpoint: String,
    pub grpc_endpoint: String,
    sink: Arc<Sink>,
    http_shutdown: oneshot::Sender<()>,
    grpc_shutdown: oneshot::Sender<()>,
    http_task: JoinHandle<()>,
    grpc_task: JoinHandle<()>,
}

impl RunningReceiver {
    /// Bind ephemeral HTTP + gRPC ports on `127.0.0.1` and start serving.
    pub async fn start(sink: Arc<Sink>) -> std::io::Result<RunningReceiver> {
        Self::start_on(sink, None, None).await
    }

    /// Like [`start`], but binds the given fixed ports when provided (`None` →
    /// ephemeral `:0`). Returns once both listeners are bound (so a child
    /// started next is guaranteed a live endpoint — no readiness race).
    pub async fn start_on(
        sink: Arc<Sink>,
        http_port: Option<u16>,
        grpc_port: Option<u16>,
    ) -> std::io::Result<RunningReceiver> {
        // HTTP listener (axum serves directly from a tokio TcpListener).
        let http_listener =
            tokio::net::TcpListener::bind(("127.0.0.1", http_port.unwrap_or(0))).await?;
        let http_addr = http_listener.local_addr()?;

        // gRPC listener: bind a tokio TcpListener and hand it to tonic as a
        // pre-bound incoming — no drop/rebind window.
        let grpc_listener =
            tokio::net::TcpListener::bind(("127.0.0.1", grpc_port.unwrap_or(0))).await?;
        let grpc_addr: SocketAddr = grpc_listener.local_addr()?;
        let grpc_incoming =
            tonic::transport::server::TcpIncoming::from_listener(grpc_listener, true, None)
                .map_err(|e| std::io::Error::other(e.to_string()))?;

        let http_endpoint = format!("http://{http_addr}");
        let grpc_endpoint = format!("http://{grpc_addr}");

        // HTTP server (axum).
        let app = Router::new()
            .route("/v1/traces", post(http_traces))
            .route("/v1/metrics", post(http_metrics))
            .route("/v1/logs", post(http_logs))
            .layer(axum::extract::DefaultBodyLimit::max(MAX_BODY_BYTES))
            .with_state(sink.clone());
        let (http_shutdown, http_rx) = oneshot::channel::<()>();
        let http_task = tokio::spawn(async move {
            axum::serve(http_listener, app)
                .with_graceful_shutdown(async {
                    let _ = http_rx.await;
                })
                .await
                .ok();
        });

        // gRPC server (tonic) — three services over the same sink.
        let svc = GrpcSvc { sink: sink.clone() };
        let (grpc_shutdown, grpc_rx) = oneshot::channel::<()>();
        let grpc_task = tokio::spawn(async move {
            tonic::transport::Server::builder()
                .add_service(
                    TraceServiceServer::new(svc.clone()).max_decoding_message_size(MAX_BODY_BYTES),
                )
                .add_service(
                    MetricsServiceServer::new(svc.clone())
                        .max_decoding_message_size(MAX_BODY_BYTES),
                )
                .add_service(
                    LogsServiceServer::new(svc.clone()).max_decoding_message_size(MAX_BODY_BYTES),
                )
                .serve_with_incoming_shutdown(grpc_incoming, async {
                    let _ = grpc_rx.await;
                })
                .await
                .ok();
        });

        Ok(RunningReceiver {
            http_endpoint,
            grpc_endpoint,
            sink,
            http_shutdown,
            grpc_shutdown,
            http_task,
            grpc_task,
        })
    }

    pub fn sink(&self) -> &Arc<Sink> {
        &self.sink
    }

    /// Signal both servers, await in-flight requests to drain, fsync the sink,
    /// and return the final counts.
    pub async fn shutdown(self) -> Counts {
        let _ = self.http_shutdown.send(());
        let _ = self.grpc_shutdown.send(());
        let _ = self.http_task.await;
        let _ = self.grpc_task.await;
        self.sink.sync_all().await;
        self.sink.counts()
    }
}

// ---- gRPC service impls ---------------------------------------------------

#[derive(Clone)]
struct GrpcSvc {
    sink: Arc<Sink>,
}

#[tonic::async_trait]
impl TraceService for GrpcSvc {
    async fn export(
        &self,
        request: tonic::Request<ExportTraceServiceRequest>,
    ) -> Result<tonic::Response<ExportTraceServiceResponse>, tonic::Status> {
        self.sink
            .write_traces(request.get_ref())
            .await
            .map_err(|e| tonic::Status::internal(format!("capture write failed: {e}")))?;
        Ok(tonic::Response::new(ExportTraceServiceResponse::default()))
    }
}

#[tonic::async_trait]
impl MetricsService for GrpcSvc {
    async fn export(
        &self,
        request: tonic::Request<ExportMetricsServiceRequest>,
    ) -> Result<tonic::Response<ExportMetricsServiceResponse>, tonic::Status> {
        self.sink
            .write_metrics(request.get_ref())
            .await
            .map_err(|e| tonic::Status::internal(format!("capture write failed: {e}")))?;
        Ok(tonic::Response::new(ExportMetricsServiceResponse::default()))
    }
}

#[tonic::async_trait]
impl LogsService for GrpcSvc {
    async fn export(
        &self,
        request: tonic::Request<ExportLogsServiceRequest>,
    ) -> Result<tonic::Response<ExportLogsServiceResponse>, tonic::Status> {
        self.sink
            .write_logs(request.get_ref())
            .await
            .map_err(|e| tonic::Status::internal(format!("capture write failed: {e}")))?;
        Ok(tonic::Response::new(ExportLogsServiceResponse::default()))
    }
}

// ---- HTTP handlers --------------------------------------------------------

fn is_protobuf(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.contains("protobuf"))
        .unwrap_or(false)
}

/// OTLP/HTTP success: an empty `Export*ServiceResponse` in the request's encoding.
fn ok_response(proto: bool, proto_body: Vec<u8>) -> Response {
    if proto {
        (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/x-protobuf")],
            proto_body,
        )
            .into_response()
    } else {
        (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/json")],
            b"{}".to_vec(),
        )
            .into_response()
    }
}

fn decode<T>(proto: bool, body: &[u8]) -> Result<T, String>
where
    T: Message + Default + serde::de::DeserializeOwned,
{
    if proto {
        T::decode(body).map_err(|e| format!("protobuf decode: {e}"))
    } else {
        // Only the default OTel-SDK JSON dialect (hex IDs, string int64, integer
        // enums) decodes here; other encodings are rejected loudly below.
        serde_json::from_slice(body).map_err(|e| format!("json decode: {e}"))
    }
}

/// Test-only fault injection point (set `OTELITE_TEST_PANIC=before-write` to
/// prove that the write genuinely gates the ack). No-op in normal operation.
fn maybe_test_panic() {
    if std::env::var("OTELITE_TEST_PANIC").as_deref() == Ok("before-write") {
        std::process::abort();
    }
}

async fn http_traces(State(sink): State<Arc<Sink>>, headers: HeaderMap, body: Bytes) -> Response {
    let proto = is_protobuf(&headers);
    let req: ExportTraceServiceRequest = match decode(proto, &body) {
        Ok(r) => r,
        Err(e) => {
            sink.note_rejected();
            return (StatusCode::BAD_REQUEST, e).into_response();
        }
    };
    maybe_test_panic();
    if let Err(e) = sink.write_traces(&req).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("capture write failed: {e}"),
        )
            .into_response();
    }
    ok_response(proto, ExportTraceServiceResponse::default().encode_to_vec())
}

async fn http_metrics(State(sink): State<Arc<Sink>>, headers: HeaderMap, body: Bytes) -> Response {
    let proto = is_protobuf(&headers);
    let req: ExportMetricsServiceRequest = match decode(proto, &body) {
        Ok(r) => r,
        Err(e) => {
            sink.note_rejected();
            return (StatusCode::BAD_REQUEST, e).into_response();
        }
    };
    maybe_test_panic();
    if let Err(e) = sink.write_metrics(&req).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("capture write failed: {e}"),
        )
            .into_response();
    }
    ok_response(
        proto,
        ExportMetricsServiceResponse::default().encode_to_vec(),
    )
}

async fn http_logs(State(sink): State<Arc<Sink>>, headers: HeaderMap, body: Bytes) -> Response {
    let proto = is_protobuf(&headers);
    let req: ExportLogsServiceRequest = match decode(proto, &body) {
        Ok(r) => r,
        Err(e) => {
            sink.note_rejected();
            return (StatusCode::BAD_REQUEST, e).into_response();
        }
    };
    maybe_test_panic();
    if let Err(e) = sink.write_logs(&req).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("capture write failed: {e}"),
        )
            .into_response();
    }
    ok_response(proto, ExportLogsServiceResponse::default().encode_to_vec())
}
