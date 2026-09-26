//! The ingest steps. Each is idempotent on its own so any driver may replay it:
//!
//!   prepare  (verify, decode via the adapter, shape spool into the run trace, write chunks)
//!   push     (one OTLP chunk; deterministic ids, but Tempo does NOT dedup re-pushes: see
//!             experiment.md, so drivers checkpoint pushed chunks)
//!   readback (trace-by-id until every pushed span id is visible)
//!   finalize (archive rename + index flip to `ingested`)
//!
//! Only small summaries cross step boundaries; the chunks stay on disk under work/<digest>/.
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::index::{self, TraceRow};
use crate::store::{self, Manifest};
use crate::{ids, now_ms, permanent, transient, Config, StepError, StepResult};

const CHUNK_LIMIT: usize = 3 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
pub struct Plan {
    pub manifest: Manifest,
    pub traces: Vec<PlanTrace>,
    pub chunks: Vec<String>,
}

#[derive(Serialize, Deserialize)]
pub struct PlanTrace {
    pub trace_id: String,
    pub view: String,
    pub span_ids: Vec<String>,
}

/// What a journal (Restate) or a queue row may carry: never the multi-MB payload.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PlanSummary {
    pub chunks: usize,
    pub spans: usize,
    pub traces: Vec<TraceRow>,
}

impl Plan {
    pub fn summary(&self) -> PlanSummary {
        PlanSummary {
            chunks: self.chunks.len(),
            spans: self.traces.iter().map(|t| t.span_ids.len()).sum(),
            traces: self
                .traces
                .iter()
                .map(|t| TraceRow { trace_id: t.trace_id.clone(), view: t.view.clone(), spans: t.span_ids.len() })
                .collect(),
        }
    }
}

fn work_dir(cfg: &Config, digest: &str) -> PathBuf {
    cfg.work().join(digest)
}

