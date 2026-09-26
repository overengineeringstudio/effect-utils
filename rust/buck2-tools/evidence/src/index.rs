//! `index.sqlite`: the reconciliation index (05) and the only thing the resolver reads.
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::store::Manifest;

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.busy_timeout(std::time::Duration::from_secs(10))?;
    conn.execute_batch(
        "pragma journal_mode=wal; pragma synchronous=normal; pragma foreign_keys=on;",
    )?;
    Ok(conn)
}

pub fn init(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "create table if not exists records (
           digest text primary key,
           repo text not null, run_id text not null, attempt integer not null, job text not null,
           manifest_json text not null, bytes integer not null,
           status text not null,
           uploaded_at integer not null, started_at integer, ingested_at integer,
           attempts integer not null default 0,
           last_error text, archive_path text, spans integer, dup_spans integer);
         create index if not exists records_run on records(repo, run_id, attempt, job);
         create index if not exists records_status on records(status);
         create table if not exists traces (
           trace_id text not null, digest text not null references records(digest),
           view text not null, spans integer not null,
           primary key (trace_id, digest, view));",
    )
}

pub fn status_of(conn: &Connection, digest: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("select status from records where digest=?1", [digest], |r| r.get(0))
        .optional()
}

/// Inserts the `uploaded` row; returns false when the digest was already known.
pub fn insert_uploaded(conn: &Connection, digest: &str, m: &Manifest, bytes: u64, now: i64) -> rusqlite::Result<bool> {
    let n = conn.execute(
        "insert into records (digest, repo, run_id, attempt, job, manifest_json, bytes, status, uploaded_at)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'uploaded', ?8) on conflict(digest) do nothing",
        params![digest, m.run.repository, m.run.pipeline_run_id, m.run.attempt, m.run.job_key,
            serde_json::to_string(m).expect("serializable manifest"), bytes as i64, now],
    )?;
    conn.execute("insert or ignore into traces (trace_id,digest,view,spans) values (?1,?2,'critical',0)",
        params![crate::ids::run_trace(&m.run.pipeline_run_id), digest])?;
    Ok(n == 1)
}

pub fn mark_started(conn: &Connection, digest: &str, now: i64) -> rusqlite::Result<()> {
    conn.execute(
        "update records set status=case when status='ingested' then status else 'ingesting' end,
           started_at=coalesce(started_at, ?2), attempts=attempts+1 where digest=?1",
        params![digest, now],
    )?;
    Ok(())
}

#[derive(Clone, Debug, Serialize, serde::Deserialize)]
pub struct TraceRow {
    pub trace_id: String,
    pub view: String,
    pub spans: usize,
}

pub fn mark_ingested(
    conn: &mut Connection,
    digest: &str,
    traces: &[TraceRow],
    archive_path: &str,
    spans: usize,
    dup_spans: usize,
    now: i64,
) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    for t in traces {
        tx.execute(
            "insert or replace into traces (trace_id, digest, view, spans) values (?1, ?2, ?3, ?4)",
            params![t.trace_id, digest, t.view, t.spans as i64],
        )?;
    }
    // Idempotent: a replayed finalize keeps the first ingested_at.
    tx.execute(
        "update records set status='ingested', ingested_at=coalesce(ingested_at, ?2), archive_path=?3,
           spans=?4, dup_spans=?5, last_error=null where digest=?1",
        params![digest, now, archive_path, spans as i64, dup_spans as i64],
    )?;
    tx.commit()
}

pub fn mark_failed(conn: &Connection, digest: &str, error: &str) -> rusqlite::Result<()> {
    conn.execute(
        "update records set status='failed', last_error=?2 where digest=?1 and status<>'ingested'",
        params![digest, error],
    )?;
    Ok(())
}

pub fn note_error(conn: &Connection, digest: &str, error: &str) -> rusqlite::Result<()> {
    conn.execute("update records set last_error=?2 where digest=?1", params![digest, error])?;
    Ok(())
}

#[derive(Serialize)]
pub struct TraceStatus {
    pub trace_id: String,
    pub view: String,
    pub digest: String,
    pub status: String,
    pub repo: String,
    pub run_id: String,
    pub job: String,
}

/// Resolver read: `/t/<id>` needs only this.
pub fn trace_status(conn: &Connection, trace_id: &str) -> rusqlite::Result<Vec<TraceStatus>> {
    let mut st = conn.prepare(
        "select t.trace_id, t.view, r.digest, r.status, r.repo, r.run_id, r.job
         from traces t join records r on r.digest=t.digest where t.trace_id=?1",
    )?;
    let rows = st.query_map([trace_id], |r| {
        Ok(TraceStatus {
            trace_id: r.get(0)?,
            view: r.get(1)?,
            digest: r.get(2)?,
            status: r.get(3)?,
            repo: r.get(4)?,
            run_id: r.get(5)?,
            job: r.get(6)?,
        })
    })?;
    rows.collect()
}

pub fn record_json(conn: &Connection, digest: &str) -> rusqlite::Result<Option<serde_json::Value>> {
    conn.query_row(
        "select digest, repo, run_id, attempt, job, status, uploaded_at, started_at, ingested_at,
                attempts, last_error, archive_path, spans, dup_spans from records where digest=?1",
        [digest],
        |r| {
            Ok(serde_json::json!({
                "digest": r.get::<_, String>(0)?, "repo": r.get::<_, String>(1)?,
                "runId": r.get::<_, String>(2)?, "attempt": r.get::<_, i64>(3)?,
                "job": r.get::<_, String>(4)?, "status": r.get::<_, String>(5)?,
                "uploadedAt": r.get::<_, i64>(6)?, "startedAt": r.get::<_, Option<i64>>(7)?,
                "ingestedAt": r.get::<_, Option<i64>>(8)?, "attempts": r.get::<_, i64>(9)?,
                "lastError": r.get::<_, Option<String>>(10)?,
                "archivePath": r.get::<_, Option<String>>(11)?,
                "spans": r.get::<_, Option<i64>>(12)?, "dupSpans": r.get::<_, Option<i64>>(13)?,
            }))
        },
    )
    .optional()
}

/// Queue-agnostic gauges for /metrics.
pub fn status_counts(conn: &Connection) -> rusqlite::Result<Vec<(String, i64)>> {
    let mut st = conn.prepare("select status, count(*) from records group by status")?;
    let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    rows.collect()
}

pub fn oldest_pending_age_ms(conn: &Connection, now: i64) -> rusqlite::Result<i64> {
    conn.query_row(
        "select coalesce(?1 - min(uploaded_at), 0) from records where status in ('uploaded','ingesting')",
        [now],
        |r| r.get(0),
    )
}
