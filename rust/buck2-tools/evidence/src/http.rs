//! Shared HTTP surface: upload (CAS PUT), record status, resolver `/t/<id>`, `/metrics`.
//! Candidates plug in only `on_stored` (how an accepted record reaches the worker).
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use axum::{Json, Router};
use serde_json::json;

use crate::store::{self, Manifest, UploadError, UploadOutcome};
use crate::{index, now_ms, Config};

pub type BoxFut<T> = Pin<Box<dyn Future<Output = T> + Send>>;
/// Called after the record is durable in the store; must make it reach a worker.
/// Errors here are logged, not returned: the sweep re-discovers stored records.
pub type OnStored = Arc<dyn Fn(String, Manifest, u64) -> BoxFut<Result<(), String>> + Send + Sync>;
pub type ExtraMetrics = Arc<dyn Fn() -> String + Send + Sync>;

#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<Config>,
    pub on_stored: OnStored,
    pub extra_metrics: ExtraMetrics,
    pub allow_local_upload: bool,
}

pub fn upload_router(state: AppState) -> Router {
    Router::new()
        .route("/v1/records/sha256/{digest}", put(upload))
        .route("/v1/attempt-close/sha256/{digest}", put(upload_close))
        .layer(DefaultBodyLimit::max(store::MAX_BODY))
        .with_state(state)
}

pub fn resolver_router(state: AppState) -> Router {
    Router::new()
        .route("/v1/records/{digest}", get(record))
        .route("/t/{trace_id}", get(resolve_trace))
        .route("/t/{trace_id}/chrome.json", get(chrome_trace))
        .route("/t/{trace_id}/perfetto", get(perfetto))
        .route("/healthz", get(|| async { "ok" }))
        .with_state(state.clone())
        .merge(crate::resolver::routes(state))
}

pub fn metrics_router(state: AppState) -> Router {
    Router::new().route("/metrics", get(metrics)).route("/healthz", get(|| async { "ok" })).with_state(state)
}

fn db_err(e: impl std::fmt::Display) -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response()
}