pub fn load_plan(cfg: &Config, digest: &str) -> StepResult<Option<Plan>> {
    match std::fs::read(work_dir(cfg, digest).join("plan.json")) {
        Ok(b) => Ok(Some(serde_json::from_slice(&b).map_err(transient)?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(transient(e)),
    }
}

/// Decode + shape into chunk files. Re-running after success is a cheap no-op.
pub async fn prepare(cfg: &Config, digest: &str) -> StepResult<PlanSummary> {
    if let Some(plan) = load_plan(cfg, digest)? {
        return Ok(plan.summary());
    }
    let dir = store::record_dir(cfg, digest);
    if !dir.exists() {
        return Err(permanent(format!("record {digest} not in store")));
    }
    let manifest = store::read_manifest(&dir)?;
    let tmp = cfg.work().join(format!("{digest}.tmp"));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(tmp.join("chunks")).map_err(transient)?;
    std::fs::create_dir_all(tmp.join("adapter")).map_err(transient)?;

    let mut traces: HashMap<(String, String), Vec<String>> = HashMap::new();
    let mut chunks = Vec::new();
    let mut write_chunk = |body: &[u8]| -> StepResult<()> {
        let name = format!("{:04}.json", chunks.len());
        std::fs::write(tmp.join("chunks").join(&name), body).map_err(transient)?;
        chunks.push(name);
        Ok(())
    };

    // 1. CI span spool -> run trace (pluggable shaper: TraceparentBakeoff may replace this).
    for body in shape_spool(&dir, &manifest, &mut traces)? {
        write_chunk(&body)?;
    }

    // Decode native evidence in this process. Each command carries its own
    // sidecar; the adapter accepts their concatenation without rewriting logs.
    let logs: Vec<PathBuf> = manifest.files.iter()
        .filter(|f| f.path.starts_with("buck2/") && f.path.ends_with(".pb.zst"))
        .map(|f| dir.join(&f.path)).collect();
    if !logs.is_empty() {
        let sidecar = tmp.join("sidecar");
        let mut sidecars = String::new();
        for f in manifest.files.iter().filter(|f| f.path.starts_with("buck2/") && f.path.ends_with(".sidecar")) {
            sidecars.push_str(&std::fs::read_to_string(dir.join(&f.path)).map_err(permanent)?);
        }
        std::fs::write(&sidecar, &sidecars).map_err(transient)?;
        let callers: HashSet<String> = sidecars.lines()
            .filter_map(|line| line.split_once(' ').map(|(uuid, _)| uuid.to_owned()))
            .collect();
        let out = tmp.join("adapter");
        buck2_events::ingest_to(logs, Some(sidecar), out.clone())
            .map_err(|e| permanent(format!("Buck event adapter: {e}")))?;
        let mut files: Vec<_> = std::fs::read_dir(tmp.join("adapter"))
            .map_err(transient)?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .collect();
        files.sort();
        for path in files {
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            let view = if name.contains("-full-") { "full" } else { "critical" };
            let mut doc: Value = serde_json::from_slice(&std::fs::read(&path).map_err(transient)?).map_err(permanent)?;
            for rs in doc["resourceSpans"].as_array_mut().into_iter().flatten() {
                let uuid = rs["resource"]["attributes"]
                    .as_array()
                    .and_then(|a| a.iter().find(|kv| kv["key"] == "buck2.build_id"))
                    .and_then(|kv| kv["value"]["stringValue"].as_str())
                    .unwrap_or_default()
                    .to_string();
                // Critical view with a caller context lives in the caller's (run) trace; every
                // other view gets the 05 spec id f(repo, run, attempt, job, uuid, view).
                let rewrite = view == "full" || !callers.contains(&uuid);
                let new_id = ids::view_trace(&uuid, view);
                for ss in rs["scopeSpans"].as_array_mut().into_iter().flatten() {
                    for span in ss["spans"].as_array_mut().into_iter().flatten() {
                        if rewrite {
                            span["traceId"] = Value::String(new_id.clone());
                        }
                        let tid = span["traceId"].as_str().unwrap_or_default().to_string();
                        let sid = span["spanId"].as_str().unwrap_or_default().to_string();
                        traces.entry((tid, view.to_string())).or_default().push(sid);
                    }
                }
            }
            write_chunk(&serde_json::to_vec(&doc).map_err(transient)?)?;
        }
        let _ = std::fs::remove_dir_all(tmp.join("adapter"));
    }

    let mut plan_traces: Vec<PlanTrace> = traces
        .into_iter()
        .map(|((trace_id, view), span_ids)| PlanTrace { trace_id, view, span_ids })
        .collect();
    plan_traces.sort_by(|a, b| (&a.view, &a.trace_id).cmp(&(&b.view, &b.trace_id)));
    let plan = Plan { manifest, traces: plan_traces, chunks };
    std::fs::write(tmp.join("plan.json"), serde_json::to_vec(&plan).map_err(transient)?).map_err(transient)?;
    let dest = work_dir(cfg, digest);
    let _ = std::fs::remove_dir_all(&dest);
    std::fs::rename(&tmp, &dest).map_err(transient)?;
    Ok(plan.summary())
}

fn str_attr(key: &str, v: &str) -> Value {
    json!({"key": key, "value": {"stringValue": v}})
}

/// Preserve the entrypoint's seeded parentage. Sealing/ingest cannot mint a
/// competing run or job span; the CI close record writes the single root.
fn shape_spool(dir: &Path, manifest: &Manifest, traces: &mut HashMap<(String, String), Vec<String>>) -> StepResult<Vec<Vec<u8>>> {
    let m = &manifest.run;
    let run_trace = ids::run_trace(&m.pipeline_run_id);
    let mut resource_spans: Vec<Value> = Vec::new();
    for f in manifest.files.iter().filter(|f| f.path.starts_with("spans/")) {
        let text = std::fs::read_to_string(dir.join(&f.path)).map_err(transient)?;
        for line in text.lines().filter(|l| !l.trim().is_empty()) {
            let doc: Value = serde_json::from_str(line).map_err(|e| permanent(format!("{}: {e}", f.path)))?;
            resource_spans.extend(doc["resourceSpans"].as_array().cloned().unwrap_or_default());
        }
    }
    if resource_spans.is_empty() {
        return Ok(Vec::new());
    }
    let ids_entry = traces.entry((run_trace.clone(), "critical".into())).or_default();
    for rs in resource_spans.iter_mut() {
        if let Some(attrs) = rs["resource"]["attributes"].as_array_mut() {
            attrs.push(str_attr("cicd.pipeline.run.id", &m.pipeline_run_id));
            attrs.push(str_attr("cicd.pipeline.run.attempt", &m.attempt.to_string()));
            attrs.push(str_attr("cicd.pipeline.task.name", &m.job_key));
            attrs.push(str_attr("vcs.repository.name", &m.repository));
            if let Some(head) = &manifest.vcs_head { attrs.push(str_attr("vcs.ref.head.revision", head)); }
            if let Some(base) = &manifest.vcs_base { attrs.push(str_attr("vcs.ref.base.revision", base)); }
            if let Some(change) = &manifest.vcs_change_id { attrs.push(str_attr("vcs.change.id", change)); }
            if let Some(merge) = &manifest.vcs_merge { attrs.push(str_attr("buck2.vcs.merge.revision", merge)); }
        }
        for ss in rs["scopeSpans"].as_array_mut().into_iter().flatten() {
            for span in ss["spans"].as_array_mut().into_iter().flatten() {
                if span["traceId"] != run_trace { return Err(permanent("span trace differs from seeded pipeline trace")); }
                ids_entry.push(span["spanId"].as_str().unwrap_or_default().to_string());
            }
        }
    }
    // Chunk below the gateway's body limit.
    let mut out = Vec::new();
    let mut batch: Vec<Value> = Vec::new();
    let mut size = 0;
    for rs in resource_spans {
        let n = serde_json::to_vec(&rs).map_err(transient)?.len();
        if size + n > CHUNK_LIMIT && !batch.is_empty() {
            out.push(serde_json::to_vec(&json!({"resourceSpans": std::mem::take(&mut batch)})).map_err(transient)?);
            size = 0;
        }
        size += n;
        batch.push(rs);
    }
    if !batch.is_empty() {
        out.push(serde_json::to_vec(&json!({"resourceSpans": batch})).map_err(transient)?);
    }
    Ok(out)
}

pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .connect_timeout(Duration::from_secs(2))
        .build()
        .expect("reqwest client")
}

/// Pushes chunk `i` of the plan. Driver checkpoints after Ok.
pub async fn push_chunk(client: &reqwest::Client, cfg: &Config, digest: &str, i: usize) -> StepResult<()> {
    let path = work_dir(cfg, digest).join("chunks").join(format!("{i:04}.json"));
    let body = tokio::fs::read(&path).await.map_err(transient)?;
    let url = format!("{}/v1/traces", cfg.otlp.trim_end_matches('/'));
    let resp = client
        .post(url)
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| transient(format!("otlp push: {e}")))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if status.is_success() {
        if text.contains("rejectedSpans") && !text.contains("\"rejectedSpans\":0") && !text.contains("\"rejectedSpans\":\"0\"") {
            return Err(transient(format!("otlp partial rejection: {text}")));
        }
        Ok(())
    } else if status.as_u16() == 429 || status.is_server_error() {
        Err(transient(format!("otlp {status}: {text}")))
    } else {
        Err(permanent(format!("otlp {status}: {text}")))
    }
}

