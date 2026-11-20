//! Host-owned compact evidence, independent of OTLP acknowledgement and worktrees.
use super::{identity_attributes, sha256_hex, Model};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const RETENTION_SECONDS: u64 = 30 * 24 * 60 * 60;
const MAX_RECORD_BYTES: u64 = 64 * 1024 * 1024;

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
    })
}
