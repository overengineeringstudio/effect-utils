//! A separately sealed CI roster closes a run; local runs already contain their root.
use std::{fs, io::Read, path::Path};
use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use crate::{ids, now_ms, Config};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ExpectedJob { pub key: String, pub conclusion: String }
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseRecord {
    pub schema: String,
    pub pipeline_run_id: String,
    pub repository: String,
    pub sealed_at: String,
    pub expected_jobs: Vec<ExpectedJob>,
}

fn validate(record: &CloseRecord) -> Result<()> {
    if record.schema != "buck2-attempt-close/v1" || !record.pipeline_run_id.starts_with("ci/")
        || record.repository.split('/').count() != 2 { bail!("invalid CI close identity"); }
    if record.expected_jobs.iter().any(|j| j.key.is_empty() || !matches!(j.conclusion.as_str(), "success" | "failure" | "cancelled" | "skipped"))
        || record.expected_jobs.windows(2).any(|pair| pair[0].key == pair[1].key) { bail!("invalid or duplicate expected job"); }
    Ok(())
}

pub fn seal_close(spool: &Path, run: &str, repository: &str, jobs_json: &Path) -> Result<String> {
    let mut jobs: Vec<ExpectedJob> = serde_json::from_slice(&fs::read(jobs_json)?)?;
    jobs.sort_by(|a, b| a.key.cmp(&b.key));
    let output = std::process::Command::new("date").args(["-u", "+%Y-%m-%dT%H:%M:%SZ"]).output()?;
    if !output.status.success() { bail!("UTC clock unavailable"); }
    let record = CloseRecord { schema: "buck2-attempt-close/v1".into(), pipeline_run_id:run.into(), repository:repository.into(),
        sealed_at: String::from_utf8(output.stdout)?.trim().into(), expected_jobs:jobs };
    validate(&record)?;
    fs::create_dir_all(spool)?;
    let target = spool.join("manifest.json");
    if target.exists() {
        let previous = fs::read(&target)?;
        let old: CloseRecord = serde_json::from_slice(&previous)?;
        if old.pipeline_run_id != run || old.repository != repository
            || old.expected_jobs.iter().map(|j| (&j.key,&j.conclusion)).ne(record.expected_jobs.iter().map(|j| (&j.key,&j.conclusion))) { bail!("conflicting sealed close roster"); }
        return Ok(hex::encode(Sha256::digest(previous)));
    }
    let bytes = serde_json::to_vec(&record)?;
    let digest = hex::encode(Sha256::digest(&bytes));
    fs::write(spool.join("manifest.json.tmp"), bytes)?;
    fs::rename(spool.join("manifest.json.tmp"), target)?;
    Ok(digest)
}

pub fn init(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("create table if not exists closes (digest text primary key, run_id text not null unique, repo text not null, manifest_json text not null, received_at integer not null, root_pushed integer not null default 0, error text);")
}

/// Only one manifest file is accepted, with no additional tar members or padding data.
pub fn accept(conn: &Connection, digest: &str, body: &[u8]) -> Result<bool> {
    if !crate::store::is_digest(digest) || body.len() > 1024 * 1024 { bail!("invalid close digest or size"); }
    let mut archive = tar::Archive::new(body);
    let mut entries = archive.entries()?;
    let mut entry = entries.next().context("missing close manifest")??;
    if entry.path()?.as_ref() != Path::new("manifest.json") || !entry.header().entry_type().is_file() { bail!("invalid close archive"); }
    let mut bytes = Vec::new();
    entry.read_to_end(&mut bytes)?;
    drop(entry);
    if entries.next().is_some() || hex::encode(Sha256::digest(&bytes)) != digest { bail!("close digest mismatch or unexpected file"); }
    let record: CloseRecord = serde_json::from_slice(&bytes)?;
    validate(&record)?;
    let existing: Option<String> = conn.query_row("select digest from closes where run_id=?1", [&record.pipeline_run_id], |r| r.get(0)).optional()?;
    if existing.as_deref().is_some_and(|d| d != digest) { bail!("conflicting close for run"); }
    Ok(conn.execute("insert into closes (digest,run_id,repo,manifest_json,received_at) values (?1,?2,?3,?4,?5) on conflict do nothing",
        params![digest,record.pipeline_run_id,record.repository,String::from_utf8(bytes)?,now_ms()])? != 0)
}
use rusqlite::OptionalExtension;