#[derive(Deserialize)]
struct TempoResp {
    #[serde(default)]
    trace: Option<TempoTrace>,
}
#[derive(Deserialize)]
struct TempoTrace {
    #[serde(default, rename = "resourceSpans")]
    resource_spans: Vec<TempoRs>,
}
#[derive(Deserialize)]
struct TempoRs {
    #[serde(default, rename = "scopeSpans")]
    scope_spans: Vec<TempoSs>,
}
#[derive(Deserialize)]
struct TempoSs {
    #[serde(default)]
    spans: Vec<TempoSpan>,
}
#[derive(Deserialize)]
struct TempoSpan {
    #[serde(rename = "spanId")]
    span_id: String,
}

/// Span ids present in Tempo for `trace_id`, with multiplicity (Tempo 3 returns re-pushed
/// duplicates from the live store).
pub async fn tempo_span_counts(client: &reqwest::Client, tempo: &str, trace_id: &str) -> StepResult<HashMap<String, usize>> {
    let url = format!("{}/api/v2/traces/{trace_id}", tempo.trim_end_matches('/'));
    let resp = client.get(url).send().await.map_err(|e| transient(format!("tempo: {e}")))?;
    if resp.status().as_u16() == 404 {
        return Ok(HashMap::new());
    }
    if !resp.status().is_success() {
        return Err(transient(format!("tempo {}", resp.status())));
    }
    let body = resp.bytes().await.map_err(transient)?;
    let parsed: TempoResp = serde_json::from_slice(&body).map_err(transient)?;
    let mut counts = HashMap::new();
    for rs in parsed.trace.map(|t| t.resource_spans).unwrap_or_default() {
        for ss in rs.scope_spans {
            for s in ss.spans {
                let hex = match base64::engine::general_purpose::STANDARD.decode(&s.span_id) {
                    Ok(b) if b.len() == 8 => hex::encode(b),
                    _ => s.span_id,
                };
                *counts.entry(hex).or_insert(0) += 1;
            }
        }
    }
    Ok(counts)
}

