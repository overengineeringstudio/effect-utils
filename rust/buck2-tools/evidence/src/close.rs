//! A separately sealed CI roster closes a run; local runs already contain their root.
use crate::{ids, now_ms, Config};
use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs, io::Read, path::Path};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ExpectedJob {
    pub key: String,
    pub conclusion: String,
}
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
    if record.schema != "buck2-attempt-close/v1"
        || !record.pipeline_run_id.starts_with("ci/")
        || record.repository.split('/').count() != 2
    {
        bail!("invalid CI close identity");
    }
    let mut keys = HashSet::new();
    if record.expected_jobs.iter().any(|j| {
        j.key.is_empty()
            || !keys.insert(&j.key)
            || !matches!(
                j.conclusion.as_str(),
                "success" | "failure" | "cancelled" | "skipped"
            )
    }) {
        bail!("invalid or duplicate expected job");
    }
    Ok(())
}

pub fn seal_close(spool: &Path, run: &str, repository: &str, jobs_json: &Path) -> Result<String> {
    let mut jobs: Vec<ExpectedJob> = serde_json::from_slice(&fs::read(jobs_json)?)?;
    jobs.sort_by(|a, b| a.key.cmp(&b.key));
    let output = std::process::Command::new("date")
        .args(["-u", "+%Y-%m-%dT%H:%M:%SZ"])
        .output()?;
    if !output.status.success() {
        bail!("UTC clock unavailable");
    }
    let record = CloseRecord {
        schema: "buck2-attempt-close/v1".into(),
        pipeline_run_id: run.into(),
        repository: repository.into(),
        sealed_at: String::from_utf8(output.stdout)?.trim().into(),
        expected_jobs: jobs,
    };
    validate(&record)?;
    fs::create_dir_all(spool)?;
    let target = spool.join("manifest.json");
    if target.exists() {
        let previous = fs::read(&target)?;
        let old: CloseRecord = serde_json::from_slice(&previous)?;
        if old.pipeline_run_id != run
            || old.repository != repository
            || old
                .expected_jobs
                .iter()
                .map(|j| (&j.key, &j.conclusion))
                .ne(record.expected_jobs.iter().map(|j| (&j.key, &j.conclusion)))
        {
            bail!("conflicting sealed close roster");
        }
        return Ok(hex::encode(Sha256::digest(previous)));
    }
    let bytes = serde_json::to_vec(&record)?;
    let digest = hex::encode(Sha256::digest(&bytes));
    fs::write(spool.join("manifest.json.tmp"), bytes)?;
    fs::rename(spool.join("manifest.json.tmp"), target)?;
    Ok(digest)
}

pub fn init(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("create table if not exists closes (digest text primary key, run_id text not null unique, repo text not null, manifest_json text not null, received_at integer not null, root_pushed integer not null default 0, incomplete integer not null default 0, archive_path text, error text);")?;
    let mut columns = conn.prepare("pragma table_info(closes)")?;
    let names: Vec<String> = columns
        .query_map([], |r| r.get(1))?
        .collect::<rusqlite::Result<_>>()?;
    if !names.iter().any(|name| name == "incomplete") {
        conn.execute_batch("alter table closes add column incomplete integer not null default 0")?;
    }
    if !names.iter().any(|name| name == "archive_path") {
        conn.execute_batch("alter table closes add column archive_path text")?;
    }
    Ok(())
}

