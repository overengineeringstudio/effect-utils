//! Capture sink: per-signal NDJSON files plus running counts.
//!
//! Durability contract (decisions/0010, 0006): each export is written to the
//! sink *before* the receiver acks it, so a synchronous emitter that awaits its
//! ack — or any SDK that flushes on shutdown — is guaranteed its data is
//! captured by the time the child exits. `write_all` pushes the bytes to the
//! kernel (surviving a process crash); `sync_all` on shutdown adds power-loss
//! durability. We deliberately do NOT fsync per export under the lock (a review
//! spike measured ~600x latency inflation); the lock is held only across the
//! cheap `write_all`.
//!
//! Isolation contract (decisions/0010): files are opened with `create_new`
//! (O_EXCL), so two runs pointed at the same out-dir fail loudly instead of one
//! silently truncating the other's capture.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceRequest;
use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest;
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

/// Why a sink could not be created — surfaced so the CLI can map it to the
/// right sysexits code (a pre-existing capture file → 74, other IO → 73).
#[derive(Debug)]
pub enum SinkError {
    /// A capture file already exists in the out-dir (a second run collided).
    AlreadyExists(PathBuf),
    /// Any other IO failure creating the out-dir or files.
    Io(std::io::Error),
}

impl std::fmt::Display for SinkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SinkError::AlreadyExists(p) => write!(
                f,
                "capture file already exists: {} (another otelite run is using this --out dir; \
                 each concurrent run needs its own out-dir)",
                p.display()
            ),
            SinkError::Io(e) => write!(f, "{e}"),
        }
    }
}

/// One open NDJSON signal file guarded by a mutex.
struct SignalFile {
    path: PathBuf,
    file: Mutex<tokio::fs::File>,
}

impl SignalFile {
    async fn create(path: PathBuf) -> Result<Self, SinkError> {
        // O_EXCL: fail loudly rather than truncate a peer run's capture.
        let file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .await
            .map_err(|e| match e.kind() {
                std::io::ErrorKind::AlreadyExists => SinkError::AlreadyExists(path.clone()),
                _ => SinkError::Io(e),
            })?;
        Ok(SignalFile {
            path,
            file: Mutex::new(file),
        })
    }

    /// Append one canonical line, durably reaching the kernel before returning.
    async fn append_line<T: serde::Serialize>(&self, value: &T) -> std::io::Result<()> {
        let mut line = serde_json::to_vec(value).expect("OTLP message serializes");
        line.push(b'\n');
        let mut f = self.file.lock().await;
        f.write_all(&line).await
    }

    /// Append one pre-built `serde_json::Value` line. Used by the HTTP-JSON
    /// metrics path, which persists the validated incoming body verbatim
    /// (re-emitted as canonical JSON) instead of a lossy proto re-serialization.
    async fn append_json(&self, value: &serde_json::Value) -> std::io::Result<()> {
        let mut line = serde_json::to_vec(value).expect("JSON value serializes");
        line.push(b'\n');
        let mut f = self.file.lock().await;
        f.write_all(&line).await
    }

    async fn sync(&self) {
        let f = self.file.lock().await;
        let _ = f.sync_all().await;
    }
}

/// The shared capture sink. Cloned (via Arc) into both receivers.
pub struct Sink {
    traces: SignalFile,
    metrics: SignalFile,
    logs: SignalFile,
    span_count: AtomicU64,
    metric_count: AtomicU64,
    log_count: AtomicU64,
    /// Total export requests received (any signal). Drives `--drain-idle`:
    /// the caller watches this for "no new export for N ms".
    requests: AtomicU64,
    /// Exports rejected at decode (loud 400) — surfaced so a fire-and-forget
    /// emitter that discards the response doesn't make a rejection look like
    /// "no telemetry".
    rejected: AtomicU64,
}

/// Paths of the three capture files, surfaced in the run summary.
pub struct CapturePaths {
    pub traces: PathBuf,
    pub metrics: PathBuf,
    pub logs: PathBuf,
}

/// Running counts of captured signal records.
pub struct Counts {
    pub spans: u64,
    pub metrics: u64,
    pub logs: u64,
    pub rejected: u64,
}

