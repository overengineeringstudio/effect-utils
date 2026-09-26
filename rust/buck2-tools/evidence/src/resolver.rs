//! Read-only trace access: every link is derived from the durable index, not Tempo search.
use std::collections::BTreeMap;
use axum::{extract::{Path, State}, http::{header, StatusCode}, response::{IntoResponse, Response}, routing::get, Json, Router};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};
use crate::{http::AppState, ids, index};

fn valid_name(part: &str) -> bool {
    !part.is_empty() && part.len() <= 120 && part.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.')) && part != ".."
}
fn error(code: StatusCode, msg: &str) -> Response { (code, msg.to_owned()).into_response() }
fn html_escape(s: &str) -> String {
    s.chars().map(|c| match c {
        '&' => "&amp;".into(), '<' => "&lt;".into(), '>' => "&gt;".into(),
        '"' => "&quot;".into(), '\'' => "&#39;".into(), _ => c.to_string(),
    }).collect()
}
fn encoded(s: &str) -> String {
    s.bytes().map(|b| match b {
        b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
        _ => format!("%{b:02X}"),
    }).collect()
}
fn listed(conn: &Connection, repo: &str, change: Option<&str>, run: Option<&str>) -> rusqlite::Result<Vec<Value>> {
    let mut stmt = conn.prepare("select r.digest, r.run_id, r.attempt, r.job, r.status, r.manifest_json, r.ingested_at,
             coalesce((select json_group_array(json_object('kind', view, 'id', trace_id, 'url', '/t/' || trace_id)) from traces t where t.digest=r.digest),'[]'),
             r.started_at, r.uploaded_at
             from records r where repo=?1 and job<>'__close' order by uploaded_at desc")?;
    let rows = stmt.query_map([repo], |r| {
        let manifest: String = r.get(5)?;
        let traces: String = r.get(7)?;
        Ok((r.get::<_, String>(0)?,r.get::<_, String>(1)?,r.get::<_, u32>(2)?,r.get::<_, String>(3)?,
            r.get::<_, String>(4)?, manifest, r.get::<_, Option<i64>>(6)?, traces,r.get::<_, Option<i64>>(8)?,r.get::<_, i64>(9)?))
    })?;
    let mut result = Vec::new();
    for row in rows {
        let (digest, run_id, attempt, job, status, manifest, ingested_at, traces, started, uploaded) = row?;
        let Ok(m) = serde_json::from_str::<Value>(&manifest) else { continue; };
        if change.is_some_and(|id| m["vcs.change.id"] != id) || run.is_some_and(|id| id != run_id) { continue; }
        let trace = ids::run_trace(&run_id);
        result.push(json!({"digest": digest, "runId":run_id,"attempt":attempt,"key":job,"status":status,
            "ingestedAt":ingested_at,"vcs.ref.head.revision":m["vcs.ref.head.revision"],
            "vcs.ref.base.revision":m["vcs.ref.base.revision"],
            "buck2.vcs.merge.revision":m["buck2.vcs.merge.revision"],
            "trace":{"id":trace,"url":format!("/t/{trace}")},
            "traces":serde_json::from_str::<Value>(&traces).unwrap_or(json!([])),
            "topTasks":[], "durationMs":ingested_at.map(|end| end.saturating_sub(started.unwrap_or(uploaded)))}));
    }
    Ok(result)
}
fn document(conn: &Connection, repo: &str, change: Option<&str>, run: Option<&str>) -> rusqlite::Result<Value> {
    let jobs = listed(conn, repo, change, run)?;
    let mut runs: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for job in jobs { runs.entry(job["runId"].as_str().unwrap_or_default().into()).or_default().push(job); }
    let runs: Vec<Value> = runs.into_iter().rev().map(|(run_id, jobs)| {
        let status = if jobs.iter().all(|j| j["status"] == "ingested") {"ingested"} else {"pending"};
        let trace = ids::run_trace(&run_id);
        json!({"runId":run_id,"attempt":jobs[0]["attempt"],"status":status,
            "trace":{"id":trace,"url":format!("/t/{trace}")},
            "buck2.vcs.merge.revision":jobs[0]["buck2.vcs.merge.revision"],"jobs":jobs})
    }).collect();
    let status = if runs.is_empty() {"pending"} else if runs.iter().all(|r|r["status"] == "ingested") {"ingested"} else {"pending"};
    Ok(json!({"schema":"buck2-trace-access/v1","repository":repo,"changeId":change.unwrap_or(""),
        "status":status,"verdict":{"text": if runs.is_empty() {"Not yet uploaded"} else {"Evidence indexed; baseline unavailable"},
            "criticalChainKind":"task-spans","criticalChain":[]},
        "runs":runs,"comparison":{"baselineCount":0,"tasks":[]}}))
}
const CSS: &str = r#":root{font:15px/1.5 system-ui,-apple-system,sans-serif;color-scheme:light dark;background:#fafafa;color:#171717}*{box-sizing:border-box}body{margin:0}main{max-width:1080px;margin:auto;padding:28px 24px 80px}.eyebrow{letter-spacing:.17em;font-size:11px;font-weight:700;color:#747474}h1{font-size:clamp(26px,4vw,42px);margin:6px 0 26px;overflow-wrap:anywhere}h2{font-size:17px;margin:32px 0 14px}h3{font-size:17px;margin:0 0 14px;overflow-wrap:anywhere}h4{margin:0;font-size:15px}small{font-size:12px;color:#777;margin-left:8px}p{margin:6px 0;color:#626262}.verdict{background:#171717;color:#fff;border-radius:12px;padding:20px 24px}.verdict strong{font-size:18px}.verdict p{color:#c8c8c8}section{border:1px solid #ddd;background:#fff;border-radius:12px;padding:20px;margin:12px 0}.jobs{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}article{border:1px solid #e5e5e5;border-radius:8px;padding:14px;min-width:0}.links{display:flex;flex-wrap:wrap;gap:7px;margin-top:12px}a{color:#175fc2;text-decoration:none}a:hover{text-decoration:underline}.links a{font-size:12px;border:1px solid #d7dce5;border-radius:6px;padding:5px 8px}aside{padding:10px 16px;border-left:3px solid #b4b4b4}.freeze{margin-top:28px}code{overflow-wrap:anywhere}@media(max-width:600px){main{padding:16px 14px 60px}section{padding:14px}.jobs{grid-template-columns:1fr}small{display:block;margin:0}}"#;
fn render(doc: &Value) -> String {
    let title = format!("{}#{}", doc["repository"].as_str().unwrap_or_default(), doc["changeId"].as_str().unwrap_or_default());
    let mut html = format!("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{}</title><style>{}</style></head><body><main><header><p class=\"eyebrow\">BUCK2 / BUILD EVIDENCE</p><h1>{}</h1><div class=\"verdict\"><strong>{}</strong><p>Slowest-job chain · task spans</p></div></header><h2>Runs</h2>",
        html_escape(&title), CSS, html_escape(&title),
        html_escape(doc["verdict"]["text"].as_str().unwrap_or_default()));
    let runs = doc["runs"].as_array();
    if runs.is_none_or(|runs| runs.is_empty()) { html.push_str("<p>Not yet uploaded. The stable link becomes active when evidence arrives.</p>"); }
    for run in runs.into_iter().flatten() {
        let id = run["runId"].as_str().unwrap_or_default();
        html.push_str(&format!("<section><h3><a href=\"/run/{}\">{}</a> <small>{}</small></h3><div class=\"jobs\">", encoded(id), html_escape(id), html_escape(run["status"].as_str().unwrap_or_default())));
        for job in run["jobs"].as_array().into_iter().flatten() {
            html.push_str(&format!("<article><h4>{}</h4><p>{}</p><div class=\"links\">", html_escape(job["key"].as_str().unwrap_or_default()), html_escape(job["status"].as_str().unwrap_or_default())));
            for trace in job["traces"].as_array().into_iter().flatten() {
                let id = trace["id"].as_str().unwrap_or_default();
                html.push_str(&format!("<a href=\"/t/{}\">{} trace</a> <a href=\"/t/{}/perfetto\">Perfetto</a>", encoded(id), html_escape(trace["kind"].as_str().unwrap_or_default()), encoded(id)));
            }
            html.push_str("</div></article>");
        }
        html.push_str("</div></section>");
    }
    html.push_str(&format!("<aside><h2>Baseline</h2><p>At most 7 eligible main runs at or before the sealed base revision. Baseline unavailable until ancestry samples exist.</p></aside><p class=\"freeze\"><code>gh-ci-utils traces {} --freeze</code></p></main></body></html>", html_escape(doc["changeId"].as_str().unwrap_or_default())));
    html
}
async fn pr(State(st): State<AppState>, Path((owner, repo, number)): Path<(String,String,String)>) -> Response {
    if !valid_name(&owner) || !valid_name(&repo) { return error(StatusCode::BAD_REQUEST, "invalid repository"); }
    let (number, json_format) = if let Some(v) = number.strip_suffix(".json") {(v,true)} else {(number.as_str(),false)};
    if number.parse::<u64>().ok().filter(|v| *v>0).is_none() { return error(StatusCode::BAD_REQUEST,"invalid PR number"); }
    let repo = format!("{owner}/{repo}");
    let file = st.cfg.index_path();
    let num = number.to_owned();
    match tokio::task::spawn_blocking(move || -> rusqlite::Result<_> { document(&index::open(&file)?, &repo, Some(&num), None) }).await {
        Ok(Ok(doc)) if json_format => Json(doc).into_response(),
        Ok(Ok(doc)) => ([(header::CONTENT_TYPE, "text/html; charset=utf-8")],render(&doc)).into_response(),
        _ => error(StatusCode::INTERNAL_SERVER_ERROR, "index unavailable"),
    }
}
async fn run(State(st): State<AppState>, Path(run): Path<String>) -> Response {
    let (id, json_format) = if let Some(v) = run.strip_suffix(".json") {(v,true)} else {(run.as_str(),false)};
    if id.len()>512 || !id.starts_with("ci/") && !id.starts_with("local/") { return error(StatusCode::BAD_REQUEST, "invalid run key"); }
    let file = st.cfg.index_path();
    let id = id.to_owned();
    match tokio::task::spawn_blocking(move || -> rusqlite::Result<Option<Value>> {
        let conn = index::open(&file)?;
        let repo: Option<String> = conn.query_row("select repo from records where run_id=?1 limit 1", [&id], |r|r.get(0)).optional()?;
        repo.map(|repo| document(&conn,&repo,None,Some(&id))).transpose()
    }).await {
        Ok(Ok(Some(doc))) if json_format => Json(doc).into_response(),
        Ok(Ok(Some(doc))) => ([(header::CONTENT_TYPE,"text/html; charset=utf-8")],render(&doc)).into_response(),
        Ok(Ok(None)) => error(StatusCode::NOT_FOUND,"run unknown"),
        _ => error(StatusCode::INTERNAL_SERVER_ERROR,"index unavailable"),
    }
}
pub fn routes(state: AppState) -> Router {
    Router::new().route("/pr/{owner}/{repo}/{number}",get(pr)).route("/run/{run}",get(run)).with_state(state)
}