/// Only one manifest file is accepted, with no additional tar members or padding data.
pub fn accept(cfg: &Config, conn: &Connection, digest: &str, body: &[u8]) -> Result<bool> {
    if !crate::store::is_digest(digest) || body.len() > 1024 * 1024 {
        bail!("invalid close digest or size");
    }
    let mut archive = tar::Archive::new(body);
    let mut entries = archive.entries()?;
    let mut entry = entries.next().context("missing close manifest")??;
    if entry.path()?.as_ref() != Path::new("manifest.json")
        || !entry.header().entry_type().is_file()
    {
        bail!("invalid close archive");
    }
    let mut bytes = Vec::new();
    entry.read_to_end(&mut bytes)?;
    drop(entry);
    if entries.next().is_some() || hex::encode(Sha256::digest(&bytes)) != digest {
        bail!("close digest mismatch or unexpected file");
    }
    let record: CloseRecord = serde_json::from_slice(&bytes)?;
    validate(&record)?;
    let existing: Option<(String, String, bool, Option<String>)> = conn
        .query_row(
            "select digest,manifest_json,root_pushed != 0,archive_path from closes where run_id=?1",
            [&record.pipeline_run_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let synthetic = existing.as_ref().is_some_and(|(_, manifest, _, _)| {
        serde_json::from_str::<CloseRecord>(manifest).is_ok_and(|old| old.sealed_at == "timeout")
    });
    if existing
        .as_ref()
        .is_some_and(|(old, _, _, _)| old != digest)
        && !synthetic
    {
        bail!("conflicting close for run");
    }
    // Archive first: an index row must never claim a close whose raw roster is lost.
    let parts: Vec<_> = record.pipeline_run_id.split('/').collect();
    let run_id = parts
        .get(parts.len().saturating_sub(2))
        .context("invalid CI run")?;
    let attempt: u32 = parts.last().context("invalid CI attempt")?.parse()?;
    let manifest = crate::store::Manifest {
        schema: "buck2-run-record/v1".into(),
        producer: json!({}),
        run: crate::store::RunBlock {
            repository: record.repository.clone(),
            pipeline_run_id: record.pipeline_run_id.clone(),
            run_id: (*run_id).into(),
            attempt,
            job_key: String::new(),
            event: String::new(),
            branch: String::new(),
            worker: json!({}),
            fork: false,
            trusted: false,
        },
        files: Vec::new(),
        vcs_change_id: None,
        vcs_head: None,
        vcs_base: None,
        vcs_merge: None,
        vcs_head_position: None,
        vcs_base_position: None,
        vcs_base_ancestors: Vec::new(),
    };
    let job_path: Option<(Option<String>, i64)> = conn
        .query_row(
            "select archive_path,uploaded_at from records where run_id=?1
         order by archive_path is null, uploaded_at desc limit 1",
            [&record.pipeline_run_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let archived = if let Some((_, _, _, Some(path))) = &existing {
        Path::new(path).to_path_buf()
    } else if let Some((Some(path), _)) = &job_path {
        Path::new(path)
            .parent()
            .context("invalid job archive path")?
            .join("attempt-close.json")
    } else {
        crate::store::archive_path(
            cfg,
            &manifest,
            job_path.map_or_else(now_ms, |(_, uploaded)| uploaded),
        )
        .parent()
        .context("invalid close archive path")?
        .join("attempt-close.json")
    };
    fs::create_dir_all(
        archived
            .parent()
            .context("invalid close archive directory")?,
    )?;
    if archived.exists() {
        if fs::read(&archived)? != bytes {
            bail!("conflicting archived close for run");
        }
    } else {
        let tmp = archived.with_file_name(format!("attempt-close.{digest}.tmp"));
        fs::write(&tmp, &bytes)?;
        fs::rename(&tmp, &archived)?;
    }
    let manifest_json = String::from_utf8(bytes)?;
    if synthetic {
        conn.execute(
            "update closes set digest=?1,repo=?2,manifest_json=?3,received_at=?4,
             incomplete=case when root_pushed=1 then 1 else 0 end,archive_path=?5 where run_id=?6",
            params![
                digest,
                record.repository,
                manifest_json,
                now_ms(),
                archived.to_string_lossy(),
                record.pipeline_run_id
            ],
        )?;
    } else {
        let inserted = conn.execute(
            "insert into closes (digest,run_id,repo,manifest_json,received_at,archive_path) values (?1,?2,?3,?4,?5,?6) on conflict do nothing",
            params![digest,record.pipeline_run_id,record.repository,manifest_json,now_ms(),archived.to_string_lossy()],
        )? != 0;
        let incomplete: bool = conn.query_row(
            "select incomplete from closes where run_id=?1",
            [&record.pipeline_run_id],
            |r| r.get(0),
        )?;
        crate::index::register_close_trace(
            conn,
            &record.pipeline_run_id,
            &record.repository,
            &ids::run_trace(&record.pipeline_run_id),
            &ids::run_root_span(&record.pipeline_run_id),
            &[],
            incomplete,
        )?;
        return Ok(inserted);
    }
    crate::index::register_close_trace(
        conn,
        &record.pipeline_run_id,
        &record.repository,
        &ids::run_trace(&record.pipeline_run_id),
        &ids::run_root_span(&record.pipeline_run_id),
        &[],
        existing.as_ref().is_some_and(|(_, _, pushed, _)| *pushed),
    )?;
    Ok(true)
}
use rusqlite::OptionalExtension;

type JobStatus = (String, String, i64, Option<i64>, Option<i64>);

fn root_body(
    close: &CloseRecord,
    jobs: &[JobStatus],
    received: i64,
    closed: i64,
    incomplete: bool,
) -> Value {
    let trace = ids::run_trace(&close.pipeline_run_id);
    let mut spans = Vec::new();
    let started = jobs
        .iter()
        .filter_map(|(_, _, _, s, _)| *s)
        .min()
        .unwrap_or(received.min(closed));
    let ended = jobs
        .iter()
        .filter_map(|(_, _, _, _, e)| *e)
        .max()
        .unwrap_or(closed)
        .max(closed)
        .max(started + 1);
    let missing: Vec<_> = close
        .expected_jobs
        .iter()
        .filter(|j| !jobs.iter().any(|(k, _, _, _, _)| k == &j.key))
        .collect();
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
            {"key":"evidence.missing_jobs","value":{"intValue":missing.len().to_string()}},
            {"key":"evidence.incomplete","value":{"boolValue":incomplete}}],
        "status":{"code":if !incomplete
            && missing.iter().all(|j| matches!(j.conclusion.as_str(), "skipped" | "cancelled"))
            && jobs.iter().all(|(_,s,_,_,_)| s == "ingested") {1} else {2}}}));
    json!({"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"buck2-evidence"}}]},
        "scopeSpans":[{"scope":{"name":"buck2-evidence.close"},"spans":spans}]}]})
}

