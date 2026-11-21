//! Host-owned compact evidence, independent of OTLP acknowledgement and worktrees.
use super::{attr, identity_attributes, sha256_hex, spool_chunk, Model};
use clap::{Args, ValueEnum};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, BufRead, BufReader, Read, Seek, Write},
    path::{Path, PathBuf},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

const RETENTION_SECONDS: u64 = 30 * 24 * 60 * 60;
const MAX_RECORD_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Copy, ValueEnum)]
pub(super) enum Phase {
    Open,
    Terminal,
}
#[derive(Args)]
pub(super) struct Census {
    #[arg(long)]
    invocation_id: String,
    #[arg(long, value_enum)]
    phase: Phase,
    #[arg(long)]
    host: String,
    #[arg(long)]
    build_id: Option<String>,
    #[arg(long)]
    exit_code: Option<i32>,
    /// A preceding census write failed; completeness must remain unknown.
    #[arg(long)]
    capture_error: bool,
    #[arg(long)]
    records_dir: Option<PathBuf>,
}

pub(super) fn directory(explicit: Option<PathBuf>) -> io::Result<PathBuf> {
    if let Some(path) = explicit {
        return Ok(path);
    }
    let state = std::env::var_os("XDG_STATE_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/state")))
        .ok_or_else(|| io::Error::other("HOME or XDG_STATE_HOME required for retained evidence"))?;
    Ok(state.join("buck2-events/occurrence-records/v1"))
}
fn now_ns() -> io::Result<u128> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| time.as_nanos())
        .map_err(io::Error::other)
}

fn durable_directory(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let marker = dir.join(".directory-synced");
    if marker.try_exists()? {
        return Ok(());
    }
    // A visible marker can only follow every ancestor barrier, including when
    // another process creates the hierarchy concurrently. A lost marker merely
    // repeats these first-use barriers; ordinary captures only sync the leaf.
    let canonical = fs::canonicalize(dir)?;
    for ancestor in canonical.ancestors() {
        File::open(ancestor)?.sync_all()?;
    }
    match OpenOptions::new().write(true).create_new(true).open(marker) {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error),
    }
}