async fn upload(State(st): State<AppState>, headers: HeaderMap, Path(digest): Path<String>, body: Bytes) -> Response {
    if !st.allow_local_upload && !upload_capability(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let cfg = st.cfg.clone();
    let d = digest.clone();
    let known = tokio::task::spawn_blocking(move || {
        let conn = index::open(&cfg.index_path())?;
        index::status_of(&conn, &d)
    })
    .await
    .unwrap();
    match known {
        // Conditional create: identical bytes already accepted (spec: client treats 409 as done).
        Ok(Some(status)) => return (StatusCode::CONFLICT, Json(json!({"digest": digest, "status": status}))).into_response(),
        Ok(None) => {}
        Err(e) => return db_err(e),
    }
    let bytes = body.len() as u64;
    let cfg = st.cfg.clone();
    let d = digest.clone();
    let outcome = tokio::task::spawn_blocking(move || store::accept(&cfg, &d, &body)).await.unwrap();
    let manifest = match outcome {
        Ok(UploadOutcome::Stored(m)) => m,
        // Stored earlier but never indexed (crash between rename and enqueue): heal now.
        Ok(UploadOutcome::AlreadyStored) => match store::read_manifest(&store::record_dir(&st.cfg, &digest)) {
            Ok(m) => m,
            Err(e) => return db_err(e),
        },
        Err(UploadError::Rejected(m)) => return (StatusCode::BAD_REQUEST, m).into_response(),
        Err(UploadError::Io(m)) => return (StatusCode::INTERNAL_SERVER_ERROR, m).into_response(),
    };
    if let Err(e) = (st.on_stored)(digest.clone(), manifest, bytes).await {
        tracing::warn!(%digest, error = %e, "enqueue failed; sweep will pick it up");
    }
    (StatusCode::ACCEPTED, Json(json!({"digest": digest, "status": "uploaded"}))).into_response()
}

async fn upload_close(State(st): State<AppState>, headers: HeaderMap, Path(digest): Path<String>, body: Bytes) -> Response {
    if !st.allow_local_upload && !upload_capability(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let cfg = st.cfg.clone();
    let d = digest.clone();
    match tokio::task::spawn_blocking(move || -> anyhow::Result<bool> {
        let conn = index::open(&cfg.index_path())?;
        crate::close::accept(&conn, &d, &body)
    }).await {
        Ok(Ok(true)) => (StatusCode::ACCEPTED, Json(json!({"digest":digest,"status":"pending"}))).into_response(),
        Ok(Ok(false)) => (StatusCode::CONFLICT, Json(json!({"digest":digest,"status":"pending"}))).into_response(),
        Ok(Err(e)) => (StatusCode::BAD_REQUEST,e.to_string()).into_response(),
        Err(e) => db_err(e),
    }
}
/// Tailscale Serve forwards app capabilities, but does not enforce them.
/// Reject spoofed/absent/ambiguous capability objects at the upload boundary.
fn upload_capability(headers: &HeaderMap) -> bool {
    let Some(raw) = headers.get("tailscale-app-capabilities").and_then(|h| h.to_str().ok()) else { return false; };
    let Ok(doc) = serde_json::from_str::<serde_json::Value>(raw) else { return false; };
    let Some(entries) = doc.get("schickling.dev/cap/buck2-evidence-upload").and_then(|v| v.as_array()) else { return false; };
    if entries.len() != 1 { return false; }
    matches!(entries[0].get("role").and_then(|v| v.as_str()), Some("ci-runner" | "dev-host"))
}
async fn record(State(st): State<AppState>, Path(digest): Path<String>) -> Response {
    let cfg = st.cfg.clone();
    let r = tokio::task::spawn_blocking(move || {
        let conn = index::open(&cfg.index_path())?;
        index::record_json(&conn, &digest)
    })
    .await
    .unwrap();
    match r {
        Ok(Some(v)) => Json(v).into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => db_err(e),
    }
}

/// Resolver: stable link that redirects once ingested and says "pending" before.
async fn resolve_trace(State(st): State<AppState>, Path(trace_id): Path<String>) -> Response {
    if !valid_trace(&trace_id) { return error_trace(StatusCode::BAD_REQUEST, "invalid trace id"); }
    let cfg = st.cfg.clone();
    let id = trace_id.clone();
    let rows = tokio::task::spawn_blocking(move || {
        let conn = index::open(&cfg.index_path())?;
        index::trace_status(&conn, &id)
    })
    .await
    .unwrap();
    match rows {
        Err(e) => db_err(e),
        Ok(rows) if rows.is_empty() => (StatusCode::NOT_FOUND, Json(json!({"traceId": trace_id, "status": "unknown"}))).into_response(),
        Ok(rows) if rows.iter().any(|r| r.status == "ingested") => {
            let left = format!(r#"{{"datasource":"tempo","queries":[{{"refId":"A","queryType":"traceql","query":"{trace_id}"}}]}}"#);
            let url = format!("{}/explore?left={}", st.cfg.grafana.trim_end_matches('/'), urlencode(&left));
            (StatusCode::FOUND, [(header::LOCATION, url)]).into_response()
        }
        Ok(rows) => (StatusCode::ACCEPTED, Json(json!({"traceId": trace_id, "status": "pending", "records": rows}))).into_response(),
    }
}
fn valid_trace(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

async fn chrome_trace(State(st): State<AppState>, Path(trace_id): Path<String>) -> Response {
    if !valid_trace(&trace_id) { return error_trace(StatusCode::BAD_REQUEST, "invalid trace id"); }
    let cfg = st.cfg.clone();
    let id = trace_id.clone();
    let indexed = tokio::task::spawn_blocking(move || -> rusqlite::Result<bool> {
        let conn = index::open(&cfg.index_path())?;
        Ok(index::trace_status(&conn, &id)?.iter().any(|r| r.status == "ingested"))
    }).await;
    if !matches!(indexed, Ok(Ok(true))) { return error_trace(StatusCode::ACCEPTED, "trace pending"); }
    let url = format!("{}/api/v2/traces/{trace_id}", st.cfg.tempo.trim_end_matches('/'));
    let response = match reqwest::get(url).await { Ok(r) if r.status().is_success() => r, _ => return error_trace(StatusCode::GONE, "trace expired or Tempo unavailable") };
    let raw: serde_json::Value = match response.json().await { Ok(doc) => doc, Err(e) => return db_err(e) };
    let mut events = Vec::new();
    for rs in raw["trace"]["resourceSpans"].as_array().into_iter().flatten() {
        for ss in rs["scopeSpans"].as_array().into_iter().flatten() {
            for span in ss["spans"].as_array().into_iter().flatten() {
                let start = span["startTimeUnixNano"].as_str().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
                let end = span["endTimeUnixNano"].as_str().and_then(|s| s.parse::<u64>().ok()).unwrap_or(start);
                events.push(json!({"name":span["name"],"ph":"X","ts":start/1000,"dur":end.saturating_sub(start)/1000,
                    "pid":trace_id,"tid":span["parentSpanId"].as_str().unwrap_or("root"),"args":{"spanId":span["spanId"]}}));
            }
        }
    }
    Json(json!({"traceEvents":events})).into_response()
}

async fn perfetto(Path(trace_id): Path<String>) -> Response {
    if !valid_trace(&trace_id) { return error_trace(StatusCode::BAD_REQUEST, "invalid trace id"); }
    let id = html_escape(&trace_id);
    ([(header::CONTENT_TYPE,"text/html; charset=utf-8")],format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>Perfetto {id}</title></head><body><h1>Perfetto trace {id}</h1><p><a href=\"/t/{id}/chrome.json\" download=\"{id}.json\">Download Chrome trace</a> then open it at <a href=\"https://ui.perfetto.dev/\">Perfetto</a>.</p></body></html>"
    )).into_response()
}
fn error_trace(code: StatusCode, message: &str) -> Response { (code,message.to_owned()).into_response() }
fn html_escape(s: &str) -> String { s.replace('&',"&amp;").replace('<',"&lt;").replace('>',"&gt;") }

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

async fn metrics(State(st): State<AppState>) -> Response {
    let cfg = st.cfg.clone();
    let r = tokio::task::spawn_blocking(move || -> rusqlite::Result<String> {
        let conn = index::open(&cfg.index_path())?;
        let mut out = String::from("# TYPE evidence_records gauge\n");
        for (status, n) in index::status_counts(&conn)? {
            out += &format!("evidence_records{{status=\"{status}\"}} {n}\n");
        }
        out += &format!(
            "# TYPE evidence_oldest_pending_seconds gauge\nevidence_oldest_pending_seconds {:.3}\n",
            index::oldest_pending_age_ms(&conn, now_ms())? as f64 / 1000.0
        );
        let archive_bytes: i64 = conn.query_row("select coalesce(sum(bytes),0) from records where archive_path is not null", [], |r| r.get(0))?;
        let missing_spans: i64 = conn.query_row("select coalesce(sum(spans),0) from records where status='missing_spans'", [], |r| r.get(0))?;
        out += &format!("# TYPE evidence_archive_bytes gauge\nevidence_archive_bytes {archive_bytes}\n");
        out += "# TYPE evidence_archive_quota_bytes gauge\nevidence_archive_quota_bytes 161061273600\n";
        out += &format!("# TYPE evidence_missing_spans gauge\nevidence_missing_spans {missing_spans}\n");
        Ok(out)
    })
    .await
    .unwrap();
    match r {
        Ok(mut text) => {
            text += &(st.extra_metrics)();
            ([(header::CONTENT_TYPE, "text/plain; version=0.0.4")], text).into_response()
        }
        Err(e) => db_err(e),
    }
}

/// Serve on a unix socket (the Tailscale Service backend shape from tokenlens-upload).
pub async fn serve_unix(socket: &std::path::Path, app: Router) -> anyhow::Result<()> {
    let _ = std::fs::remove_file(socket);
    let listener = tokio::net::UnixListener::bind(socket)?;
    axum::serve(listener, app).await?;
    Ok(())
}
