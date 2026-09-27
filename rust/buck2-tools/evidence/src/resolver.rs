//! Read-only trace access: every link is derived from the durable index, not Tempo search.
use crate::{http::AppState, ids, index};
use axum::{
    extract::{Path, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

fn valid_name(part: &str) -> bool {
    !part.is_empty()
        && part.len() <= 120
        && part
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        && part != ".."
}
fn error(code: StatusCode, msg: &str) -> Response {
    (code, msg.to_owned()).into_response()
}
fn html_escape(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '&' => "&amp;".into(),
            '<' => "&lt;".into(),
            '>' => "&gt;".into(),
            '"' => "&quot;".into(),
            '\'' => "&#39;".into(),
            _ => c.to_string(),
        })
        .collect()
}
fn encoded(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}
fn listed(
    conn: &Connection,
    repo: &str,
    change: Option<&str>,
    run: Option<&str>,
) -> rusqlite::Result<Vec<Value>> {
    let mut stmt = conn.prepare("select r.digest, r.run_id, r.attempt, r.job, r.status, r.manifest_json, r.ingested_at,
             coalesce((select json_group_array(json_object('kind', view, 'id', trace_id, 'url', '/t/' || trace_id)) from traces t where t.digest=r.digest),'[]'),
             r.started_at, r.uploaded_at
             from records r where repo=?1 and job<>'__close' order by uploaded_at desc")?;
    let rows = stmt.query_map([repo], |r| {
        let manifest: String = r.get(5)?;
        let traces: String = r.get(7)?;
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, u32>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            manifest,
            r.get::<_, Option<i64>>(6)?,
            traces,
            r.get::<_, Option<i64>>(8)?,
            r.get::<_, i64>(9)?,
        ))
    })?;
    let mut result = Vec::new();
    for row in rows {
        let (
            digest,
            run_id,
            attempt,
            job,
            status,
            manifest,
            ingested_at,
            traces,
            started,
            uploaded,
        ) = row?;
        let Ok(m) = serde_json::from_str::<Value>(&manifest) else {
            continue;
        };
        if change.is_some_and(|id| m["vcs.change.id"] != id) || run.is_some_and(|id| id != run_id) {
            continue;
        }
        let trace = ids::run_trace(&run_id);
        result.push(json!({"digest": digest, "runId":run_id,"attempt":attempt,"key":job,"status":status,
            "uploadedAt":uploaded,"ingestedAt":ingested_at,"vcs.ref.head.revision":m["vcs.ref.head.revision"],
            "vcs.ref.base.revision":m["vcs.ref.base.revision"],
            "vcs.ref.base.position":m["vcs.ref.base.position"],
            "vcs.ref.base.first_parent_ancestors":m["vcs.ref.base.first_parent_ancestors"],
            "buck2.vcs.merge.revision":m["buck2.vcs.merge.revision"],
            "trace":{"id":trace,"url":format!("/t/{trace}")},
            "traces":serde_json::from_str::<Value>(&traces).unwrap_or(json!([])),
            "topTasks":[], "durationMs":ingested_at.map(|end| end.saturating_sub(started.unwrap_or(uploaded)))}));
    }
    Ok(result)
}
fn compare(
    conn: &Connection,
    repo: &str,
    change: Option<&str>,
    runs: &[Value],
) -> rusqlite::Result<(Value, String)> {
    let unavailable = || {
        (
            json!({"baselineCount":0,"tasks":[]}),
            "Evidence indexed; baseline unavailable".into(),
        )
    };
    if change.is_none() {
        return Ok(unavailable());
    }
    let Some(latest) = runs.first() else {
        return Ok(unavailable());
    };
    let Some(base) = latest["jobs"][0]["vcs.ref.base.revision"].as_str() else {
        return Ok(unavailable());
    };
    let Some(position) = latest["jobs"][0]["vcs.ref.base.position"].as_i64() else {
        return Ok(unavailable());
    };
    let Some(ancestors) = latest["jobs"][0]["vcs.ref.base.first_parent_ancestors"].as_array()
    else {
        return Ok(unavailable());
    };
    if ancestors.first().and_then(Value::as_str) != Some(base) {
        return Ok(unavailable());
    }
    let ancestry: BTreeSet<&str> = ancestors.iter().filter_map(Value::as_str).collect();
    // Main positions order eligible runs; revision membership proves ancestry
    // even after a force-push with overlapping first-parent counts.
    let mut select_runs = conn.prepare(
        "select s.run_id, s.revision from task_samples s
         join records r on r.digest=s.digest
         where s.repo=?1 and s.position<=?2 and r.status='ingested'
         group by s.run_id, s.revision
         order by max(s.position) desc, max(s.indexed_at) desc, s.run_id desc",
    )?;
    let mut main_runs = Vec::new();
    for row in select_runs.query_map(rusqlite::params![repo, position], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })? {
        let (id, revision) = row?;
        if ancestry.contains(revision.as_str()) && !main_runs.contains(&id) {
            main_runs.push(id);
            if main_runs.len() == 7 {
                break;
            }
        }
    }
    let mut main_samples: BTreeMap<(String, String), Vec<f64>> = BTreeMap::new();
    let mut samples = conn.prepare(
        "select s.job, s.task, s.duration_ms from task_samples s
         join records r on r.digest=s.digest
         where s.repo=?1 and s.run_id=?2 and r.status='ingested'
         order by s.indexed_at desc",
    )?;
    for run_id in &main_runs {
        let mut seen = BTreeSet::new();
        for sample in samples.query_map(rusqlite::params![repo, run_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, f64>(2)?,
            ))
        })? {
            let (job, task, duration) = sample?;
            if seen.insert((job.clone(), task.clone())) {
                main_samples.entry((job, task)).or_default().push(duration);
            }
        }
    }
    let mut comparison = Vec::new();
    let mut faster = 0;
    let mut slower = 0;
    for job in latest["jobs"].as_array().into_iter().flatten() {
        if job["status"] != "ingested" {
            continue;
        }
        let key = job["key"].as_str().unwrap_or_default();
        for task in job["topTasks"].as_array().into_iter().flatten() {
            let name = task["name"].as_str().unwrap_or_default();
            let Some(pr_ms) = task["durationMs"].as_f64() else {
                continue;
            };
            let mut baseline = main_samples
                .remove(&(key.to_owned(), name.to_owned()))
                .unwrap_or_default();
            baseline.sort_by(f64::total_cmp);
            let n = baseline.len();
            if n == 0 {
                comparison.push(json!({"jobKey":key,"name":name,"sampleCount":0,
                    "medianMs":null,"spreadMs":null,"prMs":pr_ms,"deltaMs":null,
                    "classification":"baseline unavailable"}));
                continue;
            }
            let median = if n.is_multiple_of(2) {
                (baseline[n / 2 - 1] + baseline[n / 2]) / 2.0
            } else {
                baseline[n / 2]
            };
            let low = baseline[0];
            let high = baseline[n - 1];
            let classification = if pr_ms < low {
                faster += 1;
                "beyond-spread"
            } else if pr_ms > high {
                slower += 1;
                "beyond-spread"
            } else {
                "noise"
            };
            comparison.push(json!({"jobKey":key,"name":name,"sampleCount":n,
                "medianMs":median,"spreadMs":[low,high],"prMs":pr_ms,
                "deltaMs":pr_ms-median,"classification":classification}));
        }
    }
    let verdict = if main_runs.len() < 7 {
        format!(
            "Incomplete main baseline ({}/7 runs); {faster} faster, {slower} slower beyond spread",
            main_runs.len()
        )
    } else {
        format!("{faster} faster, {slower} slower beyond main spread")
    };
    Ok((
        json!({"baselineCount":main_runs.len(),"tasks":comparison}),
        verdict,
    ))
}