// Hard-link publication is create-if-absent: simultaneous retries never replace
// an existing invocation record or refresh its retention clock.
fn publish(
    dir: &Path,
    key: &str,
    write: impl FnOnce(&mut File) -> io::Result<()>,
) -> io::Result<()> {
    durable_directory(dir)?;
    let temporary = dir.join(format!(".{}.{}.tmp", std::process::id(), now_ns()?));
    let content_addressed = key.starts_with("build:");
    let mut target = dir.join(format!("{}.jsonl", sha256_hex(key.as_bytes())));
    if !content_addressed && target.exists() {
        return Ok(());
    }
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        write(&mut file)?;
        if file.metadata()?.len() > MAX_RECORD_BYTES {
            return Err(io::Error::other(
                "compact evidence overflow: 64 MiB; native input must be retained",
            ));
        }
        file.sync_all()?;
        if content_addressed {
            let mut digest = Sha256::new();
            let mut source = File::open(&temporary)?;
            let mut buffer = [0u8; 65536];
            loop {
                let size = source.read(&mut buffer)?;
                if size == 0 {
                    break;
                }
                digest.update(&buffer[..size]);
            }
            use std::fmt::Write as _;
            let mut content_digest = String::with_capacity(64);
            for byte in digest.finalize() {
                write!(&mut content_digest, "{byte:02x}").expect("writing to String cannot fail");
            }
            target = dir.join(format!(
                "{}-{content_digest}.jsonl",
                sha256_hex(key.as_bytes())
            ));
        }
        match fs::hard_link(&temporary, &target) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        File::open(dir)?.sync_all()
    })();
    let _ = fs::remove_file(temporary);
    result
}
fn line(file: &mut File, value: &Value) -> io::Result<()> {
    serde_json::to_writer(&mut *file, value)?;
    file.write_all(b"\n")
}
fn manifest(dir: &Path, host: &str) -> io::Result<()> {
    publish(dir, &format!("manifest:{host}"), |file| {
        line(
            file,
            &json!({
                "type":"manifest", "host":host, "enrolled_at_ns":now_ns()?.to_string(),
                "retention_seconds":RETENTION_SECONDS, "scope":"supported-entrypoints",
                "coverage":"unknown-until-reconciled"
            }),
        )
    })
}
fn prune(dir: &Path) -> io::Result<()> {
    let now = SystemTime::now();
    // Amortize the host-wide retention scan across all wrappers and worktrees.
    let day = now
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_secs()
        / 86400;
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dir.join(format!(".prune-{day}")))
    {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => return Ok(()),
        Err(error) => return Err(error),
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if entry
            .path()
            .extension()
            .is_none_or(|extension| extension != "jsonl")
        {
            continue;
        }
        // Manifests establish enrollment, not evidence completeness, and survive
        // empty windows. Other immutable records age from first durable capture.
        let mut reader = std::io::BufReader::new(File::open(entry.path())?);
        let mut first = String::new();
        std::io::BufRead::read_line(&mut reader, &mut first)?;
        if serde_json::from_str::<Value>(&first)?["type"] == "manifest" {
            continue;
        }
        if now
            .duration_since(entry.metadata()?.modified()?)
            .is_ok_and(|age| age.as_secs() > RETENTION_SECONDS)
        {
            fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}
pub(super) fn census(args: Census) -> io::Result<()> {
    if args.invocation_id.is_empty()
        || args.host.is_empty()
        || args.invocation_id.len() > 1024
        || args.host.len() > 1024
    {
        return Err(io::Error::other(
            "census requires invocation and observed host of 1..1024 bytes",
        ));
    }
    let dir = directory(args.records_dir)?;
    manifest(&dir, &args.host)?;
    let phase = match args.phase {
        Phase::Open => "open",
        Phase::Terminal => "terminal",
    };
    let pipeline_run = std::env::var("PIPELINE_RUN_ID")
        .ok()
        .filter(|value| !value.is_empty());
    let lane = pipeline_run
        .as_deref()
        .filter(|id| id.starts_with("ci/"))
        .map_or(Some("supported-entrypoint/local"), |_| None);
    publish(
        &dir,
        &format!("census:{}:{phase}", args.invocation_id),
        |file| {
            line(
                file,
                &json!({
                    "type":"invocation", "phase":phase, "invocation_id":args.invocation_id,
                    "host":args.host, "timestamp_ns":now_ns()?.to_string(),
                    "build_id":args.build_id.filter(|id| !id.is_empty()), "exit_code":args.exit_code,
                    "capture_error":args.capture_error, "lane":lane,
                    "run_id":pipeline_run.as_deref().unwrap_or(&args.invocation_id)
                }),
            )
        },
    )?;
    prune(&dir)
}
fn allowed(attribute: &Value, resource: bool) -> bool {
    let key = attribute["key"].as_str().unwrap_or("");
    if resource {
        matches!(
            key,
            "host.name"
                | "host.arch"
                | "os.type"
                | "buck2.root_id"
                | "cicd.pipeline.run.id"
                | "vcs.provider.name"
                | "vcs.change.id"
                | "vcs.ref.head.revision"
                | "vcs.ref.base.revision"
                | "buck2.vcs.merge.revision"
                | "buck2.vcs.change.is_fork"
        )
    } else {
        matches!(
            key,
            "buck2.occurrence_id"
                | "buck2.action_digest"
                | "buck2.category"
                | "buck2.target"
                | "buck2.configuration"
                | "buck2.execution_kind"
                | "buck2.execution_outcome"
                | "buck2.failed"
                | "buck2.unclosed"
                | "buck2.total_bytes"
                | "buck2.duration_ns"
                | "buck2.execution_ns"
                | "buck2.queue_ns"
                | "buck2.action_host"
        )
    }
}
pub(super) fn capture(model: &Model, dir: &Path) -> io::Result<()> {
    if model.uuid.is_empty() {
        return Err(io::Error::other(
            "cannot retain evidence without native build ID",
        ));
    }
    let identity = identity_attributes(|key| std::env::var(key).ok());
    let resource: Vec<_> = model
        .resource_attrs
        .iter()
        .chain(identity.iter())
        .filter(|attr| allowed(attr, true))
        .collect();
    if let Some(host) = resource
        .iter()
        .find(|attr| attr["key"] == "host.name")
        .and_then(|attr| attr["value"]["stringValue"].as_str())
    {
        manifest(dir, host)?;
    }
    let root_id = model
        .resource_attrs
        .iter()
        .chain(
            model
                .spans
                .iter()
                .filter(|span| span.name.starts_with("buck2.command "))
                .flat_map(|span| &span.attrs),
        )
        .find(|attr| attr["key"] == "buck2.root_id")
        .and_then(|attr| attr["value"]["stringValue"].as_str());
    publish(dir, &format!("build:{}", model.uuid), |file| {
        line(
            file,
            &json!({"type":"conversion", "build_id":model.uuid,
            "resource_attributes":resource, "root_id":root_id, "truncated":model.truncated,
            "stop_reason":model.stop_reason, "unknown_fields":model.unknown_fields,
            "action_count":model.spans.iter().filter(|span| span.action).count()}),
        )?;
        for span in model.spans.iter().filter(|span| span.action) {
            line(
                file,
                &json!({"type":"occurrence", "build_id":model.uuid,
                "span_id":span.id.to_string(), "start_ns":span.start.to_string(),
                "end_ns":span.end.to_string(), "ended":span.ended,
                "attributes":span.attrs.iter().filter(|attr| allowed(attr, false)).collect::<Vec<_>>()}),
            )?;
            if file.metadata()?.len() > MAX_RECORD_BYTES {
                return Err(io::Error::other(
                    "compact evidence overflow: native input must be retained",
                ));
            }
        }
        Ok(())
    })?;
    prune(dir)
}

const MAX_LOG_BODY: usize = 8 * 1024;
const MAX_REPLAY_BYTES: u64 = 512 * 1024 * 1024;

// The retained bytes, not the transport ACK, are the replay authority.
fn queue_snapshot(
    path: &Path,
    spool: &Path,
    queued: &mut u64,
    deadline: Option<Instant>,
) -> io::Result<()> {
    let mut file = File::open(path)?;
    if file.metadata()?.len() > MAX_RECORD_BYTES {
        return Err(io::Error::other("coverage UNKNOWN: snapshot >64 MiB"));
    }
    let mut digest = Sha256::new();
    let mut record_count = 0usize;
    let mut last = 0;
    let mut source_bytes = 0;
    let mut buffer = [0u8; 65536];
    loop {
        let size = file.read(&mut buffer)?;
        if size == 0 {
            break;
        }
        source_bytes += size;
        if source_bytes as u64 > MAX_RECORD_BYTES
            || deadline.is_some_and(|end| Instant::now() >= end)
        {
            return Err(io::Error::other(
                "coverage UNKNOWN: snapshot byte/time limit",
            ));
        }
        digest.update(&buffer[..size]);
        record_count += buffer[..size].iter().filter(|byte| **byte == b'\n').count();
        last = buffer[size - 1];
    }
    if last != b'\n' {
        return Err(io::Error::other("coverage UNKNOWN: missing final LF"));
    }
    use std::fmt::Write as _;
    let mut snapshot = String::with_capacity(64);
    for byte in digest.finalize() {
        write!(&mut snapshot, "{byte:02x}").expect("writing to String cannot fail");
    }
    file.rewind()?;
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    let mut resource = Value::Null;
    let mut logs = Vec::new();
    let emission = now_ns()?.to_string();
    for ordinal in 0..record_count {
        if deadline.is_some_and(|end| Instant::now() >= end) {
            return Err(io::Error::other("coverage UNKNOWN: replay time limit"));
        }
        line.clear();
        (&mut reader)
            .take((MAX_LOG_BODY + 1) as u64)
            .read_until(b'\n', &mut line)?;
        if line.pop() != Some(b'\n') {
            return Err(io::Error::other("coverage UNKNOWN: oversized log line"));
        }
        let text = std::str::from_utf8(&line).map_err(io::Error::other)?;
        if ordinal == 0 {
            let header: Value = serde_json::from_str(text)?;
            let host = header["host"]
                .as_str()
                .or_else(|| {
                    header["resource_attributes"]
                        .as_array()?
                        .iter()
                        .find(|attr| attr["key"] == "host.name")?["value"]["stringValue"]
                        .as_str()
                })
                .filter(|host| !host.is_empty())
                .ok_or_else(|| io::Error::other("coverage UNKNOWN: missing observed host"))?;
            resource = json!({"attributes":[attr("service.name", "buck2-events"), attr("host.name", host)]});
            if serde_json::to_vec(&resource)?.len() > 4096 {
                return Err(io::Error::other("coverage UNKNOWN: resource >4 KiB"));
            }
        }
        let body = serde_json::to_string(&json!({
            "type":"buck2.occurrence.ledger", "version":1, "snapshotSha256":snapshot,
            "ordinal":ordinal, "recordCount":record_count, "line":text
        }))?;
        if body.len() > MAX_LOG_BODY {
            return Err(io::Error::other("coverage UNKNOWN: log body >8 KiB"));
        }
        let log =
            serde_json::to_vec(&json!({"timeUnixNano":emission, "body":{"stringValue":body}}))?;
        if log.len() > 12 * 1024 {
            return Err(io::Error::other("coverage UNKNOWN: OTLP record >12 KiB"));
        }
        if logs.len() + log.len() > super::MAX_OTLP_BODY - 8192 {
            queue_logs(spool, &resource, &mut logs, queued)?;
        }
        if !logs.is_empty() {
            logs.push(b',');
        }
        logs.extend_from_slice(&log);
    }
    queue_logs(spool, &resource, &mut logs, queued)
}

fn queue_logs(
    spool: &Path,
    resource: &Value,
    logs: &mut Vec<u8>,
    queued: &mut u64,
) -> io::Result<()> {
    if logs.is_empty() {
        return Ok(());
    }
    let mut body = Vec::with_capacity(logs.len() + 8192);
    body.extend_from_slice(b"{\"resourceLogs\":[{\"resource\":");
    serde_json::to_writer(&mut body, resource)?;
    body.extend_from_slice(b",\"scopeLogs\":[{\"scope\":{\"name\":\"buck2-events.occurrence-ledger\"},\"logRecords\":[");
    body.extend_from_slice(logs);
    body.extend_from_slice(b"]}]}]}");
    if *queued + body.len() as u64 > MAX_REPLAY_BYTES {
        return Err(io::Error::other("coverage UNKNOWN: queued >512 MiB"));
    }
    spool_chunk(spool, "logs", &body)?;
    *queued += body.len() as u64;
    logs.clear();
    Ok(())
}

pub(super) fn replay(dir: &Path, spool: &Path, deadline: Instant) -> io::Result<()> {
    let mut files = Vec::new();
    let mut bytes = 0u64;
    for (seen, entry) in fs::read_dir(dir)?.enumerate() {
        if seen >= 100_000 || Instant::now() >= deadline {
            return Err(io::Error::other(format!("coverage UNKNOWN: replay entry/time limit; files={} source_bytes={bytes} queued_bytes=0", files.len())));
        }
        let entry = entry?;
        if entry.path().extension().is_none_or(|ext| ext != "jsonl") {
            continue;
        }
        bytes = bytes.saturating_add(entry.metadata()?.len());
        if !entry.file_type()?.is_file() || files.len() >= 100_000 || bytes > MAX_REPLAY_BYTES {
            return Err(io::Error::other(format!("coverage UNKNOWN: replay file/count/512 MiB limit; files={} source_bytes={bytes} queued_bytes=0", files.len())));
        }
        files.push(entry.path());
    }
    files.sort();
    let mut queued = 0;
    let result = files
        .iter()
        .try_for_each(|path| queue_snapshot(path, spool, &mut queued, Some(deadline)));
    eprintln!("buck2-events: retained replay files={} source_bytes={bytes} queued_bytes={queued} complete={}; sources retained", files.len(), result.is_ok());
    result
}