impl Sink {
    pub async fn create(out_dir: &Path) -> Result<Self, SinkError> {
        tokio::fs::create_dir_all(out_dir)
            .await
            .map_err(SinkError::Io)?;
        Ok(Sink {
            traces: SignalFile::create(out_dir.join("traces.ndjson")).await?,
            metrics: SignalFile::create(out_dir.join("metrics.ndjson")).await?,
            logs: SignalFile::create(out_dir.join("logs.ndjson")).await?,
            span_count: AtomicU64::new(0),
            metric_count: AtomicU64::new(0),
            log_count: AtomicU64::new(0),
            requests: AtomicU64::new(0),
            rejected: AtomicU64::new(0),
        })
    }

    /// Record an export rejected at decode (a loud 400).
    pub fn note_rejected(&self) {
        self.rejected.fetch_add(1, Ordering::Relaxed);
    }

    /// Total export requests received so far (any signal). Monotonic; used by
    /// `--drain-idle` to detect quiescence after the child exits.
    pub fn requests_received(&self) -> u64 {
        self.requests.load(Ordering::Relaxed)
    }

    pub fn paths(&self) -> CapturePaths {
        CapturePaths {
            traces: self.traces.path.clone(),
            metrics: self.metrics.path.clone(),
            logs: self.logs.path.clone(),
        }
    }

    pub fn counts(&self) -> Counts {
        Counts {
            spans: self.span_count.load(Ordering::Relaxed),
            metrics: self.metric_count.load(Ordering::Relaxed),
            logs: self.log_count.load(Ordering::Relaxed),
            rejected: self.rejected.load(Ordering::Relaxed),
        }
    }

    /// Write a traces export durably before the caller acks it. Returns Err if
    /// the underlying write fails (the receiver then returns a server error
    /// rather than a false ack).
    pub async fn write_traces(&self, req: &ExportTraceServiceRequest) -> std::io::Result<()> {
        let n: u64 = req
            .resource_spans
            .iter()
            .flat_map(|rs| rs.scope_spans.iter())
            .map(|ss| ss.spans.len() as u64)
            .sum();
        self.traces.append_line(req).await?;
        self.span_count.fetch_add(n, Ordering::Relaxed);
        self.requests.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    pub async fn write_metrics(&self, req: &ExportMetricsServiceRequest) -> std::io::Result<()> {
        let n: u64 = req
            .resource_metrics
            .iter()
            .flat_map(|rm| rm.scope_metrics.iter())
            .map(|sm| sm.metrics.len() as u64)
            .sum();
        self.metrics.append_line(req).await?;
        self.metric_count.fetch_add(n, Ordering::Relaxed);
        self.requests.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    /// Write a metrics export from its already-validated OTLP/JSON body, persisted
    /// verbatim (canonical JSON) rather than via the lossy proto re-serialization.
    ///
    /// The `opentelemetry-proto` `with-serde` deserialize silently drops several
    /// JSON shapes (string-form `asInt`, regular `histogram`, `exponentialHistogram`),
    /// so re-serializing the proto type would lose them. The incoming body is
    /// already canonical OTLP/JSON in the accepted dialect (the caller validates
    /// it via the same deserialize before calling this), and `inspect` walks raw
    /// JSON — so persisting the body keeps the JSON metrics path lossless. The
    /// metric count is taken from the JSON structure for the same reason.
    pub async fn write_metrics_json(&self, body: &serde_json::Value) -> std::io::Result<()> {
        let n: u64 = body
            .get("resourceMetrics")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .flat_map(|rm| {
                rm.get("scopeMetrics")
                    .and_then(serde_json::Value::as_array)
                    .into_iter()
                    .flatten()
            })
            .map(|sm| {
                sm.get("metrics")
                    .and_then(serde_json::Value::as_array)
                    .map_or(0, |m| m.len() as u64)
            })
            .sum();
        self.metrics.append_json(body).await?;
        self.metric_count.fetch_add(n, Ordering::Relaxed);
        self.requests.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    pub async fn write_logs(&self, req: &ExportLogsServiceRequest) -> std::io::Result<()> {
        let n: u64 = req
            .resource_logs
            .iter()
            .flat_map(|rl| rl.scope_logs.iter())
            .map(|sl| sl.log_records.len() as u64)
            .sum();
        self.logs.append_line(req).await?;
        self.log_count.fetch_add(n, Ordering::Relaxed);
        self.requests.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    /// fsync all three files. Called once on shutdown for power-loss durability.
    pub async fn sync_all(&self) {
        self.traces.sync().await;
        self.metrics.sync().await;
        self.logs.sync().await;
    }
}