/// Retry guard: Tempo 3 does not dedup a re-push that lands within ~5 s of the first push
/// (measured, results/tempo-dedup-probe.jsonl), so a retried chunk is probed by id first.
pub async fn chunk_visible(client: &reqwest::Client, cfg: &Config, digest: &str, i: usize) -> StepResult<bool> {
    let path = work_dir(cfg, digest).join("chunks").join(format!("{i:04}.json"));
    let doc: Value = serde_json::from_slice(&tokio::fs::read(&path).await.map_err(transient)?).map_err(transient)?;
    let mut by_trace: HashMap<String, Vec<String>> = HashMap::new();
    for rs in doc["resourceSpans"].as_array().into_iter().flatten() {
        for ss in rs["scopeSpans"].as_array().into_iter().flatten() {
            for s in ss["spans"].as_array().into_iter().flatten() {
                by_trace
                    .entry(s["traceId"].as_str().unwrap_or_default().to_string())
                    .or_default()
                    .push(s["spanId"].as_str().unwrap_or_default().to_string());
            }
        }
    }
    for (trace, span_ids) in by_trace {
        let counts = tempo_span_counts(client, &cfg.tempo, &trace).await?;
        if span_ids.iter().any(|id| !counts.contains_key(id)) {
            return Ok(false);
        }
    }
    Ok(true)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Readback {
    pub spans: usize,
    pub dup_spans: usize,
    pub waited_ms: u64,
}

/// Polls trace-by-id until every planned span id is visible (the index may only flip after this).
pub async fn readback(client: &reqwest::Client, cfg: &Config, digest: &str) -> StepResult<Readback> {
    let plan = load_plan(cfg, digest)?.ok_or_else(|| transient("plan missing; re-prepare"))?;
    let started = Instant::now();
    let deadline = started + cfg.readback_timeout;
    let mut pending: Vec<&PlanTrace> = plan.traces.iter().collect();
    let (mut spans, mut dups) = (0, 0);
    let mut delay = Duration::from_millis(50);
    loop {
        let mut still = Vec::new();
        for t in pending {
            let counts = tempo_span_counts(client, &cfg.tempo, &t.trace_id).await?;
            let missing = t.span_ids.iter().filter(|id| !counts.contains_key(*id)).count();
            if missing == 0 {
                spans += t.span_ids.len();
                dups += t.span_ids.iter().map(|id| counts[id].saturating_sub(1)).sum::<usize>();
            } else {
                still.push(t);
            }
        }
        if still.is_empty() {
            return Ok(Readback { spans, dup_spans: dups, waited_ms: started.elapsed().as_millis() as u64 });
        }
        if Instant::now() >= deadline {
            return Err(transient(format!("readback incomplete: {} traces missing spans", still.len())));
        }
        pending = still;
        tokio::time::sleep(delay).await;
        delay = (delay * 2).min(Duration::from_millis(500));
    }
}

/// Archive + index flip. Idempotent: replay after a crash converges to the same row.
pub fn finalize(cfg: &Config, digest: &str, rb: &Readback) -> StepResult<String> {
    let plan = load_plan(cfg, digest)?;
    let mut conn = index::open(&cfg.index_path()).map_err(transient)?;
    let uploaded_at: i64 = conn
        .query_row("select uploaded_at from records where digest=?1", [digest], |r| r.get(0))
        .map_err(transient)?;
    let Some(plan) = plan else {
        // Already finalized by an earlier attempt (plan removed last).
        return match index::status_of(&conn, digest).map_err(transient)?.as_deref() {
            Some("ingested") => Ok(String::new()),
            _ => Err(transient("plan missing before finalize")),
        };
    };
    let path = store::archive(cfg, digest, &plan.manifest, uploaded_at)?;
    let summary = plan.summary();
    index::mark_ingested(&mut conn, digest, &summary.traces, &path.to_string_lossy(), rb.spans, rb.dup_spans, now_ms())
        .map_err(transient)?;
    let _ = std::fs::remove_dir_all(work_dir(cfg, digest));
    Ok(path.to_string_lossy().into_owned())
}

pub fn is_permanent(e: &StepError) -> bool {
    matches!(e, StepError::Permanent(_))
}