/// Retry until all records finish, or close has waited six hours; mark pushed only after OTLP success.
fn pending_closes(cfg: &Config) -> Result<Vec<(String, String, i64, bool, bool, i64)>> {
    let conn = crate::index::open(&cfg.index_path())?;
    // Idle CI attempts without a finalizer still get one incomplete root after six hours.
    let mut idle = conn.prepare(
        "select run_id,repo,max(uploaded_at) from records
        where run_id like 'ci/%' and run_id not in (select run_id from closes)
        group by run_id,repo having max(uploaded_at) <= ?1",
    )?;
    let overdue: Vec<(String, String, i64)> = idle
        .query_map([now_ms() - 6 * 60 * 60 * 1000], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    for (run, repo, last_upload) in overdue {
        let synthetic = CloseRecord {
            schema: "buck2-attempt-close/v1".into(),
            pipeline_run_id: run.clone(),
            repository: repo,
            sealed_at: "timeout".into(),
            expected_jobs: Vec::new(),
        };
        let digest = hex::encode(Sha256::digest(run.as_bytes()));
        conn.execute("insert or ignore into closes (digest,run_id,repo,manifest_json,received_at,incomplete) values (?1,?2,?3,?4,?5,1)",
            params![digest,run,synthetic.repository,serde_json::to_string(&synthetic)?,last_upload])?;
    }
    let mut stmt = conn.prepare(
        "select digest,manifest_json,received_at,incomplete,root_pushed,
                coalesce(1000 * cast(strftime('%s',json_extract(manifest_json,'$.sealedAt')) as integer),received_at)
         from closes",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

fn jobs_for(cfg: &Config, run: &str) -> Result<Vec<JobStatus>> {
    let conn = crate::index::open(&cfg.index_path())?;
    let mut stmt = conn.prepare(
        "select job,status,uploaded_at,span_start_ms,span_end_ms from records where run_id=?1",
    )?;
    let rows = stmt
        .query_map([run], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

fn jobs_complete(close: &CloseRecord, jobs: &[JobStatus]) -> bool {
    close.expected_jobs.iter().all(|job| {
        matches!(job.conclusion.as_str(), "skipped" | "cancelled")
            || jobs.iter().any(|(key, status, _, _, _)| {
                key == &job.key && matches!(status.as_str(), "ingested" | "failed")
            })
    })
}

fn ready_to_close(close: &CloseRecord, jobs: &[JobStatus], received: i64, now: i64) -> bool {
    let last_upload = jobs
        .iter()
        .map(|(_, _, uploaded, _, _)| *uploaded)
        .max()
        .unwrap_or(received);
    jobs_complete(close, jobs) || now - last_upload >= 6 * 60 * 60 * 1000
}

pub async fn reconcile(cfg: &Config, client: &reqwest::Client) -> Result<usize> {
    let db = cfg.clone();
    let pending = tokio::task::spawn_blocking(move || pending_closes(&db)).await??;
    let mut done = 0;
    for (digest, manifest, received, mut incomplete, root_pushed, closed) in pending {
        let close: CloseRecord = serde_json::from_str(&manifest)?;
        let db = cfg.clone();
        let run = close.pipeline_run_id.clone();
        let current = crate::index::open(&cfg.index_path())?.query_row(
            "select digest from closes where run_id=?1",
            [&close.pipeline_run_id],
            |r| r.get::<_, String>(0),
        )?;
        if current != digest {
            continue;
        }
        let jobs = tokio::task::spawn_blocking(move || jobs_for(&db, &run)).await??;
        if !root_pushed && !ready_to_close(&close, &jobs, received, now_ms()) {
            continue;
        }
        if !root_pushed && !incomplete && !jobs_complete(&close, &jobs) {
            let conn = crate::index::open(&cfg.index_path())?;
            conn.execute(
                "update closes set incomplete=1 where digest=?1 and root_pushed=0",
                [&digest],
            )?;
            incomplete = true;
        }
        let id = ids::run_trace(&close.pipeline_run_id);
        let root = ids::run_root_span(&close.pipeline_run_id);
        let missing: Vec<String> = if root_pushed && incomplete {
            Vec::new()
        } else {
            close
                .expected_jobs
                .iter()
                .filter(|j| !jobs.iter().any(|(k, _, _, _, _)| k == &j.key))
                .map(|j| ids::job_span(&close.pipeline_run_id, &j.key))
                .collect()
        };
        {
            let conn = crate::index::open(&cfg.index_path())?;
            crate::index::register_close_trace(
                &conn,
                &close.pipeline_run_id,
                &close.repository,
                &id,
                &root,
                &missing,
                incomplete,
            )?;
        }
        if !root_pushed {
            let counts = crate::pipeline::tempo_span_counts(client, &cfg.tempo, &id)
                .await
                .map_err(|e| anyhow::anyhow!(e))?;
            let mut absent = missing
                .iter()
                .filter(|span| !counts.contains_key(*span))
                .count();
            absent += usize::from(!counts.contains_key(&root));
            if absent > 0 {
                let mut body = root_body(&close, &jobs, received, closed, incomplete);
                for span in body["resourceSpans"][0]["scopeSpans"][0]["spans"]
                    .as_array_mut()
                    .into_iter()
                    .flatten()
                {
                    let span_id = span["spanId"].as_str().unwrap_or_default();
                    if counts.contains_key(span_id) {
                        *span = Value::Null;
                    }
                }
                body["resourceSpans"][0]["scopeSpans"][0]["spans"]
                    .as_array_mut()
                    .expect("root spans")
                    .retain(|span| !span.is_null());
                let response = client
                    .post(format!("{}/v1/traces", cfg.otlp.trim_end_matches('/')))
                    .json(&body)
                    .send()
                    .await?;
                if !response.status().is_success() {
                    bail!("close OTLP response {}", response.status());
                }
            }
            let deadline = std::time::Instant::now() + cfg.readback_timeout;
            loop {
                let counts = crate::pipeline::tempo_span_counts(client, &cfg.tempo, &id)
                    .await
                    .map_err(|e| anyhow::anyhow!(e))?;
                if counts.contains_key(&root)
                    && missing.iter().all(|span| counts.contains_key(span))
                {
                    break;
                }
                if std::time::Instant::now() >= deadline {
                    bail!("close readback timed out for {}", close.pipeline_run_id);
                }
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            }
            {
                let conn = crate::index::open(&cfg.index_path())?;
                conn.execute(
                    "update closes set root_pushed=1,error=null where digest=?1",
                    [&digest],
                )?;
            }
            done += 1;
        }
        crate::pipeline::verify_run_trace(client, cfg, &close.pipeline_run_id)
            .await
            .map_err(|e| anyhow::anyhow!(e))?;
    }
    Ok(done)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture() -> (Config, Connection) {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let cfg = Config {
            state: std::env::temp_dir()
                .join(format!("evidence-close-{}-{nonce}", std::process::id())),
            otlp: String::new(),
            tempo: String::new(),
            readback_timeout: std::time::Duration::from_secs(1),
            grafana: String::new(),
        };
        cfg.ensure_dirs().unwrap();
        let conn = crate::index::open(&cfg.index_path()).unwrap();
        crate::index::init(&conn).unwrap();
        init(&conn).unwrap();
        (cfg, conn)
    }

    fn tar_close(bytes: &[u8]) -> Vec<u8> {
        let mut body = Vec::new();
        let mut tar = tar::Builder::new(&mut body);
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        tar.append_data(&mut header, "manifest.json", bytes)
            .unwrap();
        tar.finish().unwrap();
        drop(tar);
        body
    }

    #[test]
    fn timeout_remains_incomplete_after_late_real_close() {
        let (cfg, conn) = fixture();
        let run = "ci/owner/repo/321/1";
        let old = now_ms() - 6 * 60 * 60 * 1000 - 1000;
        conn.execute(
            "insert into records (digest,repo,run_id,attempt,job,manifest_json,bytes,status,uploaded_at)
             values (?1,'owner/repo',?2,1,'build','{}',0,'ingested',?3)",
            params!["a".repeat(64), run, old],
        ).unwrap();
        let pending = pending_closes(&cfg).unwrap();
        assert_eq!(pending.len(), 1);
        assert!(
            pending[0].3,
            "timeout must remain incomplete even with every known job ingested"
        );
        let synthetic: CloseRecord = serde_json::from_str(&pending[0].1).unwrap();
        let body = root_body(&synthetic, &jobs_for(&cfg, run).unwrap(), old, old, true);
        let root = body["resourceSpans"][0]["scopeSpans"][0]["spans"]
            .as_array()
            .unwrap()
            .last()
            .unwrap();
        assert_eq!(root["status"]["code"], 2);
        assert_eq!(root["attributes"][3]["value"]["boolValue"], true);
        conn.execute("update closes set root_pushed=1 where run_id=?1", [run])
            .unwrap();

        let late = CloseRecord {
            schema: "buck2-attempt-close/v1".into(),
            pipeline_run_id: run.into(),
            repository: "owner/repo".into(),
            sealed_at: "2026-09-27T12:00:00Z".into(),
            expected_jobs: vec![ExpectedJob {
                key: "build".into(),
                conclusion: "success".into(),
            }],
        };
        let bytes = serde_json::to_vec(&late).unwrap();
        let digest = hex::encode(Sha256::digest(&bytes));
        assert!(accept(&cfg, &conn, &digest, &tar_close(&bytes)).unwrap());
        let (persisted, incomplete, pushed, archived): (String, bool, bool, String) = conn
            .query_row(
                "select digest,incomplete,root_pushed,archive_path from closes where run_id=?1",
                [run],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(persisted, digest);
        assert!(
            incomplete && pushed,
            "late close cannot retroactively rewrite the published root"
        );
        assert_eq!(fs::read(archived).unwrap(), bytes);
        fs::remove_dir_all(cfg.state).unwrap();
    }

    #[test]
    fn rejects_nonadjacent_duplicate_roster_keys() {
        let (cfg, conn) = fixture();
        let close = CloseRecord {
            schema: "buck2-attempt-close/v1".into(),
            pipeline_run_id: "ci/owner/repo/321/1".into(),
            repository: "owner/repo".into(),
            sealed_at: "2026-09-27T12:00:00Z".into(),
            expected_jobs: ["a", "b", "a"]
                .into_iter()
                .map(|key| ExpectedJob {
                    key: key.into(),
                    conclusion: "skipped".into(),
                })
                .collect(),
        };
        let bytes = serde_json::to_vec(&close).unwrap();
        let digest = hex::encode(Sha256::digest(&bytes));
        assert!(accept(&cfg, &conn, &digest, &tar_close(&bytes)).is_err());
        fs::remove_dir_all(cfg.state).unwrap();
    }

    #[test]
    fn waits_six_hours_from_last_upload_but_not_for_skipped_jobs() {
        let close = CloseRecord {
            schema: "buck2-attempt-close/v1".into(),
            pipeline_run_id: "ci/owner/repo/12/1".into(),
            repository: "owner/repo".into(),
            sealed_at: "2026-09-27T12:00:00Z".into(),
            expected_jobs: vec![
                ExpectedJob {
                    key: "uploaded".into(),
                    conclusion: "success".into(),
                },
                ExpectedJob {
                    key: "absent".into(),
                    conclusion: "failure".into(),
                },
            ],
        };
        let hour = 60 * 60 * 1000;
        let jobs = vec![(
            "uploaded".into(),
            "ingested".into(),
            5 * hour,
            Some(100),
            Some(500),
        )];
        assert!(!ready_to_close(&close, &jobs, 0, 6 * hour));
        assert!(!ready_to_close(&close, &jobs, 0, 10 * hour));
        assert!(ready_to_close(&close, &jobs, 0, 11 * hour));
        assert!(
            ready_to_close(&close, &jobs, 10 * hour, 11 * hour),
            "late close receipt cannot reset the last-upload deadline"
        );
        let skipped = CloseRecord {
            expected_jobs: vec![ExpectedJob {
                key: "absent".into(),
                conclusion: "skipped".into(),
            }],
            ..close
        };
        assert!(ready_to_close(&skipped, &jobs, 0, 0));
        let body = root_body(&skipped, &jobs, 200, 600, false);
        let spans = body["resourceSpans"][0]["scopeSpans"][0]["spans"]
            .as_array()
            .unwrap();
        let root = spans.last().unwrap();
        assert_eq!(root["startTimeUnixNano"], "100000000");
        assert_eq!(root["endTimeUnixNano"], "600000000");
        assert_eq!(spans[0]["attributes"][1]["value"]["stringValue"], "skipped");
    }

    #[tokio::test]
    async fn empty_roster_publishes_one_verified_run_root() {
        use axum::{
            extract::State,
            routing::{get, post},
            Json, Router,
        };
        use std::sync::Arc;
        use tokio::sync::Mutex;

        let (mut cfg, conn) = fixture();
        let run = "ci/owner/repo/999/1";
        let close = CloseRecord {
            schema: "buck2-attempt-close/v1".into(),
            pipeline_run_id: run.into(),
            repository: "owner/repo".into(),
            sealed_at: "2026-09-27T12:00:00Z".into(),
            expected_jobs: Vec::new(),
        };
        let bytes = serde_json::to_vec(&close).unwrap();
        let digest = hex::encode(Sha256::digest(&bytes));
        assert!(accept(&cfg, &conn, &digest, &tar_close(&bytes)).unwrap());
        let trace: String = conn
            .query_row(
                "select trace_id from run_traces where run_id=?1",
                [run],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            trace,
            ids::run_trace(run),
            "close alone must index its run trace"
        );
        let spans = Arc::new(Mutex::new(Vec::<String>::new()));
        async fn push(
            State(spans): State<Arc<Mutex<Vec<String>>>>,
            Json(body): Json<Value>,
        ) -> Json<Value> {
            let mut out = spans.lock().await;
            for resource in body["resourceSpans"].as_array().into_iter().flatten() {
                for scope in resource["scopeSpans"].as_array().into_iter().flatten() {
                    for span in scope["spans"].as_array().into_iter().flatten() {
                        out.push(span["spanId"].as_str().unwrap().into());
                    }
                }
            }
            Json(json!({}))
        }
        async fn readback(State(spans): State<Arc<Mutex<Vec<String>>>>) -> Json<Value> {
            let spans = spans
                .lock()
                .await
                .iter()
                .map(|id| json!({"spanId":id}))
                .collect::<Vec<_>>();
            Json(json!({"trace":{"resourceSpans":[{"scopeSpans":[{"spans":spans}]}]}}))
        }
        let app = Router::new()
            .route("/v1/traces", post(push))
            .route("/api/v2/traces/{id}", get(readback))
            .with_state(Arc::clone(&spans));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        cfg.otlp = format!("http://{address}");
        cfg.tempo = cfg.otlp.clone();
        let client = reqwest::Client::new();
        assert_eq!(reconcile(&cfg, &client).await.unwrap(), 1);
        assert_eq!(reconcile(&cfg, &client).await.unwrap(), 0);
        assert_eq!(spans.lock().await.as_slice(), &[ids::run_root_span(run)]);
        let (pushed, verified): (bool, Option<i64>) = conn.query_row(
            "select c.root_pushed,rt.verified_at from closes c join run_traces rt on rt.run_id=c.run_id where c.run_id=?1",
            [run], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert!(pushed && verified.is_some());

        let timed_out_run = "ci/owner/repo/1000/1";
        let old = now_ms() - 7 * 60 * 60 * 1000;
        let timed_out = CloseRecord {
            pipeline_run_id: timed_out_run.into(),
            expected_jobs: vec![
                ExpectedJob {
                    key: "done".into(),
                    conclusion: "success".into(),
                },
                ExpectedJob {
                    key: "late".into(),
                    conclusion: "failure".into(),
                },
            ],
            ..close
        };
        let bytes = serde_json::to_vec(&timed_out).unwrap();
        let digest = hex::encode(Sha256::digest(&bytes));
        assert!(accept(&cfg, &conn, &digest, &tar_close(&bytes)).unwrap());
        conn.execute(
            "insert into records (digest,repo,run_id,attempt,job,manifest_json,bytes,status,uploaded_at)
             values (?1,'owner/repo',?2,1,'done','{}',0,'ingested',?3)",
            params!["b".repeat(64), timed_out_run, old],
        ).unwrap();
        assert_eq!(reconcile(&cfg, &client).await.unwrap(), 1);
        let (incomplete, verified): (bool, Option<i64>) = conn.query_row(
            "select c.incomplete,rt.verified_at from closes c join run_traces rt on rt.run_id=c.run_id where c.run_id=?1",
            [timed_out_run], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert!(
            incomplete && verified.is_none(),
            "timed-out roster cannot be published as complete"
        );
        conn.execute(
            "insert into records (digest,repo,run_id,attempt,job,manifest_json,bytes,status,uploaded_at)
             values (?1,'owner/repo',?2,1,'late','{}',0,'uploaded',?3)",
            params!["c".repeat(64), timed_out_run, now_ms()],
        ).unwrap();
        assert_eq!(reconcile(&cfg, &client).await.unwrap(), 0);
        let still_incomplete: bool = conn
            .query_row(
                "select incomplete from closes where run_id=?1",
                [timed_out_run],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            still_incomplete,
            "late upload must not rewrite the already-published root"
        );
        server.abort();
        fs::remove_dir_all(cfg.state).unwrap();
    }
}