fn document(
    conn: &Connection,
    repo: &str,
    change: Option<&str>,
    run: Option<&str>,
) -> rusqlite::Result<Value> {
    let mut jobs = listed(conn, repo, change, run)?;
    let mut task_stmt = conn.prepare(
        "select task, duration_ms from task_samples where digest=?1 order by duration_ms desc",
    )?;
    for job in &mut jobs {
        if job["status"] != "ingested" {
            continue;
        }
        let tasks = task_stmt.query_map([job["digest"].as_str().unwrap_or_default()], |row| {
            Ok(json!({"name":row.get::<_, String>(0)?,"durationMs":row.get::<_, f64>(1)?}))
        })?;
        job["topTasks"] = Value::Array(tasks.collect::<rusqlite::Result<Vec<_>>>()?);
    }
    let mut runs: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for job in jobs {
        runs.entry(job["runId"].as_str().unwrap_or_default().into())
            .or_default()
            .push(job);
    }
    let mut runs: Vec<_> = runs.into_iter().collect();
    runs.sort_by(|(a_id, a_jobs), (b_id, b_jobs)| {
        let latest = |jobs: &Vec<Value>| jobs.iter().filter_map(|j| j["uploadedAt"].as_i64()).max();
        latest(b_jobs)
            .cmp(&latest(a_jobs))
            .then_with(|| b_id.cmp(a_id))
    });
    let runs: Vec<Value> = runs
        .into_iter()
        .map(|(run_id, jobs)| {
            let trace = ids::run_trace(&run_id);
            let state = index::run_trace_state(conn, &trace)?.unwrap_or("pending");
            let status = if state == "incomplete" {
                "incomplete"
            } else if state == "ingested" && jobs.iter().all(|j| j["status"] == "ingested") {
                "ingested"
            } else {
                "pending"
            };
            Ok(
                json!({"runId":run_id,"attempt":jobs[0]["attempt"],"status":status,
                "trace":{"id":trace,"url":format!("/t/{trace}")},
                "buck2.vcs.merge.revision":jobs[0]["buck2.vcs.merge.revision"],"jobs":jobs}),
            )
        })
        .collect::<rusqlite::Result<_>>()?;
    let status = if runs.iter().any(|r| r["status"] == "incomplete") {
        "incomplete"
    } else if !runs.is_empty() && runs.iter().all(|r| r["status"] == "ingested") {
        "ingested"
    } else {
        "pending"
    };
    let (comparison, verdict) = compare(conn, repo, change, &runs)?;
    Ok(
        json!({"schema":"buck2-trace-access/v1","repository":repo,"changeId":change.unwrap_or(""),
        "status":status,"verdict":{"text": if runs.is_empty() {"Not yet uploaded"} else {&verdict},
            "criticalChainKind":"task-spans","criticalChain":[]},
        "runs":runs,"comparison":comparison}),
    )
}
const CSS: &str = r#":root{font:15px/1.5 system-ui,-apple-system,sans-serif;color-scheme:light dark;background:#fafafa;color:#171717}*{box-sizing:border-box}body{margin:0}main{max-width:1080px;margin:auto;padding:28px 24px 80px}.eyebrow{letter-spacing:.17em;font-size:11px;font-weight:700;color:#747474}h1{font-size:clamp(26px,4vw,42px);margin:6px 0 26px;overflow-wrap:anywhere}h2{font-size:17px;margin:32px 0 14px}h3{font-size:17px;margin:0 0 14px;overflow-wrap:anywhere}h4{margin:0;font-size:15px}small{font-size:12px;color:#777;margin-left:8px}p{margin:6px 0;color:#626262}.verdict{background:#171717;color:#fff;border-radius:12px;padding:20px 24px}.verdict strong{font-size:18px}.verdict p{color:#c8c8c8}section{border:1px solid #ddd;background:#fff;border-radius:12px;padding:20px;margin:12px 0}.jobs{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}article{border:1px solid #e5e5e5;border-radius:8px;padding:14px;min-width:0}.links{display:flex;flex-wrap:wrap;gap:7px;margin-top:12px}a{color:#175fc2;text-decoration:none}a:hover{text-decoration:underline}.links a{font-size:12px;border:1px solid #d7dce5;border-radius:6px;padding:5px 8px}aside{padding:10px 16px;border-left:3px solid #b4b4b4}.freeze{margin-top:28px}code{overflow-wrap:anywhere}@media(max-width:600px){main{padding:16px 14px 60px}section{padding:14px}.jobs{grid-template-columns:1fr}small{display:block;margin:0}}"#;
fn render(doc: &Value) -> String {
    let title = format!(
        "{}#{}",
        doc["repository"].as_str().unwrap_or_default(),
        doc["changeId"].as_str().unwrap_or_default()
    );
    let mut html = format!("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{}</title><style>{}</style></head><body><main><header><p class=\"eyebrow\">BUCK2 / BUILD EVIDENCE</p><h1>{}</h1><div class=\"verdict\"><strong>{}</strong><p>Slowest-job chain · task spans</p></div></header><h2>Runs</h2>",
        html_escape(&title), CSS, html_escape(&title),
        html_escape(doc["verdict"]["text"].as_str().unwrap_or_default()));
    let runs = doc["runs"].as_array();
    if runs.is_none_or(|runs| runs.is_empty()) {
        html.push_str(
            "<p>Not yet uploaded. The stable link becomes active when evidence arrives.</p>",
        );
    }
    for run in runs.into_iter().flatten() {
        let id = run["runId"].as_str().unwrap_or_default();
        html.push_str(&format!(
            "<section><h3><a href=\"/run/{}\">{}</a> <small>{}</small></h3><div class=\"jobs\">",
            encoded(id),
            html_escape(id),
            html_escape(run["status"].as_str().unwrap_or_default())
        ));
        for job in run["jobs"].as_array().into_iter().flatten() {
            html.push_str(&format!(
                "<article><h4>{}</h4><p>{}</p><div class=\"links\">",
                html_escape(job["key"].as_str().unwrap_or_default()),
                html_escape(job["status"].as_str().unwrap_or_default())
            ));
            for trace in job["traces"].as_array().into_iter().flatten() {
                let id = trace["id"].as_str().unwrap_or_default();
                html.push_str(&format!(
                    "<a href=\"/t/{}\">{} trace</a> <a href=\"/t/{}/perfetto\">Perfetto</a>",
                    encoded(id),
                    html_escape(trace["kind"].as_str().unwrap_or_default()),
                    encoded(id)
                ));
            }
            html.push_str("</div></article>");
        }
        html.push_str("</div></section>");
    }
    let count = doc["comparison"]["baselineCount"].as_u64().unwrap_or(0);
    html.push_str(&format!("<aside><h2>Baseline</h2><p>{count}/7 eligible main runs at or before the sealed base revision.</p>"));
    for task in doc["comparison"]["tasks"].as_array().into_iter().flatten() {
        let name = html_escape(task["name"].as_str().unwrap_or_default());
        let job = html_escape(task["jobKey"].as_str().unwrap_or_default());
        let classification = html_escape(task["classification"].as_str().unwrap_or_default());
        let n = task["sampleCount"].as_u64().unwrap_or(0);
        if let (Some(median), Some(low), Some(high), Some(delta)) = (
            task["medianMs"].as_f64(),
            task["spreadMs"][0].as_f64(),
            task["spreadMs"][1].as_f64(),
            task["deltaMs"].as_f64(),
        ) {
            html.push_str(&format!("<p>{job} · {name}: {classification}; {n} samples, median {median:.0} ms, spread {low:.0}–{high:.0} ms, Δ {delta:+.0} ms</p>"));
        } else {
            html.push_str(&format!(
                "<p>{job} · {name}: baseline unavailable (0 samples)</p>"
            ));
        }
    }
    html.push_str(&format!("</aside><p class=\"freeze\"><code>gh-ci-utils traces {} --freeze</code></p></main></body></html>", html_escape(doc["changeId"].as_str().unwrap_or_default())));
    html
}
async fn pr(
    State(st): State<AppState>,
    Path((owner, repo, number)): Path<(String, String, String)>,
) -> Response {
    if !valid_name(&owner) || !valid_name(&repo) {
        return error(StatusCode::BAD_REQUEST, "invalid repository");
    }
    let (number, json_format) = if let Some(v) = number.strip_suffix(".json") {
        (v, true)
    } else {
        (number.as_str(), false)
    };
    if number.parse::<u64>().ok().filter(|v| *v > 0).is_none() {
        return error(StatusCode::BAD_REQUEST, "invalid PR number");
    }
    let repo = format!("{owner}/{repo}");
    let file = st.cfg.index_path();
    let num = number.to_owned();
    match tokio::task::spawn_blocking(move || -> rusqlite::Result<_> {
        document(&index::open(&file)?, &repo, Some(&num), None)
    })
    .await
    {
        Ok(Ok(doc)) if json_format => Json(doc).into_response(),
        Ok(Ok(doc)) => (
            [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
            render(&doc),
        )
            .into_response(),
        _ => error(StatusCode::INTERNAL_SERVER_ERROR, "index unavailable"),
    }
}
async fn run(State(st): State<AppState>, Path(run): Path<String>) -> Response {
    let (id, json_format) = if let Some(v) = run.strip_suffix(".json") {
        (v, true)
    } else {
        (run.as_str(), false)
    };
    if id.len() > 512 || !id.starts_with("ci/") && !id.starts_with("local/") {
        return error(StatusCode::BAD_REQUEST, "invalid run key");
    }
    let file = st.cfg.index_path();
    let id = id.to_owned();
    match tokio::task::spawn_blocking(move || -> rusqlite::Result<Option<Value>> {
        let conn = index::open(&file)?;
        let repo: Option<String> = conn
            .query_row(
                "select repo from records where run_id=?1 limit 1",
                [&id],
                |r| r.get(0),
            )
            .optional()?;
        repo.map(|repo| document(&conn, &repo, None, Some(&id)))
            .transpose()
    })
    .await
    {
        Ok(Ok(Some(doc))) if json_format => Json(doc).into_response(),
        Ok(Ok(Some(doc))) => (
            [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
            render(&doc),
        )
            .into_response(),
        Ok(Ok(None)) => error(StatusCode::NOT_FOUND, "run unknown"),
        _ => error(StatusCode::INTERNAL_SERVER_ERROR, "index unavailable"),
    }
}
pub fn routes(state: AppState) -> Router {
    Router::new()
        .route("/pr/{owner}/{repo}/{number}", get(pr))
        .route("/run/{run}", get(run))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pr_runs_follow_latest_indexed_upload_not_lexical_run_id() {
        let conn = Connection::open_in_memory().unwrap();
        index::init(&conn).unwrap();
        for (id, uploaded) in [("ci/github/o/r/9/1", 9), ("ci/github/o/r/10/1", 10)] {
            conn.execute(
                "insert into records (digest,repo,run_id,attempt,job,manifest_json,bytes,status,uploaded_at)
                 values (?1,'o/r',?1,1,'build',?2,0,'ingested',?3)",
                rusqlite::params![id, r#"{"vcs.change.id":"42"}"#, uploaded],
            )
            .unwrap();
        }
        let doc = document(&conn, "o/r", Some("42"), None).unwrap();
        assert_eq!(doc["runs"][0]["runId"], "ci/github/o/r/10/1");
        assert_eq!(doc["runs"][1]["runId"], "ci/github/o/r/9/1");
        assert_eq!(doc["runs"][0]["status"], "pending");
        assert_eq!(doc["status"], "pending");
        let run = "ci/github/o/r/10/1";
        conn.execute(
            "insert into run_traces(run_id,repo,trace_id,verified_at) values (?1,'o/r',?2,20)",
            rusqlite::params![run, ids::run_trace(run)],
        )
        .unwrap();
        let verified = document(&conn, "o/r", Some("42"), None).unwrap();
        assert_eq!(verified["runs"][0]["status"], "ingested");
        assert_eq!(verified["status"], "pending");
        conn.execute("update run_traces set incomplete=1 where run_id=?1", [run])
            .unwrap();
        let incomplete = document(&conn, "o/r", Some("42"), None).unwrap();
        assert_eq!(incomplete["runs"][0]["status"], "incomplete");
        assert_eq!(incomplete["status"], "incomplete");
    }
    #[test]
    fn compares_seven_main_runs_no_later_revision_and_marks_spread_noise() {
        let conn = Connection::open_in_memory().unwrap();
        index::init(&conn).unwrap();
        for position in 1..=8 {
            let id = format!("main-{position}");
            conn.execute(
                "insert into records (digest,repo,run_id,attempt,job,manifest_json,bytes,status,uploaded_at)
                 values (?1,'o/r',?1,1,'build[os=linux]','{}',0,'ingested',?2)",
                rusqlite::params![id, position],
            )
            .unwrap();
            conn.execute(
                "insert into task_samples (digest,repo,run_id,job,task,duration_ms,revision,position,indexed_at)
                 values (?1,'o/r',?1,'build[os=linux]','compile',?2,?3,?4,?4)",
                rusqlite::params![id, if position == 8 { 1000.0 } else { 80.0 + 10.0 * f64::from(position) },
                    format!("rev-{position}"), position],
            )
            .unwrap();
        }
        conn.execute(
            "insert into records (digest,repo,run_id,attempt,job,manifest_json,bytes,status,uploaded_at)
             values ('rogue','o/r','rogue',1,'build[os=linux]','{}',0,'ingested',30)",
            [],
        )
        .unwrap();
        conn.execute(
            "insert into task_samples (digest,repo,run_id,job,task,duration_ms,revision,position,indexed_at)
             values ('rogue','o/r','rogue','build[os=linux]','compile',900,'other-branch-rev',6,30)",
            [],
        )
        .unwrap();
        conn.execute(
            "insert into records (digest,repo,run_id,attempt,job,manifest_json,bytes,status,uploaded_at)
             values ('pr','o/r','ci/github/o/r/10/1',1,'build[os=linux]',?1,0,'ingested',20)",
            [r#"{"vcs.change.id":"42","vcs.ref.base.revision":"rev-7","vcs.ref.base.position":7,"vcs.ref.base.first_parent_ancestors":["rev-7","rev-6","rev-5","rev-4","rev-3","rev-2","rev-1"]}"#],
        )
        .unwrap();
        conn.execute(
            "insert into task_samples (digest,repo,run_id,job,task,duration_ms,revision,position,indexed_at)
             values ('pr','o/r','ci/github/o/r/10/1','build[os=linux]','compile',80,'pr-rev',null,20)",
            [],
        )
        .unwrap();
        let doc = document(&conn, "o/r", Some("42"), None).unwrap();
        assert_eq!(doc["comparison"]["baselineCount"], 7);
        let task = &doc["comparison"]["tasks"][0];
        assert_eq!(task["sampleCount"], 7);
        assert_eq!(task["medianMs"], 120.0);
        assert_eq!(task["spreadMs"], json!([90.0, 150.0]));
        assert_eq!(task["deltaMs"], -40.0);
        assert_eq!(task["classification"], "beyond-spread");
        assert_eq!(doc["runs"][0]["jobs"][0]["topTasks"][0]["durationMs"], 80.0);
        let html = render(&doc);
        assert!(html.contains("7/7 eligible main runs"));
        assert!(html.contains("median 120 ms, spread 90–150 ms"));

        conn.execute(
            "update task_samples set duration_ms=120 where digest='pr'",
            [],
        )
        .unwrap();
        let within = document(&conn, "o/r", Some("42"), None).unwrap();
        assert_eq!(within["comparison"]["tasks"][0]["classification"], "noise");
        assert!(render(&within).contains("compile: noise"));
        conn.execute(
            "insert into task_samples (digest,repo,run_id,job,task,duration_ms,revision,position,indexed_at)
             values ('pr','o/r','ci/github/o/r/10/1','build[os=linux]','absent-on-main',23,'pr-rev',null,20)",
            [],
        )
        .unwrap();
        let unmatched = document(&conn, "o/r", Some("42"), None).unwrap();
        let absent = unmatched["comparison"]["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|task| task["name"] == "absent-on-main")
            .unwrap();
        assert_eq!(absent["sampleCount"], 0);
        assert_eq!(absent["classification"], "baseline unavailable");
        conn.execute(
            "update records set status='missing_spans' where digest='main-7'",
            [],
        )
        .unwrap();
        let lost = document(&conn, "o/r", Some("42"), None).unwrap();
        assert_eq!(lost["comparison"]["baselineCount"], 6);
        assert_eq!(lost["comparison"]["tasks"][0]["sampleCount"], 6);
        conn.execute(
            "update records set status='ingested' where digest='main-7'",
            [],
        )
        .unwrap();

        conn.execute(
            "update records set manifest_json=?1 where digest='pr'",
            [r#"{"vcs.change.id":"42","vcs.ref.base.revision":"not-indexed","vcs.ref.base.position":7,"vcs.ref.base.first_parent_ancestors":["not-indexed","rev-6","rev-5","rev-4","rev-3","rev-2","rev-1"]}"#],
        )
        .unwrap();
        let unknown = document(&conn, "o/r", Some("42"), None).unwrap();
        assert_eq!(unknown["comparison"]["baselineCount"], 6);
        conn.execute(
            "update records set manifest_json=?1 where digest='pr'",
            [r#"{"vcs.change.id":"42","vcs.ref.base.revision":"rev-7","vcs.ref.base.position":7}"#],
        )
        .unwrap();
        let no_ancestry = document(&conn, "o/r", Some("42"), None).unwrap();
        assert_eq!(no_ancestry["comparison"]["baselineCount"], 0);
    }
}
