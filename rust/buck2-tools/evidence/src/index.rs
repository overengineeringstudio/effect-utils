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
           last_error text, archive_path text, spans integer, dup_spans integer,
           span_start_ms integer, span_end_ms integer);
         create index if not exists records_run on records(repo, run_id, attempt, job);
         create index if not exists records_status on records(status);
         create table if not exists traces (
           trace_id text not null, digest text not null references records(digest),
           view text not null, spans integer not null,
           primary key (trace_id, digest, view));
         create table if not exists expected_spans (
           trace_id text not null, digest text not null, span_id text not null,
           primary key (trace_id, digest, span_id));
         create table if not exists run_traces (
           run_id text primary key, repo text not null, trace_id text not null,
           verified_at integer, incomplete integer not null default 0);
         create table if not exists task_samples (
           digest text not null references records(digest), repo text not null,
           run_id text not null, job text not null, task text not null,
           duration_ms real not null, revision text not null,
           position integer, indexed_at integer not null,
           primary key (digest, task));
         create index if not exists task_samples_base on task_samples(repo,position,run_id);",
    )?;
    for column in ["span_start_ms", "span_end_ms"] {
        let mut stmt = conn.prepare("pragma table_info(records)")?;
        let names = stmt.query_map([], |r| r.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if !names.iter().any(|name| name == column) {
            conn.execute(&format!("alter table records add column {column} integer"), [])?;
        }
    }
    Ok(())
}

pub fn status_of(conn: &Connection, digest: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "select status from records where digest=?1",
        [digest],
        |r| r.get(0),
    )
    .optional()
}

/// Inserts the `uploaded` row; returns false when the digest was already known.
pub fn insert_uploaded(
    conn: &Connection,
    digest: &str,
    m: &Manifest,
    bytes: u64,
    now: i64,
) -> rusqlite::Result<bool> {
    let n = conn.execute(
        "insert into records (digest, repo, run_id, attempt, job, manifest_json, bytes, status, uploaded_at)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'uploaded', ?8) on conflict(digest) do nothing",
        params![digest, m.run.repository, m.run.pipeline_run_id, m.run.attempt, m.run.job_key,
            serde_json::to_string(m).expect("serializable manifest"), bytes as i64, now],
    )?;
    conn.execute(
        "insert or ignore into traces (trace_id,digest,view,spans) values (?1,?2,'critical',0)",
        params![crate::ids::run_trace(&m.run.pipeline_run_id), digest],
    )?;
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


/// Register every expected ID durably before advertising ingestion. Other jobs
/// sharing a run trace remain in the union after their plans are discarded.
pub fn register_expected(
    conn: &mut Connection,
    digest: &str,
    traces: &[crate::pipeline::PlanTrace],
) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    for trace in traces {
        let mut grew = false;
        for id in &trace.span_ids {
            grew |= tx.execute(
                "insert or ignore into expected_spans(trace_id,digest,span_id) values (?1,?2,?3)",
                params![trace.trace_id, digest, id],
            )? != 0;
        }
        if grew {
            tx.execute("update run_traces set verified_at=null where trace_id=?1", [&trace.trace_id])?;
        }
    }
    tx.commit()
}

/// Root and synthetic missing-job spans belong to the same cumulative union.
pub fn register_close_trace(
    conn: &Connection,
    run_id: &str,
    repo: &str,
    trace_id: &str,
    root_span: &str,
    missing_span_ids: &[String],
    incomplete: bool,
) -> rusqlite::Result<()> {
    conn.execute(
        "insert into run_traces(run_id,repo,trace_id,incomplete) values (?1,?2,?3,?4)
         on conflict(run_id) do update set incomplete=excluded.incomplete",
        params![run_id, repo, trace_id, i64::from(incomplete)],
    )?;
    for id in std::iter::once(root_span).chain(missing_span_ids.iter().map(String::as_str)) {
        let inserted = conn.execute(
            "insert or ignore into expected_spans(trace_id,digest,span_id) values (?1,?2,?3)",
            params![trace_id, format!("close:{run_id}"), id],
        )?;
        if inserted != 0 {
            conn.execute("update run_traces set verified_at=null where run_id=?1", [run_id])?;
        }
    }
    Ok(())
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
    conn.execute(
        "update records set last_error=?2 where digest=?1",
        params![digest, error],
    )?;
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
pub fn run_trace_state(conn: &Connection, trace_id: &str) -> rusqlite::Result<Option<&'static str>> {
    conn.query_row(
        "select case when incomplete=1 then 'incomplete'
                     when verified_at is not null then 'ingested'
                     else 'pending' end from run_traces where trace_id=?1",
        [trace_id], |r| r.get::<_, String>(0),
    ).optional().map(|state| state.map(|s| match s.as_str() {
        "incomplete" => "incomplete", "ingested" => "ingested", _ => "pending",
    }))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cumulative_run_union_and_close_without_jobs() {
        let mut conn = Connection::open_in_memory().unwrap();
        init(&conn).unwrap();
        let trace = "00112233445566778899aabbccddeeff";
        let run = "ci/github/example/repo/42/1";
        assert_eq!(run_trace_state(&conn, trace).unwrap(), None);
        register_close_trace(&conn, run, "example/repo", trace, "root", &[], false).unwrap();
        assert_eq!(run_trace_state(&conn, trace).unwrap(), Some("pending"));
        for (digest, span) in [("first", "span1"), ("second", "span2")] {
            register_expected(&mut conn, digest, &[crate::pipeline::PlanTrace {
                trace_id: trace.into(), view: "critical".into(), span_ids: vec![span.into()],
            }]).unwrap();
        }
        let mut stmt = conn.prepare("select digest,span_id from expected_spans where trace_id=?1 order by span_id").unwrap();
        let ids: Vec<(String,String)> = stmt.query_map([trace], |r| Ok((r.get(0)?,r.get(1)?)))
            .unwrap().collect::<rusqlite::Result<_>>().unwrap();
        assert_eq!(ids, vec![
            ("close:ci/github/example/repo/42/1".into(), "root".into()),
            ("first".into(), "span1".into()),
            ("second".into(), "span2".into()),
        ]);
        conn.execute("update run_traces set verified_at=123 where run_id=?1", [run]).unwrap();
        register_expected(&mut conn, "first", &[crate::pipeline::PlanTrace {
            trace_id: trace.into(), view: "critical".into(), span_ids: vec!["span1".into()],
        }]).unwrap();
        assert_eq!(run_trace_state(&conn, trace).unwrap(), Some("ingested"));
        register_expected(&mut conn, "third", &[crate::pipeline::PlanTrace {
            trace_id: trace.into(), view: "critical".into(), span_ids: vec!["span3".into()],
        }]).unwrap();
        assert_eq!(run_trace_state(&conn, trace).unwrap(), Some("pending"));
    }
}