fn root_body(close: &CloseRecord, jobs: &[(String, String, Option<i64>, Option<i64>)], received: i64) -> Value {
    let trace = ids::run_trace(&close.pipeline_run_id);
    let mut spans = Vec::new();
    let started = jobs.iter().filter_map(|(_,_,s,_)| *s).min().unwrap_or(received);
    let ended = jobs.iter().filter_map(|(_,_,_,e)| *e).max().unwrap_or(now_ms()).max(started + 1);
    let missing: Vec<_> = close.expected_jobs.iter().filter(|j| !jobs.iter().any(|(k,_,_,_)| k == &j.key)).collect();
    for (i, job) in missing.iter().enumerate() {
        let span_id = ids::job_span(&close.pipeline_run_id, &job.key);
        spans.push(json!({"traceId":trace,"spanId":span_id,"parentSpanId":ids::run_root_span(&close.pipeline_run_id),
            "name":format!("{} (missing)",job.key),"startTimeUnixNano": (started as i128 * 1_000_000).to_string(),
            "endTimeUnixNano": (ended as i128 * 1_000_000).to_string(),"attributes":[{"key":"evidence.missing","value":{"boolValue":true}},
                {"key":"cicd.pipeline.task.result","value":{"stringValue":job.conclusion}}],"status":{"code":2,"message":format!("missing job {}",i)}}));
    }
    spans.push(json!({"traceId":trace,"spanId":ids::run_root_span(&close.pipeline_run_id),"name":"CI pipeline run",
        "startTimeUnixNano": (started as i128 * 1_000_000).to_string(),"endTimeUnixNano": (ended as i128 * 1_000_000).to_string(),
        "attributes":[{"key":"cicd.pipeline.run.id","value":{"stringValue":close.pipeline_run_id}},
            {"key":"vcs.repository.name","value":{"stringValue":close.repository}},
            {"key":"evidence.missing_jobs","value":{"intValue":missing.len().to_string()}}],
        "status":{"code":if missing.is_empty() && jobs.iter().all(|(_,s,_,_)| s == "ingested") {1} else {2}}}));
    json!({"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"buck2-evidence"}}]},
        "scopeSpans":[{"scope":{"name":"buck2-evidence.close"},"spans":spans}]}]})
}

/// Retry until all records finish, or close has waited six hours; mark pushed only after OTLP success.
fn pending_closes(cfg: &Config) -> Result<Vec<(String,String,i64)>> {
    let conn = crate::index::open(&cfg.index_path())?;
    // Idle CI attempts without a finalizer still get one incomplete root after six hours.
    let mut idle = conn.prepare("select run_id,repo,max(uploaded_at) from records
        where run_id like 'ci/%' and run_id not in (select run_id from closes)
        group by run_id,repo having max(uploaded_at) <= ?1")?;
    let overdue: Vec<(String,String,i64)> = idle.query_map([now_ms() - 6 * 60 * 60 * 1000],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?.collect::<rusqlite::Result<_>>()?;
    for (run, repo, last_upload) in overdue {
        let synthetic = CloseRecord { schema:"buck2-attempt-close/v1".into(), pipeline_run_id:run.clone(),
            repository:repo, sealed_at:"timeout".into(), expected_jobs:Vec::new() };
        let digest = hex::encode(Sha256::digest(run.as_bytes()));
        conn.execute("insert or ignore into closes (digest,run_id,repo,manifest_json,received_at) values (?1,?2,?3,?4,?5)",
            params![digest,run,synthetic.repository,serde_json::to_string(&synthetic)?,last_upload])?;
    }
    let mut stmt = conn.prepare("select digest,manifest_json,received_at from closes where root_pushed=0")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

fn jobs_for(cfg: &Config, run: &str) -> Result<Vec<(String,String,Option<i64>,Option<i64>)>> {
    let conn = crate::index::open(&cfg.index_path())?;
    let mut stmt = conn.prepare("select job,status,uploaded_at,ingested_at from records where run_id=?1")?;
    let rows = stmt.query_map([run], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub async fn reconcile(cfg: &Config, client: &reqwest::Client) -> Result<usize> {
    let db = cfg.clone();
    let pending = tokio::task::spawn_blocking(move || pending_closes(&db)).await??;
    let mut done = 0;
    for (digest, manifest, received) in pending {
        let close: CloseRecord = serde_json::from_str(&manifest)?;
        let db = cfg.clone();
        let run = close.pipeline_run_id.clone();
        let jobs = tokio::task::spawn_blocking(move || jobs_for(&db,&run)).await??;
        let all_done = close.expected_jobs.iter().all(|j| jobs.iter().any(|(k,s,_,_)| k == &j.key && (s == "ingested" || s == "failed")));
        if !all_done && now_ms() - received < 6 * 60 * 60 * 1000 { continue; }
        let id = ids::run_trace(&close.pipeline_run_id);
        let root = ids::run_root_span(&close.pipeline_run_id);
        let visible = crate::pipeline::tempo_span_counts(client,&cfg.tempo,&id).await.map_err(|e| anyhow::anyhow!(e))?.contains_key(&root);
        if !visible {
            let response = client.post(format!("{}/v1/traces",cfg.otlp.trim_end_matches('/'))).json(&root_body(&close,&jobs,received)).send().await?;
            if !response.status().is_success() { bail!("close OTLP response {}",response.status()); }
        }
        // Root must be queryable before the resolver calls the run ingested.
        let deadline = std::time::Instant::now() + cfg.readback_timeout;
        while !crate::pipeline::tempo_span_counts(client,&cfg.tempo,&id).await.map_err(|e| anyhow::anyhow!(e))?.contains_key(&root) {
            if std::time::Instant::now() >= deadline { bail!("root readback timed out for {}",close.pipeline_run_id); }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        let db = cfg.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let conn = crate::index::open(&db.index_path())?;
            conn.execute("update closes set root_pushed=1,error=null where digest=?1",[&digest])?;
            Ok(())
        }).await??;
        done += 1;
    }
    Ok(done)
}
